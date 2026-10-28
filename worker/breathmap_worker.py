"""Outbound-only Supabase worker for the existing BreathMap analysis engine.

No web listener, Softr credential, model change or automatic paid-call retry.
The service-role credential is read from the process environment only.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
import uuid


MAX_INPUT_BYTES = 50 * 1024 * 1024
MAX_JSON_BYTES = 80 * 1024 * 1024
OPERATIONS = frozenset(("analyse", "report", "chat", "waveform"))
_HASH = re.compile(r"[0-9a-f]{64}\Z")
DEFAULT_BACKEND_PROJECT = Path(__file__).resolve().parents[2] / "BreathMap_local_20261027"


class WorkerError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def identifier(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError):
        raise WorkerError("invalid_identifier") from None
    return value


def digest(value):
    if not isinstance(value, str) or not _HASH.fullmatch(value):
        raise WorkerError("input_hash_required")
    return value


def language(payload):
    value = payload.get("language", "en")
    if value not in {"en", "zh"}:
        raise WorkerError("invalid_language")
    return value


def stamp_report_source(report, saved_source):
    """Use only provenance validated against the actual saved report bytes."""
    source = saved_source or {"mode": "unknown", "provider_model": None, "report_sha256": None}
    mode = source.get("mode")
    if mode not in {"live", "simulated", "unknown"}:
        raise WorkerError("report_source_invalid")
    return {**report, "source": mode, "provider_model": source.get("provider_model"),
            "source_report_sha256": source.get("report_sha256"),
            "simulated": None if mode == "unknown" else mode == "simulated"}


def detach_worker_credentials():
    """Keep credentials in the transport, out of numeric child environments."""
    for name in ("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"):
        os.environ.pop(name, None)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise WorkerError("redirect_refused")


class SupabaseCloud:
    """Small service-side REST client. It never returns raw server errors."""
    def __init__(self, url, key, *, opener=None):
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.hostname or
                not re.fullmatch(r"[a-z0-9]+\.supabase\.co", parsed.hostname) or
                parsed.port not in {None, 443} or parsed.path not in {"", "/"} or
                parsed.query or parsed.fragment or parsed.username or parsed.password):
            raise WorkerError("invalid_supabase_url")
        if not isinstance(key, str) or not 20 <= len(key) <= 8192 or any(ord(c) < 33 or ord(c) > 126 for c in key):
            raise WorkerError("service_credential_unavailable")
        if key.startswith("sb_secret_"):
            self.credential_kind = "secret"
        elif key.startswith("eyJ"):
            # This is a diagnostic shape/role check only. Supabase, not this
            # unsigned decoding step, authenticates the legacy JWT signature.
            try:
                parts = key.split(".")
                if len(parts) != 3:
                    raise ValueError()
                claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
                if not isinstance(claims, dict) or claims.get("role") != "service_role":
                    raise ValueError()
            except (ValueError, UnicodeError, TypeError):
                raise WorkerError("worker_requires_secret_or_service_role_key") from None
            self.credential_kind = "legacy_service_role"
        else:
            raise WorkerError("worker_requires_secret_or_service_role_key")
        self.url, self._key = url.rstrip("/"), key
        self.opener = opener or build_opener(NoRedirect())

    @classmethod
    def from_environment(cls):
        return cls(os.environ.get("SUPABASE_URL", ""),
                   os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""))

    def request(self, method, path, data=None, *, maximum=MAX_JSON_BYTES,
                binary=False, headers=None, raw=False):
        if not path.startswith("/") or path.startswith("//") or "\r" in path or "\n" in path:
            raise WorkerError("invalid_cloud_path")
        body = data if raw else canonical(data) if data is not None else None
        request_headers = {"apikey": self._key,
                           "Accept": "application/json", "Accept-Encoding": "identity",
                           "User-Agent": "BreathMap-Supabase-Worker/1"}
        if self.credential_kind == "legacy_service_role":
            request_headers["Authorization"] = "Bearer " + self._key
        if body is not None:
            request_headers["Content-Type"] = "application/octet-stream" if raw else "application/json"
        if any(key.lower() in {"authorization", "apikey", "host"} for key in (headers or {})):
            raise WorkerError("credential_header_override_refused")
        request_headers.update(headers or {})
        req = Request(self.url + path, data=body, headers=request_headers, method=method)
        try:
            with self.opener.open(req, timeout=45) as response:
                length = response.headers.get("Content-Length")
                if length and (not length.isdigit() or int(length) > maximum):
                    raise WorkerError("cloud_response_too_large")
                result = response.read(maximum + 1)
                if len(result) > maximum:
                    raise WorkerError("cloud_response_too_large")
                if binary:
                    return result
                return json.loads(result) if result else None
        except HTTPError as error:
            raise WorkerError("cloud_http_" + str(error.code)) from None
        except (URLError, OSError, TimeoutError):
            raise WorkerError("cloud_network_unavailable") from None
        except (UnicodeError, ValueError):
            raise WorkerError("cloud_invalid_response") from None

    def rpc(self, name, payload):
        if not re.fullmatch(r"[a-z_]+", name):
            raise WorkerError("invalid_rpc")
        return self.request("POST", "/rest/v1/rpc/" + name, payload)

    def claim(self, worker_id):
        result = self.rpc("claim_analysis_job", {"p_worker_id": worker_id})
        if isinstance(result, list):
            if len(result) > 1:
                raise WorkerError("cloud_claim_contract")
            return result[0] if result else None
        if result is None or isinstance(result, dict):
            return result
        raise WorkerError("cloud_claim_contract")

    def fence(self, job_id, worker_id):
        rows = self.rpc("fence_worker_job", {"p_job_id": identifier(job_id), "p_worker_id": worker_id})
        if not isinstance(rows, list) or len(rows) > 1:
            raise WorkerError("cloud_fence_contract")
        return rows[0] if rows else None

    def running_jobs(self, worker_id):
        rows = []
        cursor = None
        for unused_page in range(100):
            query = {"worker_id": "eq." + worker_id, "status": "eq.running", "select": "id", "order": "id", "limit": 100}
            if cursor:
                query["id"] = "gt." + cursor
            page = self.request("GET", "/rest/v1/analysis_jobs?" + urlencode(query))
            if not isinstance(page, list) or len(page) > 100:
                raise WorkerError("cloud_recovery_contract")
            ids = [identifier(row.get("id")) for row in page if isinstance(row, dict)]
            if len(ids) != len(page) or ids != sorted(set(ids)) or cursor and ids and ids[0] <= cursor:
                raise WorkerError("cloud_recovery_contract")
            rows.extend(page)
            if len(page) < 100:
                return rows
            cursor = ids[-1]
        raise WorkerError("cloud_recovery_limit")

    def heartbeat(self, *, busy=False):
        self.request("POST", "/rest/v1/worker_heartbeat?on_conflict=id",
                     {"id": "main", "last_seen": utcnow(), "status": "busy" if busy else "online"},
                     headers={"Prefer": "resolution=merge-duplicates,return=minimal"})

    def get_recording(self, record_id):
        query = urlencode({"id": "eq." + identifier(record_id),
                           "select": "id,user_id,file_path,file_name,file_size,input_sha256,trashed_at,deletion_started_at"})
        rows = self.request("GET", "/rest/v1/recordings?" + query)
        return rows[0] if isinstance(rows, list) and len(rows) == 1 else None

    def get_job(self, job_id):
        rows = self.request("GET", "/rest/v1/analysis_jobs?" + urlencode({"id": "eq." + identifier(job_id), "select": "*"}))
        return rows[0] if isinstance(rows, list) and len(rows) == 1 else None

    def download(self, path):
        return self.request("GET", "/storage/v1/object/authenticated/recordings/" + quote(path, safe="/"),
                            maximum=MAX_INPUT_BYTES, binary=True)

    def artifact(self, path, value):
        data = canonical(value)
        if len(data) > MAX_JSON_BYTES:
            raise WorkerError("artifact_too_large")
        self.request("POST", "/storage/v1/object/analysis-artifacts/" + quote(path, safe="/"),
                     data, raw=True, headers={"Content-Type": "application/json", "x-upsert": "true"})

    def delete_artifact(self, path):
        self.request("DELETE", "/storage/v1/object/analysis-artifacts", {"prefixes": [path]})

    def read_artifact(self, path):
        return self.request("GET", "/storage/v1/object/authenticated/analysis-artifacts/" + quote(path, safe="/"),
                            maximum=MAX_JSON_BYTES, binary=True)

    def finish(self, job, result, *, analysis_result=None, error_code=None):
        return self.rpc("finish_analysis_job", {
            "p_job_id": job["id"], "p_lease_token": job["lease_token"],
            "p_result": result, "p_analysis_result": analysis_result, "p_error_code": error_code})


class Ledger:
    """A separate ledger; never opens or rewrites the old Softr bridge.sqlite."""
    def __init__(self, path, guard=lambda path: path):
        self.path, self.guard = Path(path), guard
        guard(self.path.parent).mkdir(parents=True, exist_ok=True)
        for name in (self.path, Path(str(self.path) + "-wal"), Path(str(self.path) + "-shm")):
            guard(name)
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS bindings (cloud_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,input_sha256 TEXT NOT NULL,local_id TEXT NOT NULL,result_sha256 TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY,operation TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,analysis_json TEXT,error_code TEXT,updated_at TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS attempts (job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,cloud_id TEXT NOT NULL,owner_id TEXT NOT NULL,input_sha256 TEXT NOT NULL,local_id TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS artifact_writes (job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,path TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(job_id,path))")
        if "content_sha256" not in {row["name"] for row in self.db.execute("PRAGMA table_info(artifact_writes)")}:
            self.db.execute("ALTER TABLE artifact_writes ADD COLUMN content_sha256 TEXT")
        self.db.execute("INSERT OR IGNORE INTO settings VALUES ('worker_id',?)", (str(uuid.uuid4()),))
        self.db.commit()
        self.worker_id = self.db.execute("SELECT value FROM settings WHERE key='worker_id'").fetchone()[0]

    def binding(self, cloud_id):
        row = self.db.execute("SELECT * FROM bindings WHERE cloud_id=?", (cloud_id,)).fetchone()
        return dict(row) if row else None

    def bind(self, record, local_id, result_hash=None):
        existing = self.binding(record["id"])
        if existing and (existing["owner_id"], existing["input_sha256"], existing["local_id"]) != (
                record["user_id"], record["input_sha256"], local_id):
            raise WorkerError("immutable_binding_changed")
        self.db.execute("INSERT INTO bindings VALUES (?,?,?,?,?) ON CONFLICT(cloud_id) DO UPDATE SET result_sha256=excluded.result_sha256",
                        (record["id"], record["user_id"], record["input_sha256"], local_id, result_hash))
        self.db.commit()

    def job(self, job_id):
        row = self.db.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        return dict(row) if row else None

    def attempt(self, job_id):
        row = self.db.execute("SELECT * FROM attempts WHERE job_id=?", (job_id,)).fetchone()
        return dict(row) if row else None

    def save_attempt(self, job, record, local_id):
        expected = (record["id"], record["user_id"], record["input_sha256"], local_id)
        previous = self.attempt(job["id"])
        if previous and tuple(previous[key] for key in ("cloud_id", "owner_id", "input_sha256", "local_id")) != expected:
            raise WorkerError("immutable_attempt_changed")
        self.db.execute("INSERT OR IGNORE INTO attempts VALUES (?,?,?,?,?)", (job["id"], *expected))
        self.db.commit()

    def promote_attempt(self, job, record, result_hash):
        attempt = self.attempt(job["id"])
        if not attempt:
            return
        if (attempt["cloud_id"], attempt["owner_id"], attempt["input_sha256"]) != (record["id"], record["user_id"], record["input_sha256"]):
            raise WorkerError("immutable_attempt_changed")
        previous = self.binding(record["id"])
        if previous and (previous["owner_id"], previous["input_sha256"]) != (record["user_id"], record["input_sha256"]):
            raise WorkerError("immutable_binding_changed")
        self.db.execute("INSERT INTO bindings VALUES (?,?,?,?,?) ON CONFLICT(cloud_id) DO UPDATE SET local_id=excluded.local_id,result_sha256=excluded.result_sha256",
                        (record["id"], record["user_id"], record["input_sha256"], attempt["local_id"], digest(result_hash)))
        self.db.commit()

    def artifact_write(self, job_id, path, state, content_hash=None):
        self.db.execute("INSERT INTO artifact_writes(job_id,path,state,content_sha256) VALUES (?,?,?,?) ON CONFLICT(job_id,path) DO UPDATE SET state=excluded.state,content_sha256=coalesce(excluded.content_sha256,artifact_writes.content_sha256)",
                        (job_id, path, state, content_hash))
        self.db.commit()

    def artifacts(self, job_id=None):
        rows = self.db.execute("SELECT * FROM artifact_writes WHERE state!='published'" + (" AND job_id=?" if job_id else ""), (job_id,) if job_id else ()).fetchall()
        return [dict(row) for row in rows]

    def forget_artifact(self, job_id, path):
        self.db.execute("DELETE FROM artifact_writes WHERE job_id=? AND path=?", (job_id, path))
        self.db.commit()

    def save_job(self, job, state, result=None, analysis_result=None, error_code=None):
        self.db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET state=excluded.state,result_json=excluded.result_json,analysis_json=excluded.analysis_json,error_code=excluded.error_code,updated_at=excluded.updated_at",
                        (job["id"], job["operation"], state,
                         canonical(result).decode() if result is not None else None,
                         canonical(analysis_result).decode() if analysis_result is not None else None,
                         error_code, utcnow()))
        self.db.commit()

    def close(self):
        self.db.close()


class ExistingBackend:
    def __init__(self, project_root):
        project_root = Path(project_root).resolve()
        backend = project_root / "app" / "breathmap-deepseek-20261024"
        bridge = project_root / "integration" / "softr_bridge"
        if not (backend / "service.py").is_file() or not (bridge / "live_bridge.py").is_file():
            raise WorkerError("existing_backend_unavailable")
        sys.path[:0] = [str(backend), str(bridge)]
        from runtime_sandbox import RuntimeSandbox
        from service import BreathMapService
        from result_reader import read_record_display, read_record_windows
        from result_presentation import present_display
        from waveform_reader import read_record_waveform
        from live_bridge import numeric_once
        from result_contract import read_saved_report_source
        self.sandbox = RuntimeSandbox.from_config(project_root / "runtime-config.json").initialize()
        # No API key is loaded for numeric processing or result reads.
        self.service = BreathMapService(self.sandbox.records, sandbox=self.sandbox,
                                       client=object(), recover_incomplete=False)
        self.read_display, self.read_windows = read_record_display, read_record_windows
        self.present, self.read_waveform = present_display, read_record_waveform
        self.numeric_once = numeric_once
        self.read_report_source = read_saved_report_source
        self.client_ready = False

    def close(self):
        self.service.close()

    def recover_owned(self, ledger):
        """After acquiring the OS lock, stop only this adapter's saved jobs."""
        for row in ledger.db.execute("SELECT local_id FROM bindings UNION SELECT local_id FROM attempts").fetchall():
            local_id = row["local_id"]
            try:
                metadata = self.service.get_record(local_id)
                if metadata.get("state") in {"queued", "running"}:
                    self.service._update(self.service._folder(local_id), state="interrupted",
                                         stage="stopped", error="local_process_restarted",
                                         report_status="interrupted")
            except (KeyError, ValueError, OSError):
                # Missing/changed bindings are refused later, never inferred.
                continue

    def create(self, content):
        return self.service.create_record(content, "recording.xlsx")["record_id"]

    def verify(self, local_id, expected_hash):
        metadata = self.service.get_record(local_id)
        path = self.service._guard(self.service._folder(local_id) / "input.xlsx")
        with path.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if metadata.get("input_sha256") != expected_hash or actual != expected_hash:
            raise WorkerError("local_input_changed")
        if metadata.get("analysis_available"):
            result_path = self.service._guard(self.service._folder(local_id) / "analysis" / "result.json")
            with result_path.open("rb") as stream:
                result_hash = hashlib.file_digest(stream, "sha256").hexdigest()
            binding = metadata.get("analysis_binding") or {}
            if binding.get("input_sha256") != expected_hash or binding.get("result_sha256") != result_hash:
                raise WorkerError("local_result_changed")
        return metadata

    def numeric(self, local_id):
        metadata = self.service.get_record(local_id)
        if metadata["state"] == "uploaded":
            self.numeric_once(self.service, local_id)
        elif metadata.get("analysis_available") and metadata["state"] == "interrupted":
            folder = self.service._folder(local_id)
            self.service._saved_analysis_for_recovery(folder, metadata)
            self.service._update(folder, state="analysis_available", stage="done", error=None)
        elif not metadata.get("analysis_available"):
            raise WorkerError("analysis_interrupted_review_required")

    def needs_fresh_numeric(self, local_id, metadata):
        if metadata.get("analysis_available"):
            return (self.read_display(self.service, local_id).get("execution") or {}).get("status") in {"error", "unable_to_analyze"}
        return metadata.get("state") in {"interrupted", "failed"}

    def enable_ai(self):
        if not self.client_ready:
            from deepseek_client import DeepSeekClient
            self.service.client = DeepSeekClient()
            self.client_ready = True

    def report(self, local_id, selected_language):
        self.enable_ai()
        metadata = self.service.retry_report(local_id, selected_language)
        future = self.service.futures.get(local_id)
        if metadata.get("state") in {"queued", "running"} and future is not None:
            future.result(timeout=900)
        return self.service.get_record(local_id)

    def chat(self, local_id, question, selected_language):
        self.enable_ai()
        return self.service.chat(local_id, question, selected_language)

    def display(self, local_id, cloud_id):
        value = self.read_display(self.service, local_id)
        value["record_id"] = cloud_id
        report = value.get("report") or {}
        saved_source = None
        if report.get("status") == "ready":
            saved_source = self.read_report_source(self.service, local_id, validated_report=report)
            if saved_source is None:
                raise WorkerError("report_changed_during_projection")
        value["report"] = stamp_report_source(report, saved_source)
        value["presentation"] = self.present(value)
        return value

    def validate_export(self, local_id, expected_hash, display):
        """Detect result/report changes after complete-window projection."""
        current = self.display(local_id, display["record_id"])
        if current.get("source_result_sha256") != expected_hash:
            raise WorkerError("local_result_changed")
        before, after = display.get("report") or {}, current.get("report") or {}
        if (before.get("status"), before.get("source_report_sha256")) != (after.get("status"), after.get("source_report_sha256")):
            raise WorkerError("report_changed_during_projection")

    def windows(self, local_id, cloud_id, result_hash):
        value = {}
        counts = self.read_display(self.service, local_id).get("window_counts") or {}
        for kind in ("model", "statistics", "attention"):
            if counts.get(kind) is None:
                value[kind] = {"kind": kind, "record_id": cloud_id,
                               "source_result_sha256": result_hash, "items": [],
                               "total": None, "unavailable": True, "next_offset": None}
                continue
            pages, offset, total = [], 0, None
            while True:
                page = self.read_windows(self.service, local_id, kind, offset, 200, result_hash)
                if total is not None and page["total"] != total:
                    raise WorkerError("result_changed")
                total = page["total"]
                pages.extend(page["items"])
                if page["next_offset"] is None:
                    value[kind] = {**page, "record_id": cloud_id, "offset": 0,
                                   "items": pages, "limit": len(pages), "next_offset": None}
                    break
                offset = page["next_offset"]
        return value

    def waveform(self, local_id, cloud_id, start, end, max_points):
        value = self.read_waveform(self.service, local_id, start, end, max_points)
        value["record_id"] = cloud_id
        return value


