"""Explicit, disposable synthetic-only acceptance against the configured project.

Run only through Run-Cloud-Smoke.ps1. Credentials, access tokens and randomly
generated test passwords stay in memory. No real account or health data is used.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, build_opener
import uuid

from breathmap_worker import DEFAULT_BACKEND_PROJECT, NoRedirect, SupabaseCloud, WorkerError, canonical


ROOT = Path(__file__).resolve().parents[1]
MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
KNOWN_INPUT = "88237b14ec805f516ef041dac422a8eac0158b7bca1212dd22778aef122f2db1"


class CheckFailure(Exception):
    pass


class UserClient:
    def __init__(self, url, publishable, token=None):
        self.url, self.key, self.token = url, publishable, token
        self.opener = build_opener(NoRedirect())

    def call(self, method, path, value=None, *, raw=False, binary=False, headers=None):
        request_headers = {"apikey": self.key, "Accept-Encoding": "identity", "User-Agent": "BreathMap-Synthetic-Acceptance/1"}
        if self.token:
            request_headers["Authorization"] = "Bearer " + self.token
        body = value if raw else canonical(value) if value is not None else None
        if body is not None:
            request_headers["Content-Type"] = MIME if raw else "application/json"
        request_headers.update(headers or {})
        try:
            with self.opener.open(Request(self.url + path, data=body, headers=request_headers, method=method), timeout=45) as response:
                data = response.read(80 * 1024 * 1024 + 1)
                if len(data) > 80 * 1024 * 1024:
                    raise CheckFailure("user_response_limit")
                return response.status, data if binary else json.loads(data) if data else None
        except HTTPError as error:
            return error.code, None
        except (URLError, OSError, TimeoutError):
            raise CheckFailure("user_network_unavailable") from None
        except (ValueError, UnicodeError):
            raise CheckFailure("user_response_invalid") from None

    def rows(self, table, *, where=None, select="*", method="GET", value=None):
        query = {"select": select, **(where or {})}
        return self.call(method, "/rest/v1/" + table + "?" + urlencode(query), value,
                         headers={"Prefer": "return=representation"})

    def enqueue(self, record_id, operation, payload, key):
        return self.call("POST", "/rest/v1/rpc/request_analysis_job", {
            "p_recording_id": record_id, "p_operation": operation,
            "p_payload": payload, "p_request_key": key})


def client_settings():
    path = ROOT / ".env.local"
    settings = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if line.lstrip().startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() in {"VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"}:
            settings[name.strip()] = value.strip().strip("\"'")
    key = settings.get("VITE_SUPABASE_PUBLISHABLE_KEY", "")
    if not key.startswith("sb_publishable_"):
        raise CheckFailure("publishable_client_setting_unavailable")
    return settings.get("VITE_SUPABASE_URL", "").rstrip("/"), key


def success(status):
    return 200 <= status < 300


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", required=True)
    parser.add_argument("--with-ai", action="store_true", help="One explicitly consented synthetic report and one question")
    args = parser.parse_args(argv)
    run_id = str(uuid.uuid4())
    report = {"run_id": run_id, "started_at_utc": datetime.now(timezone.utc).isoformat(),
              "status": "running", "synthetic_only": True, "ai_calls": 0, "ai_requested": args.with_ai,
              "checks": [], "temporary_user_ids": [], "cleanup": {"status": "not_started"}}
    admin = None
    users, records, artifacts, jobs = [], [], [], []
    def check(condition, name):
        if not condition:
            raise CheckFailure(name)
        report["checks"].append(name)
        print(canonical({"check": name, "status": "passed"}).decode(), flush=True)
    def request_ok(client, method, path, value=None, **options):
        status, data = client.call(method, path, value, **options)
        if not success(status):
            raise CheckFailure("user_request_http_" + str(status))
        return data
    def create_user(label, publishable):
        password = secrets.token_urlsafe(36) + "Aa7!"
        email = "breathmap-smoke-" + run_id.replace("-", "") + "-" + label + "@example.invalid"
        data = admin.request("POST", "/auth/v1/admin/users", {
            "email": email, "password": password, "email_confirm": True,
            "user_metadata": {"name": "Disposable synthetic QA " + label,
                              "breathmap_synthetic_qa_run": run_id}})
        user = data.get("user", data)
        user_id = user.get("id")
        if not isinstance(user_id, str) or not re.fullmatch(r"[0-9a-f-]{36}", user_id):
            raise CheckFailure("temporary_auth_user_contract")
        record = {"id": user_id, "client": None}
        users.append(record)
        report["temporary_user_ids"].append(user_id)
        public_client = UserClient(admin.url, publishable)
        status, session = public_client.call("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": password})
        password = None
        if not success(status) or not isinstance(session, dict) or not session.get("access_token"):
            raise CheckFailure("temporary_password_signin_http_" + str(status))
        record["client"] = UserClient(admin.url, publishable, session["access_token"])
        return record
    def upload_record(user, raw):
        rid = str(uuid.uuid4())
        path = user["id"] + "/" + rid + "/input.xlsx"
        record = {"id": rid, "user": user, "path": path, "metadata_created": False}
        records.append(record)
        request_ok(user["client"], "POST", "/storage/v1/object/recordings/" + path,
                   raw, raw=True, headers={"x-upsert": "false"})
        metadata = {"id": rid, "user_id": user["id"], "title": "SYNTHETIC cloud smoke " + run_id,
                    "details": "Disposable known synthetic input; automated acceptance only.",
                    "notes": "No participant data. No AI requested.", "recorded_at": datetime.now(timezone.utc).isoformat(),
                    "file_path": path, "file_name": "SYNTHETIC-cloud-smoke-60s.xlsx",
                    "file_size": len(raw), "input_sha256": KNOWN_INPUT}
        status, rows = user["client"].rows("recordings", method="POST", value=metadata)
        if not success(status) or not isinstance(rows, list) or rows[0].get("id") != rid:
            raise CheckFailure("synthetic_metadata_create_http_" + str(status))
        record["metadata_created"] = True
        return record
    def own_rows(user, table, rid, select="*"):
        return user["client"].rows(table, where={"recording_id" if table in {"analysis_jobs", "analysis_results"} else "id": "eq." + rid}, select=select)
    def only_this_run_is_pending():
        pending = admin.request("GET", "/rest/v1/analysis_jobs?" + urlencode({"status": "in.(queued,running)", "select": "id,user_id,status"}))
        allowed = {user["id"] for user in users}
        check(all(row["user_id"] in allowed for row in pending), "no_foreign_pending_jobs_claimed")
    def run_worker_once():
        only_this_run_is_pending()
        environment = os.environ.copy()
        environment["SUPABASE_URL"] = admin.url
        # The value travels only in the child process environment, never argv.
        environment["SUPABASE_SECRET_KEY"] = admin._key
        completed = subprocess.run([sys.executable, "-B", "-X", "utf8", str(Path(__file__).with_name("breathmap_worker.py")), "--once"],
                                   cwd=str(Path(__file__).parent), env=environment,
                                   capture_output=True, timeout=2100)
        if completed.returncode != 0:
            raise CheckFailure("worker_nonzero_exit")
        lines = [json.loads(line) for line in completed.stdout.decode("utf-8").splitlines() if line.startswith(b"{".decode())]
        check(any(line.get("processed") == 1 and line.get("status") == "completed" for line in lines), "real_worker_job_completed")
    def business_domains(user_a, user_b, rec_a):
        status, rows = user_a["client"].rows("profiles", where={"id": "eq." + user_a["id"]})
        check(success(status) and len(rows) == 1, "profile_owner_read")
        status, rows = user_b["client"].rows("profiles", where={"id": "eq." + user_a["id"]})
        check(success(status) and rows == [], "profile_cross_account_read_empty")
        status, rows = user_a["client"].rows("profiles", where={"id": "eq." + user_a["id"]}, method="PATCH",
                                              value={"name": "Updated synthetic profile", "relax_preferences": {"duration_minutes": 3}})
        check(success(status) and len(rows) == 1, "profile_owner_update")
        status, rows = user_a["client"].rows("profiles", where={"id": "eq." + user_a["id"]})
        check(success(status) and rows[0]["name"] == "Updated synthetic profile" and rows[0]["relax_preferences"] == {"duration_minutes": 3}, "profile_update_persists")
        status, rows = user_b["client"].rows("profiles", where={"id": "eq." + user_a["id"]}, method="PATCH", value={"name": "Unauthorized change"})
        check(success(status) and rows == [], "profile_cross_account_update_empty")
        status, _ = user_a["client"].rows("profiles", where={"id": "eq." + user_a["id"]}, method="DELETE")
        check(status >= 400, "profile_direct_delete_keeps_account_boundary")
        now = datetime.now(timezone.utc).isoformat()
        domains = {
            "diary": ({"title": "Synthetic diary", "date": "2026-10-28", "sleep_quality": 3,
                        "day_sleepiness": 2, "notes": "Synthetic only", "recordings": [rec_a["id"]]},
                       {"notes": "Updated synthetic diary", "sleep_quality": 4}),
            "monitoring": ({"title": "Synthetic plan", "scheduled_at": now, "status": "Planned",
                             "notes": "Synthetic only", "recording_id": rec_a["id"]},
                            {"notes": "Updated synthetic plan", "status": "Completed"}),
            "routines": ({"title": "Synthetic routine", "bed_time": "22:30:00", "wake_time": "07:00:00",
                           "target_minutes": 510, "wind_down_minutes": 30,
                           "days": ["Monday", "Tuesday"], "commitments": ["Synthetic practice"], "active": True},
                          {"wind_down_minutes": 20, "active": False}),
            "visits": ({"title": "Synthetic visit preparation", "appointment_at": now,
                         "concerns": "Synthetic observations only", "questions": "Synthetic question",
                         "notes": "Synthetic only", "status": "Preparing", "recordings": [rec_a["id"]],
                         "diary_from": "2026-10-28", "diary_to": "2026-10-28"},
                        {"notes": "Updated synthetic visit", "after_notes": "Synthetic follow-up"}),
            "reactions": ({"title": "Synthetic reaction check", "completed_at": now,
                            "median_ms": 250.0, "mean_ms": 255.0, "misses": 0, "false_starts": 0,
                            "valid_trials": 3, "trial_count": 3, "sleepiness": 2,
                            "trials_json": [{"ms": 240}, {"ms": 250}, {"ms": 275}],
                            "test_version": "synthetic-cloud-smoke-v1", "device_class": "desktop", "notes": "Synthetic only"},
                           {"notes": "Updated synthetic reaction check", "median_ms": 251.0}),
        }
        for table, (values, update) in domains.items():
            status, created = user_a["client"].rows(table, method="POST", value={"user_id": user_a["id"], **values})
            check(success(status) and isinstance(created, list) and len(created) == 1, table + "_owner_create")
            row_id = created[0]["id"]
            where = {"id": "eq." + row_id}
            status, readback = user_a["client"].rows(table, where=where)
            check(success(status) and len(readback) == 1 and readback[0]["title"] == values["title"], table + "_owner_read")
            status, foreign = user_b["client"].rows(table, where=where)
            check(success(status) and foreign == [], table + "_cross_account_read_empty")
            status, changed = user_b["client"].rows(table, where=where, method="PATCH", value={"title": "Unauthorized change"})
            check(success(status) and changed == [], table + "_cross_account_update_empty")
            status, changed = user_a["client"].rows(table, where=where, method="PATCH", value=update)
            check(success(status) and len(changed) == 1, table + "_owner_update")
            status, readback = user_a["client"].rows(table, where=where)
            check(success(status) and all(readback[0][key] == value for key, value in update.items()), table + "_update_persists")
            status, removed = user_b["client"].rows(table, where=where, method="DELETE")
            check(success(status) and removed == [], table + "_cross_account_delete_empty")
            status, readback = user_a["client"].rows(table, where=where)
            check(success(status) and len(readback) == 1, table + "_owner_row_survives_cross_account_delete")
            status, removed = user_a["client"].rows(table, where=where, method="DELETE")
            check(success(status) and len(removed) == 1, table + "_owner_delete")
            status, readback = user_a["client"].rows(table, where=where)
            check(success(status) and readback == [], table + "_delete_persists")
        report["business_domains"] = ["profiles", "recordings", *domains.keys()]
    try:
        admin = SupabaseCloud.from_environment()
        url, publishable = client_settings()
        check(url == admin.url == "https://hboyzyzzlzkgzubpsieo.supabase.co", "exact_development_project")
        raw = (DEFAULT_BACKEND_PROJECT / "app" / "breathmap-deepseek-20261024" / "fixtures" / "synthetic-acquisition.xlsx").read_bytes()
        check(hashlib.sha256(raw).hexdigest() == KNOWN_INPUT, "known_synthetic_fixture_hash")
        user_a, user_b = create_user("a", publishable), create_user("b", publishable)
        check(len(users) == 2, "two_disposable_auth_users_created_and_signed_in")
        for user in users:
            status, rows = user["client"].rows("profiles", method="POST", value={"id": user["id"], "name": "Disposable Synthetic QA"})
            check(success(status) and len(rows) == 1, "own_profile_create_" + ("a" if user is user_a else "b"))
        rec_a, rec_b = upload_record(user_a, raw), upload_record(user_b, raw)
        check(len(records) == 2, "own_private_upload_and_metadata_for_both_accounts")
        business_domains(user_a, user_b, rec_a)
        status, private_b = user_b["client"].call("GET", "/storage/v1/object/authenticated/recordings/" + rec_b["path"], binary=True)
        check(success(status) and hashlib.sha256(private_b).hexdigest() == KNOWN_INPUT, "own_private_download_matches_original")
        status, rows = own_rows(user_b, "recordings", rec_a["id"])
        check(success(status) and rows == [], "cross_account_record_select_empty")
        status, rows = user_b["client"].rows("recordings", where={"id": "eq." + rec_a["id"]}, method="PATCH", value={"notes": "This must never be saved"})
        check(success(status) and rows == [], "cross_account_record_update_empty")
        status, rows = own_rows(user_a, "recordings", rec_a["id"])
        check(success(status) and rows[0]["notes"] == "No participant data. No AI requested.", "owner_notes_unchanged_after_cross_account_attempt")
        status, rows = user_a["client"].rows("recordings", where={"id": "eq." + rec_a["id"]}, method="PATCH", value={"notes": "Synthetic save-and-refresh passed."})
        check(success(status) and len(rows) == 1, "owner_note_update")
        status, rows = own_rows(user_a, "recordings", rec_a["id"])
        check(success(status) and rows[0]["notes"] == "Synthetic save-and-refresh passed.", "owner_note_readback_persists")
        status, _ = user_a["client"].rows("recordings", where={"id": "eq." + rec_a["id"]}, method="PATCH", value={"input_sha256": "f" * 64})
        check(status >= 400, "client_input_hash_update_denied")
        status, _ = user_a["client"].rows("recordings", where={"id": "eq." + rec_a["id"]}, method="PATCH", value={"user_id": user_b["id"]})
        check(status >= 400, "client_owner_reassignment_denied")
        status, _ = user_b["client"].rows("diary", method="POST", value={"user_id": user_b["id"], "title": "Synthetic rejected foreign link", "date": "2026-10-28", "recordings": [rec_a["id"]]})
        check(status >= 400, "cross_account_linked_record_denied")
        status, _ = user_b["client"].call("GET", "/storage/v1/object/authenticated/recordings/" + rec_a["path"], binary=True)
        check(status >= 400, "cross_account_private_file_download_denied")
        stranger_path = user_a["id"] + "/" + str(uuid.uuid4()) + "/input.xlsx"
        status, _ = user_b["client"].call("POST", "/storage/v1/object/recordings/" + stranger_path, raw, raw=True, headers={"x-upsert": "false"})
        check(status >= 400, "cross_account_storage_path_upload_denied")
        status, _ = user_a["client"].call("PUT", "/storage/v1/object/recordings/" + rec_a["path"], raw, raw=True)
        check(status >= 400, "immutable_input_object_replacement_denied")
        anonymous = UserClient(admin.url, publishable)
        status, _ = anonymous.rows("recordings")
        check(status >= 400, "anonymous_record_read_denied")
        status, rows = own_rows(user_a, "analysis_jobs", rec_a["id"], "id,status")
        check(success(status) and rows == [], "upload_does_not_implicitly_request_analysis")
        status, _ = user_b["client"].enqueue(rec_a["id"], "analyse", {"language": "en"}, str(uuid.uuid4()))
        check(status >= 400, "cross_account_analysis_request_denied")
        status, _ = user_a["client"].call("POST", "/rest/v1/rpc/claim_analysis_job", {"p_worker_id": "unauthorized-browser"})
        check(status >= 400, "browser_worker_claim_denied")
        status, _ = user_a["client"].enqueue(rec_a["id"], "analyse", {"language": "en", "generate_report": True}, str(uuid.uuid4()))
        check(status >= 400, "analysis_ai_without_consent_denied_before_work")
        request_key = str(uuid.uuid4())
        payload = {"language": "en", "generate_report": False}
        status, job = user_a["client"].enqueue(rec_a["id"], "analyse", payload, request_key)
        check(success(status) and job.get("status") == "queued", "numeric_analysis_explicitly_queued")
        jobs.append(job["id"])
        status, duplicate = user_a["client"].enqueue(rec_a["id"], "analyse", payload, request_key)
        check(success(status) and duplicate.get("id") == job["id"], "enqueue_network_retry_reuses_same_job")
        status, _ = user_a["client"].enqueue(rec_a["id"], "analyse", {"language": "zh", "generate_report": False}, request_key)
        check(status >= 400, "reused_request_key_with_different_payload_denied")
        check("lease_token" not in job and "worker_id" not in job, "browser_enqueue_omits_internal_lease_identifiers")
        run_worker_once()
        status, result_rows = own_rows(user_a, "analysis_results", rec_a["id"])
        check(success(status) and len(result_rows) == 1, "analysis_result_readable_by_owner")
        saved = result_rows[0]
        expected_hash = saved["result_sha256"]
        check(saved["display"]["schema"] == "breathmap-display-1" and saved["display"]["source_result_sha256"] == expected_hash,
              "display_is_bound_to_immutable_result_hash")
        check(saved["display"]["execution"]["status"] in {"success", "partial"}, "real_numerical_execution_has_usable_outputs")
        check(saved["display"]["report"]["status"] != "ready", "no_ai_report_generated")
        for kind in ("model", "statistics", "attention"):
            page = saved["windows"][kind]
            check(page["source_result_sha256"] == expected_hash and (page["total"] is None or len(page["items"]) == page["total"]), "complete_bound_" + kind + "_windows")
        ledger_path = Path("E:/breathmap/state/supabase-web/worker.sqlite")
        with sqlite3.connect(ledger_path) as local_ledger:
            binding = local_ledger.execute("SELECT local_id,input_sha256,result_sha256 FROM bindings WHERE cloud_id=? AND owner_id=?", (rec_a["id"], user_a["id"])).fetchone()
        check(binding is not None and binding[1] == KNOWN_INPUT and binding[2] == expected_hash, "durable_local_cloud_binding")
        local_folder = Path("E:/breathmap/records") / binding[0]
        check(hashlib.sha256((local_folder / "analysis" / "result.json").read_bytes()).hexdigest() == expected_hash,
              "published_result_matches_actual_saved_engine_bytes")
        overview = saved["wave_manifest"]["overview"]
        check(overview and overview["path"].startswith(user_a["id"] + "/" + rec_a["id"] + "/" + expected_hash + "/"), "private_overview_path_is_owner_record_result_bound")
        artifacts.append((overview["bucket"], overview["path"]))
        status, overview_bytes = user_a["client"].call("GET", "/storage/v1/object/authenticated/" + overview["bucket"] + "/" + overview["path"], binary=True)
        overview_data = json.loads(overview_bytes) if success(status) else {}
        check(success(status) and overview_data.get("sampling", {}).get("interpolation") is False and len(overview_data.get("points", [])) <= 5000,
              "owner_overview_uses_bounded_actual_samples_without_interpolation")
        status, _ = user_b["client"].call("GET", "/storage/v1/object/authenticated/" + overview["bucket"] + "/" + overview["path"], binary=True)
        check(status >= 400, "cross_account_overview_download_denied")
        status, rows = own_rows(user_b, "analysis_results", rec_a["id"])
        check(success(status) and rows == [], "cross_account_analysis_result_read_empty")
        status, _ = user_a["client"].enqueue(rec_a["id"], "waveform", {"start": 10, "end": 20, "max_points": 1000, "result_sha256": "f" * 64}, str(uuid.uuid4()))
        check(status >= 400, "stale_display_hash_rejected_before_wave_work")
        status, _ = user_a["client"].enqueue(rec_a["id"], "report", {"language": "en", "result_sha256": expected_hash}, str(uuid.uuid4()))
        check(status >= 400, "report_without_ai_consent_denied_before_paid_call")
        wave_payload = {"start": 10, "end": 20, "max_points": 1000, "result_sha256": expected_hash}
        status, wave_job = user_a["client"].enqueue(rec_a["id"], "waveform", wave_payload, str(uuid.uuid4()))
        check(success(status) and wave_job["status"] == "queued", "detailed_waveform_explicitly_queued")
        jobs.append(wave_job["id"])
        run_worker_once()
        status, wave_rows = user_a["client"].rows("analysis_jobs", where={"id": "eq." + wave_job["id"]}, select="id,status,result,result_sha256,error_code")
        wave_result = wave_rows[0] if success(status) and wave_rows else {}
        check(wave_result.get("status") == "completed" and wave_result.get("result", {}).get("result_sha256") == expected_hash,
              "detailed_waveform_completed_with_original_result_hash")
        wave = wave_result["result"]["waveform"]
        check(wave["range"]["start_s"] == 10 and wave["range"]["end_s"] == 20 and len(wave["points"]) <= 1000,
              "detailed_waveform_respects_selected_interval_and_bound")
        check(len(wave["points"]) == len(wave["break_before"]) and wave["sampling"]["interpolation"] is False,
              "detailed_waveform_preserves_gap_flags_without_interpolation")
        if args.with_ai:
            # Exactly one new report command and one question command. The
            # existing provider flow may perform its single bounded repair.
            sys.path.insert(0, str(DEFAULT_BACKEND_PROJECT / "app" / "breathmap-deepseek-20261024"))
            from grounding import project_result, validate_answer_citations
            from service import valid_saved_report
            numerical_bytes = (local_folder / "analysis" / "result.json").read_bytes()
            numerical_result = json.loads(numerical_bytes)
            numerical_artifacts = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                   for path in (local_folder / "analysis").iterdir() if path.is_file()}
            report_key = str(uuid.uuid4())
            report_payload = {"language": "en", "ai_consent": True, "result_sha256": expected_hash}
            status, report_job = user_a["client"].enqueue(rec_a["id"], "report", report_payload, report_key)
            check(success(status) and report_job.get("status") == "queued", "consented_synthetic_report_queued_once")
            jobs.append(report_job["id"])
            status, repeated_report = user_a["client"].enqueue(rec_a["id"], "report", report_payload, report_key)
            check(success(status) and repeated_report.get("id") == report_job["id"], "paid_report_network_retry_reuses_same_job")
            run_worker_once()
            status, updated_rows = own_rows(user_a, "analysis_results", rec_a["id"])
            live_display = updated_rows[0]["display"] if success(status) and updated_rows else {}
            live_report = live_display.get("report") or {}
            audit_file = local_folder / "provider-audit.json"
            audit = json.loads(audit_file.read_text(encoding="utf-8")) if audit_file.is_file() else []
            report["ai_calls"] = len(audit)
            report["provider"] = {"origin": "https://api.deepseek.com", "successful_completion_calls": len(audit),
                                  "models": sorted({row.get("model") for row in audit if isinstance(row.get("model"), str)}),
                                  "purposes": [row.get("purpose") for row in audit], "report_commands": 1, "chat_commands": 0}
            check(live_report.get("status") == "ready", "real_provider_report_ready")
            check(live_report.get("source") == "live" and live_report.get("simulated") is False,
                  "saved_report_provenance_is_verified_live")
            check(live_display.get("source_result_sha256") == expected_hash,
                  "report_remains_bound_to_original_numerical_result")
            saved_report_bytes = (local_folder / "report.json").read_bytes()
            check(hashlib.sha256(saved_report_bytes).hexdigest() == live_report.get("source_report_sha256"),
                  "live_report_source_matches_actual_saved_report_bytes")
            check(valid_saved_report(json.loads(saved_report_bytes), numerical_result), "report_citations_and_exact_values_validate")
            question = "Explain the breathing-rate result and the limitations of the available analysis windows."
            chat_payload = {"language": "en", "ai_consent": True, "result_sha256": expected_hash, "question": question}
            status, chat_job = user_a["client"].enqueue(rec_a["id"], "chat", chat_payload, str(uuid.uuid4()))
            check(success(status) and chat_job.get("status") == "queued", "consented_synthetic_question_queued_once")
            jobs.append(chat_job["id"])
            report["provider"]["chat_commands"] = 1
            run_worker_once()
            status, chat_rows = user_a["client"].rows("analysis_jobs", where={"id": "eq." + chat_job["id"]}, select="id,status,result,result_sha256,error_code")
            chat_result = chat_rows[0].get("result", {}) if success(status) and chat_rows else {}
            answer = chat_result.get("answer") or {}
            audit = json.loads(audit_file.read_text(encoding="utf-8")) if audit_file.is_file() else []
            report["ai_calls"] = len(audit)
            report["provider"].update(successful_completion_calls=len(audit),
                                       models=sorted({row.get("model") for row in audit if isinstance(row.get("model"), str)}),
                                       purposes=[row.get("purpose") for row in audit],
                                       tool_names=sorted({name for row in audit for name in row.get("tool_names", []) if isinstance(name, str)}))
            check(answer.get("status") == "ready" and isinstance(answer.get("claims"), list), "real_provider_question_answer_ready")
            check(chat_result.get("result_sha256") == expected_hash, "question_answer_retains_original_result_hash")
            cited_ids = list(dict.fromkeys(eid for claim in answer["claims"] for eid in claim["evidence_ids"]))
            projection = project_result(numerical_result, focus_ids=cited_ids, max_context_chars=64000)
            check(validate_answer_citations({"claims": answer["claims"]}, projection)["valid"],
                  "question_citations_and_exact_scalar_bindings_validate")
            check(all(not re.search(r"\d", claim["text"]) for claim in answer["claims"]), "answer_keeps_exact_numbers_in_verified_bindings")
            check(numerical_artifacts == {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                         for path in (local_folder / "analysis").iterdir() if path.is_file()},
                  "report_and_question_never_rerun_or_change_numerical_artifacts")
            check(all(name != "analyse_current_record" for row in audit for name in row.get("tool_names", [])),
                  "provider_tools_only_read_saved_evidence")
        status, rows = user_a["client"].rows("recordings", where={"id": "eq." + rec_a["id"]}, method="DELETE")
        check(success(status) and rows == [], "permanent_delete_before_trash_denied")
        status, rows = user_a["client"].rows("recordings", where={"id": "eq." + rec_a["id"]}, method="PATCH", value={"trashed_at": datetime.now(timezone.utc).isoformat()})
        check(success(status) and len(rows) == 1, "owner_record_moves_to_recycle_bin")
        status, _ = user_a["client"].enqueue(rec_a["id"], "analyse", {"language": "en"}, str(uuid.uuid4()))
        check(status >= 400, "trashed_record_cannot_start_new_analysis")
        report["numeric_source"] = {"input_sha256": KNOWN_INPUT, "result_sha256": expected_hash,
                                    "execution_status": saved["display"]["execution"]["status"],
                                    "window_counts": saved["display"]["window_counts"],
                                    "overview_points": len(overview_data["points"]), "detailed_waveform_points": len(wave["points"])}
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["error_code"] = error.code if isinstance(error, WorkerError) else str(error) if isinstance(error, CheckFailure) else "cloud_smoke_unexpected_error"
    finally:
        cleanup_errors = []
        if admin:
            # Only paths and IDs created by this run are eligible for cleanup.
            for bucket, path in artifacts:
                try:
                    admin.request("DELETE", "/storage/v1/object/" + bucket, {"prefixes": [path]})
                except Exception:
                    cleanup_errors.append("synthetic_artifact_cleanup_failed")
            for record in records:
                try:
                    admin.request("DELETE", "/storage/v1/object/recordings", {"prefixes": [record["path"]]})
                    if record["metadata_created"]:
                        client = record["user"]["client"]
                        status, _ = client.rows("recordings", where={"id": "eq." + record["id"]}, method="PATCH", value={"trashed_at": datetime.now(timezone.utc).isoformat()})
                        if not success(status):
                            raise CheckFailure("cleanup_trash_failed")
                        status, removed = client.rows("recordings", where={"id": "eq." + record["id"]}, method="DELETE")
                        if not success(status) or len(removed) != 1:
                            raise CheckFailure("cleanup_delete_failed")
                        leftovers = admin.request("GET", "/rest/v1/analysis_results?" + urlencode({"recording_id": "eq." + record["id"], "select": "recording_id"}))
                        if leftovers:
                            raise CheckFailure("cleanup_cascade_failed")
                except Exception:
                    cleanup_errors.append("synthetic_record_cleanup_failed")
            for user in users:
                try:
                    if user["client"]:
                        user["client"].call("POST", "/auth/v1/logout", {})
                    admin.request("DELETE", "/auth/v1/admin/users/" + user["id"], {"should_soft_delete": False})
                except Exception:
                    cleanup_errors.append("synthetic_auth_user_cleanup_failed")
            report["cleanup"] = {"status": "passed" if not cleanup_errors else "needs_attention", "errors": cleanup_errors,
                                 "temporary_users_targeted": len(users), "temporary_records_targeted": len(records),
                                 "local_synthetic_engine_artifacts": "retained_in_existing_sandbox_for_audit"}
        report["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
        report["checks_passed"] = len(report["checks"])
        if cleanup_errors:
            report["status"] = "needs_attention"
        output = ROOT / ".tmp" / ("cloud-smoke-" + run_id + ".json")
        output.parent.mkdir(exist_ok=True)
        output.write_bytes(canonical(report))
        print(canonical({"status": report["status"], "checks_passed": report["checks_passed"],
                         "error_code": report.get("error_code"), "cleanup": report["cleanup"]["status"],
                         "report": str(output)}).decode(), flush=True)
    return 0 if report["status"] == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
