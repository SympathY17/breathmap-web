"""Prepare or clean one tracked synthetic browser-QA account; no inference/AI.

The action link is never written to a file. The link action requires
--private-output and its caller must capture stdout privately, without echoing.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import getpass
import hashlib
from html import escape
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import secrets
import time
from urllib.parse import parse_qs, quote, urlencode, urlsplit
import uuid
import warnings

from breathmap_worker import DEFAULT_BACKEND_PROJECT, ExistingBackend, Ledger, SupabaseCloud, WorkerError, canonical, identifier


ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".tmp" / "browser-qa-state.json"
PRIOR_RUN = ROOT / ".tmp" / "cloud-smoke-fbf48f74-5785-4b5b-897c-13676ee299d8.json"
TARGET = "https://breathmap-sympathy.netlify.app/"
KNOWN_INPUT = "88237b14ec805f516ef041dac422a8eac0158b7bca1212dd22778aef122f2db1"
MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def save_state(state):
    STATE.parent.mkdir(exist_ok=True)
    temporary = STATE.with_suffix(".json.new")
    temporary.write_bytes(canonical(state))
    temporary.replace(STATE)


def require_state(admin):
    state = json.loads(STATE.read_text(encoding="utf-8"))
    if state.get("cleaned") or state.get("project_url") != admin.url or state.get("target") != TARGET:
        raise WorkerError("browser_qa_state_unavailable")
    user_id = identifier(state.get("user_id"))
    user = admin.request("GET", "/auth/v1/admin/users/" + user_id)
    user = user.get("user", user)
    if (user.get("id") != user_id or (user.get("user_metadata") or {}).get("breathmap_browser_qa_run") != state.get("run_id")
            or not str(user.get("email", "")).startswith("breathmap-browser-")):
        raise WorkerError("browser_qa_user_binding_changed")
    return state, user


def cached_source():
    prior = json.loads(PRIOR_RUN.read_text(encoding="utf-8"))
    if prior.get("status") != "passed" or prior.get("synthetic_only") is not True:
        raise WorkerError("verified_synthetic_source_unavailable")
    owners = prior.get("temporary_user_ids") or []
    expected_result = prior.get("numeric_source", {}).get("result_sha256")
    for owner in owners:
        identifier(owner)
    if not owners or not re.fullmatch(r"[0-9a-f]{64}", str(expected_result)):
        raise WorkerError("verified_synthetic_source_unavailable")
    path = Path("E:/breathmap/state/supabase-web/worker.sqlite")
    with sqlite3.connect(path) as ledger:
        placeholders = ",".join("?" for unused in owners)
        row = ledger.execute("SELECT local_id FROM bindings WHERE owner_id IN (" + placeholders + ") AND input_sha256=? AND result_sha256=? LIMIT 1", (*owners, KNOWN_INPUT, expected_result)).fetchone()
    if not row:
        raise WorkerError("verified_synthetic_local_binding_unavailable")
    local_id = identifier(row[0])
    folder = Path("E:/breathmap/records") / local_id
    tracked = [folder / name for name in ("record.json", "input.xlsx", "analysis/result.json", "analysis/waveform.csv", "report.json")]
    for path in tracked:
        if path.resolve(strict=True) != path:
            raise WorkerError("synthetic_source_path_changed")
    hashes = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in tracked}
    if hashes[folder / "input.xlsx"] != KNOWN_INPUT or hashes[folder / "analysis" / "result.json"] != expected_result:
        raise WorkerError("synthetic_source_hash_changed")
    return local_id, folder, expected_result, hashes


def source_facade(local_id, folder):
    backend = DEFAULT_BACKEND_PROJECT / "app" / "breathmap-deepseek-20261024"
    bridge = DEFAULT_BACKEND_PROJECT / "integration" / "softr_bridge"
    sys.path[:0] = [str(backend), str(bridge)]
    from result_reader import read_record_display, read_record_windows
    from result_presentation import present_display
    from waveform_reader import read_record_waveform
    from result_contract import read_saved_report_source

    class ReadOnlyService:
        root = folder.parent
        def get_record(self, record_id):
            if record_id != local_id:
                raise WorkerError("synthetic_source_record_mismatch")
            return json.loads((folder / "record.json").read_text(encoding="utf-8"))
        def _guard(self, path):
            path = Path(path)
            if not path.is_relative_to(folder) or path.resolve(strict=True) != path:
                raise WorkerError("synthetic_source_path_changed")
            return path

    facade = ExistingBackend.__new__(ExistingBackend)
    facade.service = ReadOnlyService()
    facade.read_display, facade.read_windows = read_record_display, read_record_windows
    facade.present, facade.read_waveform = present_display, read_record_waveform
    facade.read_report_source = read_saved_report_source
    return facade


def prepare(admin):
    if STATE.is_file() and not json.loads(STATE.read_text(encoding="utf-8")).get("cleaned"):
        raise WorkerError("existing_browser_qa_must_be_cleaned_first")
    local_id, folder, result_hash, source_hashes = cached_source()
    run_id, record_id = str(uuid.uuid4()), str(uuid.uuid4())
    email = "breathmap-browser-" + run_id.replace("-", "") + "@example.invalid"
    response = admin.request("POST", "/auth/v1/admin/users", {"email": email, "email_confirm": True,
                              "user_metadata": {"name": "Synthetic Browser QA", "breathmap_browser_qa_run": run_id}})
    user = response.get("user", response)
    owner = identifier(user.get("id"))
    state = {"run_id": run_id, "project_url": admin.url, "target": TARGET, "user_id": owner,
             "recording_id": record_id, "source_local_id": local_id, "result_sha256": result_hash,
             "input_sha256": KNOWN_INPUT, "created_at_utc": datetime.now(timezone.utc).isoformat(),
             "synthetic_only": True, "model_runs": 0, "ai_calls": 0, "cleaned": False,
             "input_path": f"{owner}/{record_id}/input.xlsx",
             "overview_path": f"{owner}/{record_id}/{result_hash}/overview.json"}
    save_state(state)
    admin.request("POST", "/rest/v1/profiles", {"id": owner, "name": "Synthetic Browser QA"})
    raw = (folder / "input.xlsx").read_bytes()
    admin.request("POST", "/storage/v1/object/recordings/" + state["input_path"], raw, raw=True,
                  headers={"Content-Type": MIME, "x-upsert": "false"})
    recording = {"id": record_id, "user_id": owner, "title": "SYNTHETIC browser QA — verified recording",
                 "details": "Known synthetic input with verified saved numerical results; reused for browser acceptance.",
                 "notes": "Synthetic browser QA only. Cached verified results; no new model or AI call.",
                 "recorded_at": datetime.now(timezone.utc).isoformat(), "file_path": state["input_path"],
                 "file_name": "SYNTHETIC-browser-QA-60s.xlsx", "file_size": len(raw), "input_sha256": KNOWN_INPUT}
    admin.request("POST", "/rest/v1/recordings", recording)
    facade = source_facade(local_id, folder)
    display = facade.display(local_id, record_id)
    if display.get("source_result_sha256") != result_hash or display.get("report", {}).get("source") != "live":
        raise WorkerError("verified_synthetic_projection_changed")
    windows = facade.windows(local_id, record_id, result_hash)
    extent = display["extent"]
    start, end = extent.get("analysis_start_s") or 0, extent.get("analysis_end_s") or extent["duration_s"]
    waveform = facade.waveform(local_id, record_id, start, end, 5000)
    admin.artifact(state["overview_path"], waveform)
    manifest = {"schema": "breathmap-wave-manifest-1", "source_result_sha256": result_hash,
                "on_demand": True, "range": {"start_s": start, "end_s": end},
                "overview": {"bucket": "analysis-artifacts", "path": state["overview_path"]}}
    summary = {"schema": "breathmap-web-summary-1", "metrics": display["presentation"]["cards"],
               "analysis": display["execution"], "report": display["report"], "versions": display["versions"],
               "extent": display["extent"], "window_counts": display["window_counts"],
               "source_result_sha256": result_hash, "presentation": display["presentation"],
               "synthetic": True, "cached_verified_synthetic_qa": True}
    admin.request("POST", "/rest/v1/analysis_results", {"recording_id": record_id, "user_id": owner,
                  "summary": summary, "display": display, "windows": windows,
                  "wave_manifest": manifest, "result_sha256": result_hash})
    from runtime_sandbox import RuntimeSandbox
    sandbox = RuntimeSandbox.from_config(DEFAULT_BACKEND_PROJECT / "runtime-config.json")
    ledger = Ledger(sandbox.check_path(sandbox.state / "supabase-web" / "worker.sqlite"), sandbox.check_path)
    try:
        ledger.bind(recording, local_id, result_hash)
    finally:
        ledger.close()
    if source_hashes != {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in source_hashes}:
        raise WorkerError("synthetic_source_modified")
    state["prepared"] = True
    state["source_report_sha256"] = display["report"]["source_report_sha256"]
    save_state(state)
    return {"status": "prepared", "state_file": str(STATE), "user_id": owner, "recording_id": record_id,
            "synthetic_only": True, "model_runs": 0, "ai_calls": 0, "source_unchanged": True,
            "result_sha256": result_hash, "magic_link_created": False}


def link(admin):
    state, user = require_state(admin)
    if state.get("prepared") is not True:
        raise WorkerError("browser_qa_not_prepared")
    response = admin.request("POST", "/auth/v1/admin/generate_link?" + urlencode({"redirect_to": TARGET}),
                             {"type": "magiclink", "email": user["email"]})
    action = response.get("action_link") or (response.get("properties") or {}).get("action_link")
    parsed = urlsplit(action or "")
    target = parse_qs(parsed.query).get("redirect_to")
    redirect = urlsplit(target[0]) if isinstance(target, list) and len(target) == 1 else urlsplit("")
    if (parsed.scheme != "https" or parsed.netloc != urlsplit(admin.url).netloc or
            parsed.path != "/auth/v1/verify" or redirect.scheme != "https" or
            redirect.netloc != urlsplit(TARGET).netloc or redirect.path not in {"", "/"} or
            redirect.query or redirect.fragment):
        raise WorkerError("magic_link_redirect_mismatch")
    return {"status": "private_link_ready", "user_id": state["user_id"],
            "recording_id": state["recording_id"], "action_link": action,
            "target_origin": TARGET, "warning": "Capture privately; never echo, persist or screenshot the action link."}


def login(admin, *, password_page=False):
    """One-use loopback handoff; credentials never reach stdout or files."""
    action_link = page_bytes = None
    if password_page:
        state, user = require_state(admin)
        password = secrets.token_urlsafe(36) + "Aa7!"
        admin.request("PUT", "/auth/v1/admin/users/" + state["user_id"], {"password": password})
        public = {"user_id": state["user_id"], "recording_id": state["recording_id"]}
        page_bytes = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
                      "<meta name=\"referrer\" content=\"no-referrer\"><title>Disposable BreathMap QA credentials</title></head>"
                      "<body><h1>Disposable synthetic QA account</h1>"
                      "<p>One-use local handoff. Read values into private automation variables; never print or save them.</p>"
                      "<p><label for=\"qa-email\">Email</label><input id=\"qa-email\" type=\"email\" readonly autocomplete=\"off\" value=\""
                      + escape(user["email"], quote=True) + "\"></p>"
                      "<p><label for=\"qa-password\">Password</label><input id=\"qa-password\" type=\"password\" readonly autocomplete=\"off\" value=\""
                      + escape(password, quote=True) + "\"></p>"
                      "<p>Close this page after privately reading both fields. No form or script is present.</p></body></html>").encode("utf-8")
        password = None
    else:
        private = link(admin)
        action_link = private["action_link"]
        public = {"user_id": private["user_id"], "recording_id": private["recording_id"]}
        private = None
    admin._key = ""
    for name in ("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"):
        os.environ.pop(name, None)
    path = "/" + secrets.token_urlsafe(32)
    deadline = time.monotonic() + 300

    class Server(HTTPServer):
        consumed = False
        def handle_error(self, unused_request, unused_address):
            pass

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(max(0.1, min(5.0, deadline - time.monotonic())))
        def log_message(self, *unused):
            pass
        def log_error(self, *unused):
            pass
        def do_GET(self):
            if (self.path != path or self.headers.get_all("Host", []) != [f"127.0.0.1:{self.server.server_port}"]
                    or self.server.consumed or time.monotonic() >= deadline):
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                return
            self.server.consumed = True
            self.send_response(200 if password_page else 303)
            if not password_page:
                self.send_header("Location", action_link)
            else:
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("X-Frame-Options", "DENY")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Pragma", "no-cache")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Length", str(len(page_bytes)) if password_page else "0")
            self.send_header("Connection", "close")
            self.end_headers()
            if password_page:
                self.wfile.write(page_bytes)
            self.close_connection = True
        def do_HEAD(self):
            self.send_response(405)
            self.send_header("Content-Length", "0")
            self.end_headers()
        do_POST = do_HEAD

    with Server(("127.0.0.1", 0), Handler) as server:
        server.timeout = 0.5
        print(canonical({"status": "local_password_handoff_ready" if password_page else "local_handoff_ready", **public,
                         "handoff_url": f"http://127.0.0.1:{server.server_port}{path}",
                         "expires_in_seconds": 300, "one_use": True}).decode(), flush=True)
        while not server.consumed and time.monotonic() < deadline:
            server.handle_request()
        if not server.consumed:
            raise WorkerError("browser_qa_handoff_expired")
    state = json.loads(STATE.read_text(encoding="utf-8"))
    state["last_handoff_consumed_at_utc"] = datetime.now(timezone.utc).isoformat()
    save_state(state)
    return {"status": "local_handoff_consumed", **public, "listener_closed": True}


def set_password(admin):
    """Accept a newly chosen QA fixture secret on a hidden terminal only."""
    state, user = require_state(admin)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = getpass.getpass("New disposable QA fixture password (hidden): ")
    except (getpass.GetPassWarning, EOFError, KeyboardInterrupt):
        raise WorkerError("hidden_password_input_unavailable") from None
    if (not isinstance(password, str) or not 24 <= len(password) <= 128 or
            any(not 33 <= ord(char) <= 126 for char in password) or
            not all(re.search(pattern, password) for pattern in (r"[a-z]", r"[A-Z]", r"[0-9]", r"[^a-zA-Z0-9]"))):
        password = None
        raise WorkerError("qa_password_requires_24_to_128_ascii_characters_and_four_character_classes")
    response = admin.request("PUT", "/auth/v1/admin/users/" + state["user_id"], {"password": password})
    password = None
    updated = response.get("user", response)
    if updated.get("id") != state["user_id"]:
        raise WorkerError("browser_qa_password_response_mismatch")
    return {"status": "temporary_qa_password_set", "user_id": state["user_id"], "email": user["email"]}


def cleanup(admin):
    state, user = require_state(admin)
    owner = state["user_id"]
    def paths_in(bucket, prefix, depth=0):
        if depth > 5 or not prefix.startswith(owner):
            raise WorkerError("browser_qa_storage_scope_changed")
        paths, offset = [], 0
        while True:
            rows = admin.request("POST", "/storage/v1/object/list/" + bucket,
                                 {"prefix": prefix, "limit": 100, "offset": offset})
            if not isinstance(rows, list):
                raise WorkerError("browser_qa_storage_list_invalid")
            for row in rows:
                name = row.get("name")
                if not isinstance(name, str) or "/" in name or name in {".", ".."}:
                    raise WorkerError("browser_qa_storage_name_invalid")
                path = prefix + "/" + name
                if row.get("id"):
                    paths.append(path)
                else:
                    paths.extend(paths_in(bucket, path, depth + 1))
            if len(rows) < 100:
                return paths
            offset += 100
    removed_objects = 0
    for bucket in ("recordings", "analysis-artifacts"):
        objects = paths_in(bucket, owner)
        for offset in range(0, len(objects), 100):
            admin.request("DELETE", "/storage/v1/object/" + bucket, {"prefixes": objects[offset:offset + 100]})
        removed_objects += len(objects)
    admin.request("DELETE", "/auth/v1/admin/users/" + owner, {"should_soft_delete": False})
    # The new browser alias is removed; the verified source folder is retained.
    with sqlite3.connect("E:/breathmap/state/supabase-web/worker.sqlite") as ledger:
        ledger.execute("DELETE FROM bindings WHERE cloud_id=? AND owner_id=? AND input_sha256=? AND local_id=?",
                       (state["recording_id"], owner, KNOWN_INPUT, state["source_local_id"]))
    state.update(cleaned=True, cleaned_at_utc=datetime.now(timezone.utc).isoformat())
    save_state(state)
    return {"status": "cleaned", "user_id": owner, "storage_objects_removed": removed_objects,
            "source_local_artifacts_retained": True, "state_file": str(STATE)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "link", "login", "login-password", "set-password", "cleanup"))
    parser.add_argument("--private-output", action="store_true")
    args = parser.parse_args()
    if args.action == "link" and not args.private_output:
        parser.error("The link action requires --private-output and private stdout capture.")
    if args.private_output and args.action != "link":
        parser.error("Private output is used only for the link action.")
    try:
        admin = SupabaseCloud.from_environment()
        if admin.url != "https://hboyzyzzlzkgzubpsieo.supabase.co":
            raise WorkerError("browser_qa_project_mismatch")
        output = {"prepare": prepare, "link": link, "login": login,
                  "login-password": lambda service: login(service, password_page=True),
                  "set-password": set_password,
                  "cleanup": cleanup}[args.action](admin)
        print(canonical(output).decode(), flush=True)
        return 0
    except Exception as error:
        code = error.code if isinstance(error, WorkerError) else "browser_qa_operation_failed"
        print(canonical({"status": "failed", "error_code": code, "state_file": str(STATE)}).decode(), flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