class Processor:
    def __init__(self, cloud, backend, ledger, *, stop=None):
        self.cloud, self.backend, self.ledger = cloud, backend, ledger
        self.stop = stop or threading.Event()

    def checked_record(self, job, snapshot=None):
        identifier(job.get("id")); identifier(job.get("recording_id")); identifier(job.get("user_id"))
        identifier(job.get("lease_token"))
        record = self.cloud.get_recording(job["recording_id"])
        if (not record or record.get("id") != job["recording_id"] or
                record.get("user_id") != job["user_id"] or record.get("trashed_at") is not None or
                record.get("deletion_started_at") is not None):
            raise WorkerError("record_unavailable")
        expected_path = job["user_id"] + "/" + job["recording_id"] + "/input.xlsx"
        if record.get("file_path") != expected_path:
            raise WorkerError("record_file_path_mismatch")
        digest(record.get("input_sha256"))
        if type(record.get("file_size")) is not int or not 0 < record["file_size"] <= MAX_INPUT_BYTES:
            raise WorkerError("record_file_size_invalid")
        cloud_job = self.cloud.get_job(job["id"])
        if (not cloud_job or cloud_job.get("status") != "running" or
                cloud_job.get("lease_token") != job["lease_token"] or
                cloud_job.get("user_id") != job["user_id"] or
                cloud_job.get("recording_id") != record["id"]):
            raise WorkerError("job_cancelled_or_changed")
        stamped = (job.get("payload") or {}).get("_input_sha256")
        if stamped is not None and stamped != record["input_sha256"]:
            raise WorkerError("job_input_changed")
        stamped_path = (job.get("payload") or {}).get("_file_path")
        if stamped_path is not None and stamped_path != record["file_path"]:
            raise WorkerError("job_input_changed")
        if snapshot and any(record.get(key) != snapshot.get(key) for key in ("id", "user_id", "input_sha256", "file_path", "file_size")):
            raise WorkerError("record_changed")
        return record

    def local_record(self, job, record):
        attempt = self.ledger.attempt(job["id"])
        if attempt:
            if (attempt["cloud_id"], attempt["owner_id"], attempt["input_sha256"]) != (record["id"], record["user_id"], record["input_sha256"]):
                raise WorkerError("immutable_attempt_changed")
            self.backend.verify(attempt["local_id"], record["input_sha256"])
            return attempt["local_id"]
        binding = self.ledger.binding(record["id"])
        if binding:
            if binding["owner_id"] != record["user_id"] or binding["input_sha256"] != record["input_sha256"]:
                raise WorkerError("immutable_binding_changed")
            metadata = self.backend.verify(binding["local_id"], record["input_sha256"])
            if binding["result_sha256"] is not None and (metadata.get("analysis_binding") or {}).get("result_sha256") != binding["result_sha256"]:
                raise WorkerError("local_result_changed")
            if job["operation"] != "analyse" or not self.backend.needs_fresh_numeric(binding["local_id"], metadata):
                return binding["local_id"]
        if job["operation"] != "analyse":
            raise WorkerError("analysis_not_available_on_host")
        content = self.cloud.download(record["file_path"])
        if len(content) != record["file_size"] or hashlib.sha256(content).hexdigest() != record["input_sha256"]:
            raise WorkerError("download_hash_mismatch")
        self.checked_record(job, record)
        local_id = self.backend.create(content)
        self.ledger.save_attempt(job, record, local_id)
        if not binding:
            self.ledger.bind(record, local_id)
        return local_id

    def rollback_artifacts(self, job_id):
        """Delete exact journalled job-owned objects, never a previous overview."""
        for entry in self.ledger.artifacts(job_id):
            parts = entry["path"].split("/")
            if (len(parts) != 4 or identifier(parts[0]) != parts[0] or
                    identifier(parts[1]) != parts[1] or digest(parts[2]) != parts[2] or
                    parts[3] != "overview-" + identifier(job_id) + ".json"):
                raise WorkerError("artifact_journal_invalid")
            if entry["state"] == "pending":
                # A timed-out upload may still be writing. A unique path is
                # uploaded once; only a complete matching read proves that
                # write became observable. Absence is never proof of abort.
                expected = entry.get("content_sha256")
                try:
                    actual = hashlib.sha256(self.cloud.read_artifact(entry["path"])).hexdigest()
                except Exception:
                    raise WorkerError("artifact_upload_outcome_unresolved") from None
                if not expected or actual != expected:
                    raise WorkerError("artifact_upload_content_unverified")
                self.ledger.artifact_write(job_id, entry["path"], "uploaded", expected)
            try:
                self.cloud.delete_artifact(entry["path"])
            except Exception:
                # Keep both journal and running job until precise cleanup can
                # be retried; a deletion must not race a terminal job marker.
                raise WorkerError("artifact_cleanup_pending") from None
            self.ledger.forget_artifact(job_id, entry["path"])

    def committed(self, job, record, result, analysis):
        if analysis is not None:
            self.ledger.promote_attempt(job, record, analysis["result_sha256"])
            if not self.ledger.attempt(job["id"]):
                binding = self.ledger.binding(record["id"])
                if binding:
                    self.ledger.bind(record, binding["local_id"], analysis["result_sha256"])
        for entry in self.ledger.artifacts(job["id"]):
            self.ledger.artifact_write(job["id"], entry["path"], "published")
        self.ledger.save_job(job, "completed", result, analysis)

    def publish(self, job, record, result, analysis):
        self.checked_record(job, record)
        if analysis is not None:
            attempt = self.ledger.attempt(job["id"])
            binding = attempt or self.ledger.binding(record["id"])
            if not binding or not isinstance(analysis.get("display"), dict):
                raise WorkerError("prepared_analysis_binding_missing")
            self.backend.verify(binding["local_id"], record["input_sha256"])
            self.backend.validate_export(binding["local_id"], analysis["result_sha256"], analysis["display"])
        self.ledger.save_job(job, "prepared", result, analysis)
        try:
            accepted = self.cloud.finish(job, result, analysis_result=analysis)
        except Exception:
            # The request may have committed before the response was lost.
            # Keep immutable local output and object journal for reconciliation.
            raise WorkerError("publication_outcome_unknown") from None
        if accepted is not True:
            self.rollback_artifacts(job["id"])
            self.ledger.save_job(job, "failed", error_code="publish_cancelled_or_changed")
            raise WorkerError("publish_cancelled_or_changed")
        try:
            self.committed(job, record, result, analysis)
        except Exception:
            raise WorkerError("publication_outcome_unknown") from None

    def reconcile_artifacts(self):
        """Fence each server lease before cleanup, including an in-flight finish."""
        job_ids = {entry["job_id"] for entry in self.ledger.artifacts()}
        job_ids.update(row["job_id"] for row in self.ledger.db.execute("SELECT job_id FROM jobs WHERE state='prepared'"))
        job_ids.update(row["id"] for row in self.cloud.running_jobs(self.ledger.worker_id))
        for job_id in job_ids:
            cloud_job = self.cloud.fence(job_id, self.ledger.worker_id)
            prior = self.ledger.job(job_id)
            if cloud_job is None:
                if self.cloud.get_job(job_id) is not None:
                    raise WorkerError("publication_reconciliation_required")
                self.rollback_artifacts(job_id)
                if prior:
                    self.ledger.save_job({"id": job_id, "operation": prior["operation"]}, "interrupted",
                                         json.loads(prior["result_json"]) if prior["result_json"] else None,
                                         json.loads(prior["analysis_json"]) if prior["analysis_json"] else None,
                                         "publication_not_committed")
                continue
            if cloud_job.get("id") != job_id or cloud_job.get("worker_id") != self.ledger.worker_id:
                raise WorkerError("cloud_fence_contract")
            if cloud_job and cloud_job.get("status") == "completed":
                result = json.loads(prior["result_json"]) if prior and prior["result_json"] else None
                analysis = json.loads(prior["analysis_json"]) if prior and prior["analysis_json"] else None
                if not result or cloud_job.get("result") != result:
                    raise WorkerError("publication_reconciliation_required")
                record = self.cloud.get_recording(cloud_job["recording_id"])
                if record:
                    self.committed(cloud_job, record, result, analysis)
                else:
                    for entry in self.ledger.artifacts(job_id):
                        self.ledger.artifact_write(job_id, entry["path"], "published")
                    self.ledger.save_job(cloud_job, "completed", result, analysis)
            else:
                if cloud_job.get("status") not in {"running", "failed", "interrupted"}:
                    raise WorkerError("cloud_fence_contract")
                if cloud_job.get("status") == "running":
                    identifier(cloud_job.get("lease_token"))
                self.rollback_artifacts(job_id)
                if cloud_job.get("status") == "running":
                    # The row lock + rotated lease has fenced any old HTTP
                    # finish transaction before this exact object deletion.
                    if self.cloud.finish(cloud_job, {}, error_code="worker_restarted") is not True:
                        raise WorkerError("publication_reconciliation_required")
                self.ledger.save_job(cloud_job, "interrupted",
                                     json.loads(prior["result_json"]) if prior and prior["result_json"] else None,
                                     json.loads(prior["analysis_json"]) if prior and prior["analysis_json"] else None,
                                     "publication_not_committed")

    def export(self, job, record, local_id, *, overview=False):
        self.checked_record(job, record)
        self.backend.verify(local_id, record["input_sha256"])
        display = self.backend.display(local_id, record["id"])
        result_hash = digest(display.get("source_result_sha256"))
        windows = self.backend.windows(local_id, record["id"], result_hash)
        manifest = {"schema": "breathmap-wave-manifest-1", "source_result_sha256": result_hash,
                    "on_demand": True, "overview": None,
                    "range": {"start_s": 0, "end_s": (display.get("extent") or {}).get("duration_s")},
                    "semantics": "source_rows_display_only_no_interpolation"}
        if (display.get("artifacts") or {}).get("waveform_available"):
            extent = display.get("extent") or {}
            end = extent.get("analysis_end_s") or extent.get("duration_s")
            start = extent.get("analysis_start_s") or 0
            if type(start) in {int, float} and type(end) in {int, float} and 0 <= start < end <= 43200:
                path = record["user_id"] + "/" + record["id"] + "/" + result_hash + "/overview-" + job["id"] + ".json"
                overview_ok = True
                if overview:
                    try:
                        waveform = self.backend.waveform(local_id, record["id"], start, end, 5000)
                    except Exception:
                        overview_ok = False
                        manifest["overview_error_code"] = "waveform_overview_unavailable"
                    if overview_ok:
                        self.checked_record(job, record)
                        content_hash = hashlib.sha256(canonical(waveform)).hexdigest()
                        written = next((entry for entry in self.ledger.artifacts(job["id"]) if entry["path"] == path), None)
                        if written:
                            if written.get("content_sha256") != content_hash or written["state"] != "uploaded":
                                raise WorkerError("artifact_upload_content_unverified")
                        else:
                            self.ledger.artifact_write(job["id"], path, "pending", content_hash)
                            try:
                                self.cloud.artifact(path, waveform)
                            except Exception as error:
                                code = error.code if isinstance(error, WorkerError) else ""
                                if re.fullmatch(r"cloud_http_4\d\d", code) and code != "cloud_http_408":
                                    # A definite client rejection did not commit
                                    # this unique upload; metrics can still save.
                                    self.ledger.forget_artifact(job["id"], path)
                                    overview_ok = False
                                    manifest["overview_error_code"] = "waveform_overview_unavailable"
                                else:
                                    raise WorkerError("artifact_upload_outcome_unresolved") from None
                            else:
                                self.ledger.artifact_write(job["id"], path, "uploaded", content_hash)
                if overview_ok:
                    manifest["overview"] = {"bucket": "analysis-artifacts", "path": path}
                manifest["range"] = {"start_s": start, "end_s": end}
        presentation = display["presentation"]
        summary = {"schema": "breathmap-web-summary-1", "metrics": presentation["cards"],
                   "analysis": display.get("execution"), "report": display.get("report"),
                   "versions": display.get("versions"), "extent": display.get("extent"),
                   "window_counts": display.get("window_counts"),
                   "source_result_sha256": result_hash, "presentation": presentation}
        self.checked_record(job, record)
        self.backend.validate_export(local_id, result_hash, display)
        return {"summary": summary, "display": display, "windows": windows,
                "wave_manifest": manifest, "result_sha256": result_hash}

    def execute(self, job):
        if job.get("operation") not in OPERATIONS or not isinstance(job.get("payload"), dict):
            raise WorkerError("invalid_job")
        selected_language = language(job["payload"])
        if (job["operation"] in {"report", "chat"} or
                job["operation"] == "analyse" and job["payload"].get("generate_report") is True):
            if job["payload"].get("ai_consent") is not True:
                raise WorkerError("ai_consent_required")
        record = self.checked_record(job)
        prior = self.ledger.job(job["id"])
        if prior:
            if prior["operation"] != job["operation"]:
                raise WorkerError("job_operation_changed")
            if prior["state"] == "prepared":
                result = json.loads(prior["result_json"])
                analysis = json.loads(prior["analysis_json"]) if prior["analysis_json"] else None
                self.publish(job, record, result, analysis)
                return result
            if prior["state"] in {"running", "completed", "failed", "interrupted"}:
                raise WorkerError("job_already_executed_review_required")
        self.ledger.save_job(job, "running")
        local_id = self.local_record(job, record)
        operation, payload = job["operation"], job["payload"]
        analysis = None
        if operation == "analyse":
            self.backend.numeric(local_id)
            # Publish numerics even when AI is not requested or unavailable.
            analysis = self.export(job, record, local_id, overview=True)
            result = {"analysis_status": (analysis["display"].get("execution") or {}).get("status"),
                      "result_sha256": analysis["result_sha256"], "report_status": "not_requested"}
            if payload.get("generate_report") is True:
                self.checked_record(job, record)
                try:
                    self.backend.report(local_id, selected_language)
                except Exception:
                    # Preserve the completed numerical result. A separate explicit
                    # report job is the only way to retry a paid request.
                    result["report_status"] = "unavailable"
                else:
                    analysis = self.export(job, record, local_id, overview=True)
                    result["report_status"] = (analysis["display"].get("report") or {}).get("status", "unavailable")
            elif payload.get("generate_report") not in {None, False}:
                raise WorkerError("invalid_ai_request")
        elif operation == "report":
            expected = payload.get("_result_sha256", payload.get("result_sha256"))
            current = self.backend.display(local_id, record["id"])
            if expected is not None and expected != current.get("source_result_sha256"):
                raise WorkerError("result_changed")
            self.checked_record(job, record)
            self.backend.report(local_id, selected_language)
            analysis = self.export(job, record, local_id, overview=True)
            result = {"report_status": (analysis["display"].get("report") or {}).get("status", "unavailable"),
                      "result_sha256": analysis["result_sha256"]}
        elif operation == "chat":
            question = payload.get("question")
            if not isinstance(question, str) or not 1 <= len(question.strip()) <= 2000 or "\x00" in question:
                raise WorkerError("invalid_question")
            current = self.backend.display(local_id, record["id"])
            if payload.get("_result_sha256", payload.get("result_sha256")) != current.get("source_result_sha256"):
                raise WorkerError("result_changed")
            self.checked_record(job, record)
            result = {"answer": self.backend.chat(local_id, question, selected_language),
                      "result_sha256": current["source_result_sha256"]}
        else:
            start, end, maximum = payload.get("start"), payload.get("end"), payload.get("max_points", 2000)
            if (type(start) not in {int, float} or type(end) not in {int, float} or
                    not 0 <= start < end <= 43200 or type(maximum) is not int or not 64 <= maximum <= 10000):
                raise WorkerError("invalid_waveform_range")
            current = self.backend.display(local_id, record["id"])
            if payload.get("_result_sha256", payload.get("result_sha256")) != current.get("source_result_sha256"):
                raise WorkerError("result_changed")
            result = {"waveform": self.backend.waveform(local_id, record["id"], start, end, maximum),
                      "result_sha256": current["source_result_sha256"]}
        self.checked_record(job, record)
        self.publish(job, record, result, analysis)
        return result

    def one(self):
        job = self.cloud.claim(self.ledger.worker_id)
        if not job:
            return {"processed": 0}
        try:
            self.execute(job)
            return {"processed": 1, "status": "completed", "operation": job.get("operation")}
        except Exception as error:
            code = error.code if isinstance(error, WorkerError) else "worker_operation_failed"
            # A completed/prepared paid action is never silently rerun after a
            # failed network write. Leave prepared locally for operator review.
            if code not in {"publication_outcome_unknown", "artifact_cleanup_pending", "artifact_upload_outcome_unresolved", "artifact_upload_content_unverified"}:
                try:
                    self.rollback_artifacts(job["id"])
                except WorkerError as cleanup:
                    code = cleanup.code
                    self.stop.set()
                else:
                    try:
                        self.cloud.finish(job, {}, error_code=code)
                        self.ledger.save_job(job, "failed", error_code=code)
                    except Exception:
                        self.stop.set()
            else:
                # Do not claim a later job while the current publication or
                # rollback is unresolved. Restart reconciles before recovery.
                self.stop.set()
            return {"processed": 1, "status": "needs_attention", "operation": job.get("operation"), "error_code": code}


