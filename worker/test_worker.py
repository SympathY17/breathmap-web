"""Deterministic adapter tests. No network, real files, model or AI calls."""
from copy import deepcopy
import base64
import hashlib
import json
import os
import secrets
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

from breathmap_worker import Ledger, Processor, SupabaseCloud, WorkerError, process_lock, stamp_report_source, detach_worker_credentials


def uid():
    return str(uuid.uuid4())


CONTENT = b"fixture-content-not-a-real-workbook"
INPUT_HASH = hashlib.sha256(CONTENT).hexdigest()
RESULT_HASH = hashlib.sha256(b"saved-immutable-result").hexdigest()


class FakeCloud:
    def __init__(self):
        owner, recording = uid(), uid()
        self.record = {"id": recording, "user_id": owner,
                       "file_path": owner + "/" + recording + "/input.xlsx",
                       "file_name": "fixture.xlsx", "file_size": len(CONTENT),
                       "input_sha256": INPUT_HASH, "trashed_at": None}
        self.jobs, self.finished, self.artifacts = {}, [], {}
        self.claimed, self.downloads = False, 0
        self.payload_override = None
        self.finish_result = True
        self.cancel_after_download = False
        self.artifact_error = False

    def add_job(self, operation="analyse", **payload):
        if operation in {"report", "chat"}:
            payload = {"ai_consent": True, **payload}
        job = {"id": uid(), "user_id": self.record["user_id"],
               "recording_id": self.record["id"], "operation": operation,
               "payload": {"language": "en", "_input_sha256": INPUT_HASH, **payload},
               "status": "running", "lease_token": uid()}
        self.jobs[job["id"]] = job
        return job

    def claim(self, worker_id):
        if self.claimed or not self.jobs:
            return None
        self.claimed = True
        return deepcopy(next(iter(self.jobs.values())))

    def get_recording(self, record_id):
        return deepcopy(self.record) if self.record and self.record["id"] == record_id else None

    def get_job(self, job_id):
        return deepcopy(self.jobs.get(job_id))

    def download(self, path):
        self.downloads += 1
        if self.cancel_after_download:
            next(iter(self.jobs.values()))["status"] = "interrupted"
        return self.payload_override if self.payload_override is not None else CONTENT

    def artifact(self, path, value):
        if self.artifact_error:
            raise WorkerError("cloud_network_unavailable")
        self.artifacts[path] = value

    def finish(self, job, result, *, analysis_result=None, error_code=None):
        self.finished.append({"job": job["id"], "result": deepcopy(result),
                              "analysis": deepcopy(analysis_result), "error": error_code})
        return self.finish_result