@contextmanager
def process_lock(path, guard=lambda path: path):
    path = guard(Path(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as lock:
        if os.fstat(lock.fileno()).st_size == 0:
            lock.write(b"1"); lock.flush()
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise WorkerError("another_worker_is_running") from None
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-project", type=Path, default=DEFAULT_BACKEND_PROJECT)
    parser.add_argument("--once", action="store_true", help="Claim at most one job, then stop")
    parser.add_argument("--poll-seconds", type=int, default=5)
    args = parser.parse_args(argv)
    if not 2 <= args.poll_seconds <= 300:
        parser.error("poll interval must be 2..300 seconds")
    stop, busy = threading.Event(), threading.Event()
    backend = ledger = None
    heartbeat_thread = None
    def request_stop(unused_signal, unused_frame):
        stop.set()
    signal.signal(signal.SIGINT, request_stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, request_stop)
    try:
        cloud = SupabaseCloud.from_environment()
        detach_worker_credentials()
        backend = ExistingBackend(args.backend_project)
        guard = backend.sandbox.check_path
        state = guard(backend.sandbox.state / "supabase-web")
        state.mkdir(exist_ok=True)
        with process_lock(state / "worker.lock", guard):
            ledger = Ledger(state / "worker.sqlite", guard)
            # The OS lock proves that the previous local process has stopped.
            # Only mark interrupted; never requeue or repeat a paid action.
            backend.recover_owned(ledger)
            processor = Processor(cloud, backend, ledger, stop=stop)
            processor.reconcile_artifacts()
            def heartbeat():
                while not stop.is_set():
                    try:
                        cloud.heartbeat(busy=busy.is_set())
                    except WorkerError:
                        pass
                    stop.wait(15)
            heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
            heartbeat_thread.start()
            while not stop.is_set():
                busy.set()
                try:
                    outcome = processor.one()
                except WorkerError as error:
                    outcome = {"processed": 0, "error_code": error.code}
                finally:
                    busy.clear()
                print(canonical(outcome).decode(), flush=True)
                if args.once:
                    break
                if outcome.get("processed") == 0:
                    stop.wait(args.poll_seconds)
        return 0
    except WorkerError as error:
        print(canonical({"status": "stopped", "error_code": error.code}).decode(), flush=True)
        return 2
    except Exception:
        print('{"status":"stopped","error_code":"worker_startup_failed"}', flush=True)
        return 2
    finally:
        stop.set()
        if heartbeat_thread:
            heartbeat_thread.join(timeout=1)
        if ledger:
            ledger.close()
        if backend:
            backend.close()


if __name__ == "__main__":
    raise SystemExit(main())