class FakeBackend:
    def __init__(self):
        self.creates = self.numerics = self.reports = self.chats = self.waves = 0
        self.local = uid()
        self.report_error = False
        self.report_state = "absent"
        self.on_numeric = None

    def create(self, content):
        self.creates += 1
        return self.local

    def verify(self, local_id, expected):
        if local_id != self.local or expected != INPUT_HASH:
            raise WorkerError("local_input_changed")
        return {"analysis_binding": {"result_sha256": RESULT_HASH}}

    def numeric(self, local_id):
        self.numerics += 1
        if self.on_numeric:
            self.on_numeric()

    def report(self, local_id, language):
        self.reports += 1
        if self.report_error:
            raise WorkerError("provider_unavailable")
        self.report_state = "ready"
        return {"report_status": "ready"}

    def chat(self, local_id, question, language):
        self.chats += 1
        return {"chat_id": uid(), "claims": [{"text": "A verified observation.",
                    "evidence_ids": ["SUM"], "values": [{"evidence_id": "SUM", "field": "frequency_bpm", "value": 12.0}]}]}

    def display(self, local_id, cloud_id):
        return {"schema": "breathmap-display-1", "record_id": cloud_id,
                "source_result_sha256": RESULT_HASH, "extent": {"duration_s": 75.0, "analysis_start_s": 10.0, "analysis_end_s": 75.0},
                "execution": {"status": "partial"}, "report": {"status": self.report_state},
                "summary": {"frequency_bpm": 12.0, "mean_expiratory_flow_l_min": 0.0},
                "window_counts": {"model": 15, "statistics": 3, "attention": 2},
                "versions": {"model": "test-only"}, "artifacts": {"waveform_available": True},
                "presentation": {"cards": [{"key": "frequency_bpm", "value": 12.0}]}}

    def windows(self, local_id, cloud_id, result_hash):
        return {"model": {"items": list(range(15)), "total": 15},
                "statistics": {"items": list(range(3)), "total": 3},
                "attention": {"items": list(range(2)), "total": 2}}

    def waveform(self, local_id, cloud_id, start, end, max_points):
        self.waves += 1
        return {"record_id": cloud_id, "columns": ["time_s", "signal_mT"],
                "points": [[start, None], [end - 0.01, 1.0]], "break_before": [[True], [True]],
                "range": {"start_s": start, "end_s": end}, "sampling": {"returned_points": 2, "interpolation": False}}

    def validate_export(self, local_id, expected_hash, display):
        if expected_hash != RESULT_HASH:
            raise WorkerError("local_result_changed")


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".test-", dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "state" / "worker.sqlite")
        self.addCleanup(self.ledger.close)
        self.cloud, self.backend = FakeCloud(), FakeBackend()
        self.worker = Processor(self.cloud, self.backend, self.ledger)

    def bind(self):
        self.ledger.bind(self.cloud.record, self.backend.local, RESULT_HASH)

    def test_numerical_result_exports_every_window_without_ai(self):
        job = self.cloud.add_job()
        outcome = self.worker.one()
        self.assertEqual(outcome["status"], "completed")
        self.assertEqual((self.backend.numerics, self.backend.reports), (1, 0))
        saved = self.cloud.finished[-1]["analysis"]
        self.assertEqual(saved["windows"]["model"]["items"], list(range(15)))
        self.assertEqual(saved["display"]["summary"]["mean_expiratory_flow_l_min"], 0.0)
        self.assertTrue(saved["wave_manifest"]["on_demand"])
        self.assertEqual(self.ledger.job(job["id"])["state"], "completed")

    def test_cross_owner_job_never_downloads_or_analyzes(self):
        job = self.cloud.add_job()
        job["user_id"] = uid()
        outcome = self.worker.one()
        self.assertEqual(outcome["error_code"], "record_unavailable")
        self.assertEqual((self.cloud.downloads, self.backend.numerics), (0, 0))

    def test_hash_mismatch_prevents_import(self):
        self.cloud.add_job()
        self.cloud.payload_override = b"tampered input"
        outcome = self.worker.one()
        self.assertEqual(outcome["error_code"], "download_hash_mismatch")
        self.assertEqual(self.backend.creates, 0)

    def test_cancel_after_download_prevents_import(self):
        self.cloud.add_job()
        self.cloud.cancel_after_download = True
        outcome = self.worker.one()
        self.assertEqual(outcome["error_code"], "job_cancelled_or_changed")
        self.assertEqual(self.backend.creates, 0)

    def test_record_trashed_during_numerics_prevents_publish(self):
        self.cloud.add_job()
        self.backend.on_numeric = lambda: self.cloud.record.update(trashed_at="2026-10-28T00:00:00Z")
        outcome = self.worker.one()
        self.assertEqual(outcome["error_code"], "record_unavailable")
        self.assertFalse(self.cloud.finished[-1]["analysis"])
        self.assertFalse(self.cloud.artifacts)

    def test_input_hash_changed_before_claim_rejected(self):
        self.cloud.add_job()
        self.cloud.record["input_sha256"] = "f" * 64
        self.assertEqual(self.worker.one()["error_code"], "job_input_changed")
        self.assertEqual(self.cloud.downloads, 0)

    def test_prepared_job_republishes_without_numeric_or_paid_calls(self):
        job = self.cloud.add_job()
        self.ledger.save_job(job, "prepared", {"analysis_status": "success"}, {"result_sha256": RESULT_HASH})
        self.worker.execute(deepcopy(job))
        self.assertEqual((self.backend.numerics, self.backend.reports, self.cloud.downloads), (0, 0, 0))

    def test_completed_job_is_never_executed_twice(self):
        job = self.cloud.add_job()
        self.worker.execute(deepcopy(job))
        with self.assertRaisesRegex(WorkerError, "job_already_executed"):
            self.worker.execute(deepcopy(job))
        self.assertEqual(self.backend.numerics, 1)

    def test_running_job_after_crash_requires_review(self):
        job = self.cloud.add_job("report")
        self.ledger.save_job(job, "running")
        with self.assertRaisesRegex(WorkerError, "review_required"):
            self.worker.execute(deepcopy(job))
        self.assertEqual(self.backend.reports, 0)

    def test_report_failure_retains_completed_numerical_result(self):
        self.cloud.add_job(generate_report=True, ai_consent=True)
        self.backend.report_error = True
        outcome = self.worker.one()
        self.assertEqual(outcome["status"], "completed")
        self.assertEqual(self.cloud.finished[-1]["result"]["report_status"], "unavailable")
        self.assertEqual(self.cloud.finished[-1]["analysis"]["display"]["summary"]["frequency_bpm"], 12.0)
        self.assertEqual(self.backend.numerics, 1)

    def test_failed_overview_does_not_discard_metrics(self):
        self.cloud.add_job()
        self.cloud.artifact_error = True
        self.assertEqual(self.worker.one()["status"], "completed")
        manifest = self.cloud.finished[-1]["analysis"]["wave_manifest"]
        self.assertIsNone(manifest["overview"])
        self.assertEqual(manifest["overview_error_code"], "waveform_overview_unavailable")

    def test_chat_reads_existing_result_and_preserves_verified_bindings(self):
        self.bind()
        self.cloud.add_job("chat", question="Explain the selected result.", _result_sha256=RESULT_HASH)
        self.assertEqual(self.worker.one()["status"], "completed")
        self.assertEqual((self.backend.chats, self.backend.numerics), (1, 0))
        self.assertEqual(self.cloud.finished[-1]["result"]["answer"]["claims"][0]["values"][0]["value"], 12.0)

    def test_chat_from_changed_result_does_not_call_ai(self):
        self.bind()
        self.cloud.add_job("chat", question="Why?", _result_sha256="f" * 64)
        self.assertEqual(self.worker.one()["error_code"], "result_changed")
        self.assertEqual(self.backend.chats, 0)

    def test_waveform_preserves_nulls_and_breaks(self):
        self.bind()
        self.cloud.add_job("waveform", start=10, end=20, max_points=200, _result_sha256=RESULT_HASH)
        self.assertEqual(self.worker.one()["status"], "completed")
        wave = self.cloud.finished[-1]["result"]["waveform"]
        self.assertIsNone(wave["points"][0][1])
        self.assertEqual(wave["break_before"], [[True], [True]])
        self.assertEqual(self.backend.numerics, 0)

    def test_waveform_bounds_reject_unbounded_requests(self):
        self.bind()
        self.cloud.add_job("waveform", start=0, end=50000, _result_sha256=RESULT_HASH)
        self.assertEqual(self.worker.one()["error_code"], "invalid_waveform_range")
        self.assertEqual(self.backend.waves, 0)

    def test_finish_rejection_does_not_mark_local_completion(self):
        job = self.cloud.add_job()
        self.cloud.finish_result = False
        self.assertEqual(self.worker.one()["error_code"], "publish_cancelled_or_changed")
        self.assertEqual(self.ledger.job(job["id"])["state"], "prepared")

    def test_binding_never_reassigns_owner_or_input(self):
        self.bind()
        changed = {**self.cloud.record, "user_id": uid()}
        with self.assertRaisesRegex(WorkerError, "immutable_binding_changed"):
            self.ledger.bind(changed, self.backend.local)

    def test_storage_path_must_match_owner_and_record(self):
        self.cloud.add_job()
        self.cloud.record["file_path"] = "someone-else/private.xlsx"
        self.assertEqual(self.worker.one()["error_code"], "record_file_path_mismatch")

    def test_missing_input_hash_is_not_guessed(self):
        self.cloud.add_job()
        self.cloud.record["input_sha256"] = None
        self.assertEqual(self.worker.one()["error_code"], "input_hash_required")

    def test_endpoint_only_accepts_supabase_https_origin(self):
        for url in ("http://x.supabase.co", "https://x.supabase.co.evil.invalid", "https://user@x.supabase.co", "https://x.supabase.co/path"):
            with self.subTest(url=url), self.assertRaises(WorkerError):
                SupabaseCloud(url, "x" * 32)

    def test_modern_secret_uses_apikey_without_bearer(self):
        class Response:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *unused): return False
            def read(self, unused): return b"{}"
        class Opener:
            request = None
            def open(self, request, timeout):
                self.request = request
                return Response()
        opener = Opener()
        secret = "sb_secret_" + "x" * 30
        cloud = SupabaseCloud("https://testproject.supabase.co", secret, opener=opener)
        cloud.request("GET", "/rest/v1/test")
        headers = {key.lower(): value for key, value in opener.request.header_items()}
        self.assertEqual(headers["apikey"], secret)
        self.assertNotIn("authorization", headers)

    def test_legacy_service_role_uses_apikey_and_bearer(self):
        class Response:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *unused): return False
            def read(self, unused): return b"{}"
        class Opener:
            request = None
            def open(self, request, timeout):
                self.request = request
                return Response()
        encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
        legacy = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode({"role": "service_role"}) + ".test-signature"
        opener = Opener()
        cloud = SupabaseCloud("https://testproject.supabase.co", legacy, opener=opener)
        cloud.request("GET", "/rest/v1/test")
        headers = {key.lower(): value for key, value in opener.request.header_items()}
        self.assertEqual(headers["apikey"], legacy)
        self.assertEqual(headers["authorization"], "Bearer " + legacy)

    def test_publishable_and_anon_credentials_are_rejected(self):
        encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
        anon = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode({"role": "anon"}) + ".test-signature"
        for value in ("sb_publishable_" + "x" * 30, anon, "x" * 30):
            with self.subTest(kind=value.split("_")[0]), self.assertRaisesRegex(WorkerError, "requires_secret"):
                SupabaseCloud("https://testproject.supabase.co", value)

    def test_modern_environment_key_takes_precedence(self):
        with patch.dict(os.environ, {"SUPABASE_URL": "https://testproject.supabase.co",
                                     "SUPABASE_SECRET_KEY": "sb_secret_" + "x" * 30,
                                     "SUPABASE_SERVICE_ROLE_KEY": "invalid-old-key"}):
            cloud = SupabaseCloud.from_environment()
            self.assertEqual(cloud.credential_kind, "secret")

    def test_request_cannot_override_authentication_headers(self):
        cloud = SupabaseCloud("https://testproject.supabase.co", "sb_secret_" + "x" * 30)
        with self.assertRaisesRegex(WorkerError, "override_refused"):
            cloud.request("GET", "/rest/v1/test", headers={"Authorization": "another-value"})

    def test_numeric_children_do_not_inherit_worker_keys(self):
        with patch.dict(os.environ, {"SUPABASE_SECRET_KEY": "test-modern",
                                     "SUPABASE_SERVICE_ROLE_KEY": "test-legacy"}):
            detach_worker_credentials()
            self.assertNotIn("SUPABASE_SECRET_KEY", os.environ)
            self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", os.environ)

    def test_hidden_fixture_password_updates_only_tracked_qa_user(self):
        import prepare_browser_qa as helper
        state = {"user_id": uid()}
        user = {"id": state["user_id"], "email": "disposable-test@example.invalid"}
        class Admin:
            calls = []
            def request(self, method, path, value):
                self.calls.append((method, path, value))
                return {"id": state["user_id"]}
        admin = Admin()
        password = secrets.token_urlsafe(32) + "Aa7!"
        with patch.object(helper, "require_state", return_value=(state, user)), patch.object(helper.getpass, "getpass", return_value=password):
            output = helper.set_password(admin)
        self.assertEqual(len(admin.calls), 1)
        self.assertEqual(admin.calls[0][0:2], ("PUT", "/auth/v1/admin/users/" + state["user_id"]))
        self.assertEqual(set(admin.calls[0][2]), {"password"})
        self.assertEqual(set(output), {"status", "user_id", "email"})

    def test_weak_fixture_password_does_not_call_admin(self):
        import prepare_browser_qa as helper
        state = {"user_id": uid()}
        admin = unittest.mock.Mock()
        with patch.object(helper, "require_state", return_value=(state, {})), patch.object(helper.getpass, "getpass", return_value="weak"):
            with self.assertRaisesRegex(WorkerError, "qa_password_requires"):
                helper.set_password(admin)
        admin.request.assert_not_called()

    def test_nonhidden_fixture_input_is_refused(self):
        import prepare_browser_qa as helper
        state = {"user_id": uid()}
        admin = unittest.mock.Mock()
        with patch.object(helper, "require_state", return_value=(state, {})), patch.object(helper.getpass, "getpass", side_effect=helper.getpass.GetPassWarning("unavailable")):
            with self.assertRaisesRegex(WorkerError, "hidden_password_input_unavailable"):
                helper.set_password(admin)
        admin.request.assert_not_called()

    def test_ai_requires_explicit_per_record_consent(self):
        self.bind()
        self.cloud.add_job("chat", question="Explain.", _result_sha256=RESULT_HASH, ai_consent=False)
        self.assertEqual(self.worker.one()["error_code"], "ai_consent_required")
        self.assertEqual(self.backend.chats, 0)

    def test_unknown_saved_provenance_never_becomes_live(self):
        report = stamp_report_source({"status": "ready", "model": "current-client-cannot-prove-source"},
                                     {"mode": "unknown", "provider_model": None, "report_sha256": "b" * 64})
        self.assertEqual(report["source"], "unknown")
        self.assertIsNone(report["provider_model"])
        self.assertIsNone(report["simulated"])

    def test_saved_simulated_marker_is_preserved(self):
        report = stamp_report_source({"status": "ready"},
                                     {"mode": "simulated", "provider_model": "OFFLINE_QA_STUB_NOT_DEEPSEEK", "report_sha256": "c" * 64})
        self.assertEqual(report["source"], "simulated")
        self.assertIs(report["simulated"], True)
        self.assertEqual(report["source_report_sha256"], "c" * 64)

    def test_second_process_lock_fails(self):
        path = Path(self.temp.name) / "worker.lock"
        with process_lock(path):
            with self.assertRaisesRegex(WorkerError, "another_worker"):
                with process_lock(path):
                    self.fail("Concurrent worker lock was acquired")


if __name__ == "__main__":
    unittest.main()
