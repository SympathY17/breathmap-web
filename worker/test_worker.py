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
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from breathmap_worker import Ledger, Processor, SupabaseCloud, WorkerError, canonical, process_lock, stamp_report_source, detach_worker_credentials


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
        self.events = []
        self.claimed, self.downloads = False, 0
        self.payload_override = None
        self.finish_result = True
        self.cancel_after_download = False
        self.artifact_error = False
        self.delete_error = False
        self.finish_error = False
        self.finish_response_lost = False
        self.on_artifact = None
        self.artifact_response_lost = False
        self.on_fence = None

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
        job = next(iter(self.jobs.values()))
        job["worker_id"] = worker_id
        return deepcopy(job)

    def running_jobs(self, worker_id):
        return [{"id": job["id"]} for job in self.jobs.values() if job.get("worker_id") == worker_id and job["status"] == "running"]

    def fence(self, job_id, worker_id):
        self.events.append(("fence", job_id))
        if self.on_fence:
            self.on_fence()
        job = self.jobs.get(job_id)
        if not job or job.get("worker_id") != worker_id:
            return None
        if job["status"] == "running":
            job["lease_token"] = uid()
        return deepcopy(job)

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
            raise WorkerError("cloud_http_403")
        self.artifacts[path] = value
        self.events.append(("upload", path))
        if self.on_artifact:
            self.on_artifact()
        if self.artifact_response_lost:
            raise WorkerError("cloud_network_unavailable")

    def delete_artifact(self, path):
        self.events.append(("delete", path))
        if self.delete_error:
            raise WorkerError("cloud_network_unavailable")
        self.artifacts.pop(path, None)

    def read_artifact(self, path):
        if path not in self.artifacts:
            raise WorkerError("cloud_http_404")
        return canonical(self.artifacts[path])

    def finish(self, job, result, *, analysis_result=None, error_code=None):
        self.events.append(("finish_error" if error_code else "finish", job["id"]))
        self.finished.append({"job": job["id"], "result": deepcopy(result),
                              "analysis": deepcopy(analysis_result), "error": error_code})
        if self.jobs[job["id"]].get("lease_token") != job["lease_token"]:
            return False
        if self.finish_error:
            raise WorkerError("cloud_network_unavailable")
        if self.finish_result:
            terminal = "interrupted" if error_code == "worker_restarted" else "failed" if error_code else "completed"
            self.jobs[job["id"]].update(status=terminal, result=deepcopy(result))
        if self.finish_response_lost:
            self.finish_response_lost = False
            raise WorkerError("cloud_network_unavailable")
        return self.finish_result


class FakeBackend:
    def __init__(self):
        self.creates = self.numerics = self.reports = self.chats = self.waves = 0
        self.local = uid()
        self.report_error = False
        self.report_state = "absent"
        self.on_numeric = None
        self.metadata = {self.local: {"state": "analysis_available", "analysis_available": True,
                                    "analysis_execution": {"status": "partial"}}}
        self.on_validate = None

    def create(self, content):
        self.creates += 1
        local_id = uid()
        self.metadata[local_id] = {"state": "uploaded", "analysis_available": False,
                                   "analysis_execution": {"status": "partial"}}
        return local_id

    def verify(self, local_id, expected):
        if local_id not in self.metadata or expected != INPUT_HASH:
            raise WorkerError("local_input_changed")
        return {**deepcopy(self.metadata[local_id]), "analysis_binding": {"result_sha256": RESULT_HASH}}

    def numeric(self, local_id):
        if self.metadata[local_id]["analysis_available"]:
            return
        self.numerics += 1
        self.metadata[local_id].update(state="analysis_available", analysis_available=True)
        if self.on_numeric:
            self.on_numeric()

    def needs_fresh_numeric(self, local_id, metadata):
        if metadata["analysis_available"]:
            return metadata["analysis_execution"]["status"] in {"error", "unable_to_analyze"}
        return metadata["state"] in {"interrupted", "failed"}

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
                "execution": deepcopy(self.metadata[local_id]["analysis_execution"]), "report": {"status": self.report_state},
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
        if self.on_validate:
            self.on_validate()
        if expected_hash != RESULT_HASH:
            raise WorkerError("local_result_changed")


class CleanupCloud:
    def __init__(self, owner, record_ids, job_ids, foreign_owner, *, pending=False):
        self.owner, self.record_ids, self.job_ids = owner, record_ids, job_ids
        self.deleted, self.pending = False, pending
        self.requests = []
        self.files = {
            "recordings": {f"{owner}/{rid}/input.xlsx" for rid in record_ids} | {f"{foreign_owner}/foreign/input.xlsx"},
            "analysis-artifacts": {f"{owner}/{rid}/{RESULT_HASH}/overview.json" for rid in record_ids} | {f"{foreign_owner}/foreign/{RESULT_HASH}/overview.json"}}
    def request(self, method, path, value=None):
        self.requests.append((method, path))
        if method == "POST" and path.startswith("/storage/v1/object/list/"):
            bucket = path.rsplit("/", 1)[-1]
            prefix = value["prefix"] + "/"
            children = {}
            for item in self.files[bucket]:
                if item.startswith(prefix):
                    tail = item[len(prefix):]
                    name, slash, unused = tail.partition("/")
                    children[name] = {"name": name, "id": None if slash else "object-id"}
            return [children[name] for name in sorted(children)][value["offset"]:value["offset"] + value["limit"]]
        if method == "DELETE" and path.startswith("/storage/v1/object/"):
            bucket = path.rsplit("/", 1)[-1]
            for item in value["prefixes"]:
                assert item.startswith(self.owner + "/")
                self.files[bucket].discard(item)
            return []
        if path.startswith("/auth/v1/admin/users/"):
            assert path.endswith(self.owner)
            if method == "DELETE":
                self.deleted = True
                return {}
            if self.deleted:
                raise WorkerError("cloud_http_404")
        table = urlsplit(path).path.rsplit("/", 1)[-1]
        if method == "GET" and table == "analysis_jobs" and not self.deleted:
            return [{"id": job, "status": "queued" if self.pending else "completed"} for job in self.job_ids]
        if method == "GET" and table == "recordings" and not self.deleted:
            return [{"id": record} for record in self.record_ids]
        if method == "GET" and self.deleted:
            return []
        raise AssertionError("Unexpected cleanup request")


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
        self.bind()
        job = self.cloud.add_job()
        self.ledger.save_job(job, "prepared", {"analysis_status": "success"}, {"result_sha256": RESULT_HASH, "display": self.backend.display(self.backend.local, self.cloud.record["id"])})
        self.worker.execute(deepcopy(job))
        self.assertEqual((self.backend.numerics, self.backend.reports, self.cloud.downloads), (0, 0, 0))

    def test_prepared_publication_revalidates_saved_result_before_rpc(self):
        self.bind()
        job = self.cloud.add_job()
        self.ledger.save_job(job, "prepared", {"result_sha256": RESULT_HASH}, {"result_sha256": RESULT_HASH, "display": self.backend.display(self.backend.local, self.cloud.record["id"])})
        def invalid():
            raise WorkerError("local_result_changed")
        self.backend.on_validate = invalid
        self.assertEqual(self.worker.one()["error_code"], "local_result_changed")
        self.assertTrue(all(item["error"] is not None for item in self.cloud.finished))
        self.assertEqual((self.backend.numerics, self.backend.reports), (0, 0))

    def test_completed_job_is_never_executed_twice(self):
        job = self.cloud.add_job()
        self.worker.execute(deepcopy(job))
        self.cloud.jobs[job["id"]]["status"] = "running"  # An erroneous duplicate claim is still refused locally.
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
        self.assertEqual(self.ledger.job(job["id"])["state"], "failed")
        self.assertFalse(self.cloud.artifacts)

    def test_newly_uploaded_overview_is_removed_before_cancelled_job_is_terminal(self):
        self.cloud.add_job()
        self.cloud.on_artifact = lambda: self.cloud.record.update(trashed_at="2026-10-28T00:00:00Z")
        self.assertEqual(self.worker.one()["error_code"], "record_unavailable")
        self.assertFalse(self.cloud.artifacts)
        names = [event[0] for event in self.cloud.events]
        self.assertLess(names.index("delete"), names.index("finish_error"))

    def test_exact_rollback_preserves_previously_published_overview(self):
        previous = self.cloud.record["user_id"] + "/" + self.cloud.record["id"] + "/" + RESULT_HASH + "/overview.json"
        self.cloud.artifacts[previous] = {"previous": True}
        self.cloud.add_job()
        self.cloud.on_artifact = lambda: self.cloud.record.update(user_id=uid())
        self.assertEqual(self.worker.one()["error_code"], "record_unavailable")
        self.assertEqual(self.cloud.artifacts, {previous: {"previous": True}})

    def test_lease_change_after_upload_rolls_back_before_error_finish(self):
        job = self.cloud.add_job()
        self.cloud.on_artifact = lambda: self.cloud.jobs[job["id"]].update(lease_token=uid())
        self.assertEqual(self.worker.one()["error_code"], "job_cancelled_or_changed")
        self.assertFalse(self.cloud.artifacts)
        self.assertEqual([name for name, unused in self.cloud.events], ["upload", "delete", "finish_error"])

    def test_local_result_invalidation_after_upload_rolls_back(self):
        self.cloud.add_job()
        def changed():
            raise WorkerError("local_result_changed")
        self.backend.on_validate = changed
        self.assertEqual(self.worker.one()["error_code"], "local_result_changed")
        self.assertFalse(self.cloud.artifacts)
        self.assertEqual([name for name, unused in self.cloud.events], ["upload", "delete", "finish_error"])

    def test_definite_finish_rejection_rolls_back_before_terminal_error_finish(self):
        self.cloud.add_job()
        self.cloud.finish_result = False
        self.worker.one()
        self.assertEqual([name for name, unused in self.cloud.events], ["upload", "finish", "delete", "finish_error"])

    def test_failed_cleanup_keeps_journal_and_never_marks_job_terminal(self):
        job = self.cloud.add_job()
        self.cloud.finish_result = False
        self.cloud.delete_error = True
        self.assertEqual(self.worker.one()["error_code"], "artifact_cleanup_pending")
        self.assertEqual(self.ledger.job(job["id"])["state"], "prepared")
        self.assertTrue(self.ledger.artifacts(job["id"]))
        self.assertTrue(self.worker.stop.is_set())
        self.assertNotIn("finish_error", [name for name, unused in self.cloud.events])
        self.cloud.delete_error = False
        self.cloud.finish_result = True
        self.worker.reconcile_artifacts()
        self.assertFalse(self.cloud.artifacts)
        self.assertFalse(self.ledger.artifacts(job["id"]))

    def test_lost_finish_response_preserves_then_reconciles_committed_object(self):
        job = self.cloud.add_job()
        self.cloud.finish_response_lost = True
        self.assertEqual(self.worker.one()["error_code"], "publication_outcome_unknown")
        self.assertEqual(self.cloud.jobs[job["id"]]["status"], "completed")
        self.assertEqual(self.ledger.job(job["id"])["state"], "prepared")
        self.assertTrue(self.cloud.artifacts)
        self.assertTrue(self.worker.stop.is_set())
        self.worker.reconcile_artifacts()
        self.assertEqual(self.ledger.job(job["id"])["state"], "completed")
        self.assertTrue(self.cloud.artifacts)
        self.assertFalse(self.ledger.artifacts(job["id"]))
        self.assertEqual(self.backend.numerics, 1)

    def test_uncommitted_network_publication_rolls_back_on_recovery(self):
        job = self.cloud.add_job()
        self.cloud.finish_error = True
        self.assertEqual(self.worker.one()["error_code"], "publication_outcome_unknown")
        self.assertTrue(self.cloud.artifacts)
        self.cloud.finish_error = False
        self.worker.reconcile_artifacts()
        self.assertFalse(self.cloud.artifacts)
        self.assertEqual(self.backend.numerics, 1)

    def test_lost_upload_response_keeps_running_until_matching_complete_readback(self):
        job = self.cloud.add_job()
        self.cloud.artifact_response_lost = True
        self.assertEqual(self.worker.one()["error_code"], "artifact_upload_outcome_unresolved")
        self.assertTrue(self.worker.stop.is_set())
        self.assertEqual(self.cloud.jobs[job["id"]]["status"], "running")
        self.assertFalse(self.cloud.finished)
        self.assertTrue(self.cloud.artifacts)
        self.assertEqual(self.ledger.artifacts(job["id"])[0]["state"], "pending")
        self.worker.reconcile_artifacts()
        self.assertFalse(self.cloud.artifacts)
        self.assertEqual(self.cloud.jobs[job["id"]]["status"], "interrupted")
        self.assertEqual(self.backend.numerics, 1)

    def test_missing_ambiguous_upload_never_releases_running_deletion_gate(self):
        job = self.cloud.add_job()
        def request_still_in_flight(path, value):
            raise WorkerError("cloud_network_unavailable")
        self.cloud.artifact = request_still_in_flight
        self.assertEqual(self.worker.one()["error_code"], "artifact_upload_outcome_unresolved")
        with self.assertRaisesRegex(WorkerError, "artifact_upload_outcome_unresolved"):
            self.worker.reconcile_artifacts()
        self.assertEqual(self.cloud.jobs[job["id"]]["status"], "running")
        self.assertTrue(self.ledger.artifacts(job["id"]))
        self.assertFalse(self.cloud.finished)

    def test_mismatched_ambiguous_upload_never_deletes_or_releases_job(self):
        job = self.cloud.add_job()
        self.cloud.artifact_response_lost = True
        self.worker.one()
        path = self.ledger.artifacts(job["id"])[0]["path"]
        self.cloud.artifacts[path] = {"unexpected": "bytes"}
        with self.assertRaisesRegex(WorkerError, "artifact_upload_content_unverified"):
            self.worker.reconcile_artifacts()
        self.assertEqual(self.cloud.jobs[job["id"]]["status"], "running")
        self.assertIn(path, self.cloud.artifacts)
        self.assertFalse(self.cloud.finished)

    def test_numeric_plus_report_uploads_each_job_owned_object_only_once(self):
        self.cloud.add_job(generate_report=True, ai_consent=True)
        self.assertEqual(self.worker.one()["status"], "completed")
        self.assertEqual(len([event for event in self.cloud.events if event[0] == "upload"]), 1)
        self.assertEqual((self.backend.numerics, self.backend.reports), (1, 1))

    def test_cleanup_failure_during_invalidation_stops_before_any_terminal_finish(self):
        job = self.cloud.add_job()
        self.cloud.on_artifact = lambda: self.cloud.record.update(deletion_started_at="2026-10-28T00:00:00Z")
        self.cloud.delete_error = True
        self.assertEqual(self.worker.one()["error_code"], "artifact_cleanup_pending")
        self.assertTrue(self.worker.stop.is_set())
        self.assertTrue(self.ledger.artifacts(job["id"]))
        self.assertEqual(self.ledger.job(job["id"])["state"], "running")
        self.assertFalse(self.cloud.finished)

    def test_tombstoned_record_is_refused_before_download(self):
        self.cloud.add_job()
        self.cloud.record["deletion_started_at"] = "2026-10-28T00:00:00Z"
        self.assertEqual(self.worker.one()["error_code"], "record_unavailable")
        self.assertEqual(self.cloud.downloads, 0)

    def test_explicit_new_job_retries_unusable_result_in_fresh_local_attempt(self):
        self.bind()
        previous = self.backend.local
        self.backend.metadata[previous]["analysis_execution"]["status"] = "unable_to_analyze"
        job = self.cloud.add_job()
        self.assertEqual(self.worker.one()["status"], "completed")
        attempt = self.ledger.attempt(job["id"])
        self.assertNotEqual(attempt["local_id"], previous)
        self.assertIn(previous, self.backend.metadata)
        self.assertEqual(self.ledger.binding(self.cloud.record["id"])["local_id"], attempt["local_id"])
        self.assertEqual((self.backend.creates, self.backend.numerics), (1, 1))

    def test_explicit_retry_of_interrupted_no_output_creates_fresh_attempt(self):
        self.ledger.bind(self.cloud.record, self.backend.local)
        self.backend.metadata[self.backend.local].update(state="interrupted", analysis_available=False)
        self.cloud.add_job()
        self.assertEqual(self.worker.one()["status"], "completed")
        self.assertNotEqual(self.ledger.binding(self.cloud.record["id"])["local_id"], self.backend.local)
        self.assertEqual(self.backend.numerics, 1)

    def test_successful_cached_numeric_is_never_recalculated(self):
        self.bind()
        self.cloud.add_job()
        self.assertEqual(self.worker.one()["status"], "completed")
        self.assertEqual((self.backend.creates, self.backend.numerics, self.cloud.downloads), (0, 0, 0))

    def test_rejected_retry_does_not_replace_previous_binding(self):
        self.bind()
        self.backend.metadata[self.backend.local]["analysis_execution"]["status"] = "error"
        job = self.cloud.add_job()
        self.cloud.finish_result = False
        self.worker.one()
        self.assertEqual(self.ledger.binding(self.cloud.record["id"])["local_id"], self.backend.local)
        self.assertNotEqual(self.ledger.attempt(job["id"])["local_id"], self.backend.local)
        self.assertFalse(self.cloud.artifacts)

    def test_lost_retry_commit_promotes_fresh_attempt_only_after_reconciliation(self):
        self.bind()
        self.backend.metadata[self.backend.local]["analysis_execution"]["status"] = "error"
        job = self.cloud.add_job()
        self.cloud.finish_response_lost = True
        self.worker.one()
        self.assertEqual(self.ledger.binding(self.cloud.record["id"])["local_id"], self.backend.local)
        self.worker.reconcile_artifacts()
        self.assertEqual(self.ledger.binding(self.cloud.record["id"])["local_id"], self.ledger.attempt(job["id"])["local_id"])
        self.assertEqual(self.backend.numerics, 1)

    def test_same_job_attempt_mapping_cannot_change_or_recompute(self):
        job = self.cloud.add_job()
        self.ledger.save_job(job, "running")
        local_id = self.worker.local_record(job, self.cloud.record)
        self.assertEqual(self.worker.local_record(job, self.cloud.record), local_id)
        self.assertEqual(self.backend.creates, 1)
        with self.assertRaisesRegex(WorkerError, "immutable_attempt"):
            self.ledger.save_attempt(job, self.cloud.record, uid())
        self.assertEqual(self.backend.numerics, 0)

    def test_recovery_marks_noncommitted_prepared_job_interrupted_without_rerun(self):
        job = self.cloud.add_job()
        self.cloud.finish_error = True
        self.worker.one()
        self.cloud.finish_error = False
        self.cloud.jobs[job["id"]]["status"] = "interrupted"
        self.worker.reconcile_artifacts()
        self.assertEqual(self.ledger.job(job["id"])["state"], "interrupted")
        self.assertFalse(self.cloud.artifacts)
        self.assertEqual(self.backend.numerics, 1)

    def test_finish_winning_server_lock_before_fence_preserves_published_object(self):
        job = self.cloud.add_job()
        self.cloud.finish_error = True
        self.worker.one()
        prior = self.ledger.job(job["id"])
        old_request = deepcopy(self.cloud.jobs[job["id"]])
        def finish_wins_lock():
            self.cloud.on_fence = None
            self.cloud.finish_error = False
            self.cloud.finish(old_request, json.loads(prior["result_json"]), analysis_result=json.loads(prior["analysis_json"]))
        self.cloud.on_fence = finish_wins_lock
        self.worker.reconcile_artifacts()
        self.assertEqual(self.cloud.jobs[job["id"]]["status"], "completed")
        self.assertTrue(self.cloud.artifacts)
        self.assertEqual(self.ledger.job(job["id"])["state"], "completed")
        self.assertNotIn("delete", [name for name, unused in self.cloud.events])

    def test_fence_winning_server_lock_rejects_old_finish_before_cleanup(self):
        job = self.cloud.add_job()
        self.cloud.finish_error = True
        self.worker.one()
        self.cloud.finish_error = False
        old_request = deepcopy(self.cloud.jobs[job["id"]])
        self.cloud.events.clear()
        self.worker.reconcile_artifacts()
        self.assertEqual([name for name, unused in self.cloud.events], ["fence", "delete", "finish_error"])
        self.assertEqual(self.cloud.jobs[job["id"]]["status"], "interrupted")
        self.assertFalse(self.cloud.finish(old_request, {"result_sha256": RESULT_HASH}))
        self.assertFalse(self.cloud.artifacts)

    def test_claim_before_local_ledger_crash_is_fenced_and_finished(self):
        job = self.cloud.add_job()
        self.cloud.claim(self.ledger.worker_id)
        self.assertIsNone(self.ledger.job(job["id"]))
        self.worker.reconcile_artifacts()
        self.assertEqual(self.cloud.jobs[job["id"]]["status"], "interrupted")
        self.assertEqual(self.ledger.job(job["id"])["state"], "interrupted")
        self.assertEqual((self.backend.creates, self.backend.numerics), (0, 0))

    def test_foreign_worker_reassignment_keeps_unresolved_journal_object(self):
        job = self.cloud.add_job()
        self.cloud.finish_error = True
        self.worker.one()
        self.cloud.jobs[job["id"]]["worker_id"] = uid()
        with self.assertRaisesRegex(WorkerError, "publication_reconciliation_required"):
            self.worker.reconcile_artifacts()
        self.assertTrue(self.cloud.artifacts)
        self.assertTrue(self.ledger.artifacts(job["id"]))

    def test_confirmed_missing_cloud_job_allows_exact_journal_cleanup(self):
        job = self.cloud.add_job()
        self.cloud.finish_error = True
        self.worker.one()
        del self.cloud.jobs[job["id"]]
        self.worker.reconcile_artifacts()
        self.assertFalse(self.cloud.artifacts)
        self.assertEqual(self.ledger.job(job["id"])["state"], "interrupted")

    def test_unfenced_queued_state_never_deletes_unresolved_object(self):
        job = self.cloud.add_job()
        self.cloud.finish_error = True
        self.worker.one()
        self.cloud.jobs[job["id"]]["status"] = "queued"
        with self.assertRaisesRegex(WorkerError, "cloud_fence_contract"):
            self.worker.reconcile_artifacts()
        self.assertTrue(self.cloud.artifacts)

    def test_failed_job_identity_cannot_be_reused_for_a_second_attempt(self):
        job = self.cloud.add_job()
        self.ledger.save_job(job, "failed", error_code="previous_attempt_failed")
        with self.assertRaisesRegex(WorkerError, "job_already_executed"):
            self.worker.execute(job)
        self.assertEqual((self.backend.creates, self.backend.numerics), (0, 0))

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

    def test_running_recovery_uses_bounded_cursor_pages_not_mutating_offsets(self):
        cloud = SupabaseCloud("https://testproject.supabase.co", "sb_secret_" + "x" * 30)
        ids = sorted(uid() for unused in range(101))
        with patch.object(cloud, "request", side_effect=[[{"id": value} for value in ids[:100]], [{"id": ids[-1]}]]) as request:
            self.assertEqual([row["id"] for row in cloud.running_jobs(self.ledger.worker_id)], ids)
        query = parse_qs(urlsplit(request.call_args_list[1].args[1]).query)
        self.assertEqual(query["id"], ["gt." + ids[99]])
        self.assertNotIn("offset", query)

    def test_running_recovery_refuses_nonprogressing_page(self):
        cloud = SupabaseCloud("https://testproject.supabase.co", "sb_secret_" + "x" * 30)
        ids = sorted(uid() for unused in range(100))
        page = [{"id": value} for value in ids]
        with patch.object(cloud, "request", side_effect=[page, page]), self.assertRaisesRegex(WorkerError, "cloud_recovery_contract"):
            cloud.running_jobs(self.ledger.worker_id)

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

    def test_browser_cleanup_removes_all_test_records_files_and_aliases_only(self):
        import prepare_browser_qa as helper
        owner, foreign = uid(), uid()
        record_ids, job_ids = [uid(), uid()], [uid(), uid()]
        for record_id in record_ids:
            self.ledger.bind({"id": record_id, "user_id": owner, "input_sha256": INPUT_HASH}, uid(), RESULT_HASH)
        foreign_record, foreign_job = uid(), uid()
        self.ledger.bind({"id": foreign_record, "user_id": foreign, "input_sha256": INPUT_HASH}, uid(), RESULT_HASH)
        for job_id in [*job_ids, foreign_job]:
            self.ledger.save_job({"id": job_id, "operation": "analyse"}, "completed")
        for record_id, job_id, scoped_owner in [*[(record_id, job_id, owner) for record_id, job_id in zip(record_ids, job_ids)], (foreign_record, foreign_job, foreign)]:
            self.ledger.save_attempt({"id": job_id}, {"id": record_id, "user_id": scoped_owner, "input_sha256": INPUT_HASH}, uid())
            self.ledger.artifact_write(job_id, f"{scoped_owner}/{record_id}/{RESULT_HASH}/overview-{job_id}.json", "published", INPUT_HASH)
        state = {"user_id": owner, "recording_id": record_ids[0], "source_local_id": uid()}
        cloud = CleanupCloud(owner, record_ids, job_ids, foreign)
        with patch.object(helper, "require_state", return_value=(state, {})), patch.object(helper, "LOCAL_LEDGER", self.ledger.path), patch.object(helper, "save_state"):
            output = helper.cleanup(cloud)
        self.assertEqual(output["recordings_removed"], 2)
        self.assertEqual(output["storage_objects_removed"], 4)
        self.assertEqual(output["local_aliases_removed"], 2)
        self.assertEqual(output["local_job_entries_removed"], 2)
        self.assertEqual(output["local_attempt_entries_removed"], 2)
        self.assertEqual(output["local_artifact_entries_removed"], 2)
        self.assertTrue(all(value == 0 for value in output["cloud_counts"].values()))
        self.assertTrue(output["source_local_artifacts_retained"])
        for record_id in record_ids:
            self.assertIsNone(self.ledger.binding(record_id))
        for job_id in job_ids:
            self.assertIsNone(self.ledger.job(job_id))
            self.assertIsNone(self.ledger.attempt(job_id))
            self.assertEqual(self.ledger.db.execute("SELECT count(*) FROM artifact_writes WHERE job_id=?", (job_id,)).fetchone()[0], 0)
        self.assertIsNotNone(self.ledger.binding(foreign_record))
        self.assertIsNotNone(self.ledger.job(foreign_job))
        self.assertIsNotNone(self.ledger.attempt(foreign_job))
        self.assertEqual(self.ledger.db.execute("SELECT count(*) FROM artifact_writes WHERE job_id=?", (foreign_job,)).fetchone()[0], 1)
        self.assertFalse(self.ledger.db.execute("PRAGMA foreign_key_check").fetchall())
        self.assertTrue(all(len(paths) == 1 and next(iter(paths)).startswith(foreign + "/") for paths in cloud.files.values()))

    def test_browser_cleanup_removes_local_attempt_and_report_for_ui_deleted_cloud_jobs(self):
        import prepare_browser_qa as helper
        owner, foreign, deleted_record = uid(), uid(), uid()
        numeric_job, report_job = uid(), uid()
        for job_id, operation in ((numeric_job, "analyse"), (report_job, "report")):
            self.ledger.save_job({"id": job_id, "operation": operation}, "completed")
            self.ledger.artifact_write(job_id, f"{owner}/{deleted_record}/{RESULT_HASH}/overview-{job_id}.json", "published", INPUT_HASH)
        self.ledger.save_attempt({"id": numeric_job}, {"id": deleted_record, "user_id": owner, "input_sha256": INPUT_HASH}, uid())
        cloud = CleanupCloud(owner, [], [], foreign)
        with patch.object(helper, "require_state", return_value=({"user_id": owner}, {})), patch.object(helper, "LOCAL_LEDGER", self.ledger.path), patch.object(helper, "save_state"):
            output = helper.cleanup(cloud)
        self.assertEqual(output["recordings_removed"], 0)
        self.assertEqual(output["local_job_entries_removed"], 2)
        self.assertEqual(output["local_attempt_entries_removed"], 1)
        self.assertEqual(output["local_artifact_entries_removed"], 2)
        self.assertIsNone(self.ledger.job(numeric_job))
        self.assertIsNone(self.ledger.job(report_job))
        self.assertIsNone(self.ledger.attempt(numeric_job))
        self.assertFalse(self.ledger.db.execute("SELECT * FROM artifact_writes").fetchall())

    def test_browser_cleanup_removes_only_owned_children_orphaned_by_old_fk_off_helper(self):
        import prepare_browser_qa as helper
        owner, foreign, record_id, job_id = uid(), uid(), uid(), uid()
        self.ledger.save_job({"id": job_id, "operation": "analyse"}, "completed")
        self.ledger.save_attempt({"id": job_id}, {"id": record_id, "user_id": owner, "input_sha256": INPUT_HASH}, uid())
        self.ledger.artifact_write(job_id, f"{owner}/{record_id}/{RESULT_HASH}/overview-{job_id}.json", "published", INPUT_HASH)
        self.ledger.db.execute("PRAGMA foreign_keys=OFF")
        self.ledger.db.execute("DELETE FROM jobs WHERE job_id=?", (job_id,))
        self.ledger.db.commit()
        self.ledger.db.execute("PRAGMA foreign_keys=ON")
        self.assertTrue(self.ledger.db.execute("PRAGMA foreign_key_check").fetchall())
        cloud = CleanupCloud(owner, [], [], foreign)
        with patch.object(helper, "require_state", return_value=({"user_id": owner}, {})), patch.object(helper, "LOCAL_LEDGER", self.ledger.path), patch.object(helper, "save_state"):
            output = helper.cleanup(cloud)
        self.assertEqual(output["local_job_entries_removed"], 0)
        self.assertEqual(output["local_attempt_entries_removed"], 1)
        self.assertEqual(output["local_artifact_entries_removed"], 1)
        self.assertFalse(self.ledger.db.execute("PRAGMA foreign_key_check").fetchall())

    def test_browser_cleanup_rejects_foreign_attempt_or_journal_before_cloud_deletion(self):
        import prepare_browser_qa as helper
        for foreign_link in ("attempt", "journal"):
            with self.subTest(foreign_link=foreign_link):
                owner, foreign, record_id, job_id = uid(), uid(), uid(), uid()
                self.ledger.save_job({"id": job_id, "operation": "analyse"}, "completed")
                if foreign_link == "attempt":
                    self.ledger.save_attempt({"id": job_id}, {"id": record_id, "user_id": foreign, "input_sha256": INPUT_HASH}, uid())
                else:
                    self.ledger.artifact_write(job_id, f"{foreign}/{record_id}/{RESULT_HASH}/overview-{job_id}.json", "published", INPUT_HASH)
                cloud = CleanupCloud(owner, [record_id], [job_id], foreign)
                with patch.object(helper, "require_state", return_value=({"user_id": owner}, {})), patch.object(helper, "LOCAL_LEDGER", self.ledger.path), patch.object(helper, "save_state"):
                    with self.assertRaisesRegex(WorkerError, "browser_qa_local_scope_changed"):
                        helper.cleanup(cloud)
                self.assertFalse(cloud.deleted)
                self.assertFalse(any(method == "DELETE" for method, path in cloud.requests))
                self.assertIsNotNone(self.ledger.job(job_id))

    def test_browser_cleanup_refuses_pending_work_before_any_delete(self):
        import prepare_browser_qa as helper
        owner, foreign = uid(), uid()
        cloud = CleanupCloud(owner, [uid(), uid()], [uid()], foreign, pending=True)
        with patch.object(helper, "require_state", return_value=({"user_id": owner}, {})), patch.object(helper, "save_state"):
            with self.assertRaisesRegex(WorkerError, "jobs_must_finish"):
                helper.cleanup(cloud)
        self.assertFalse(cloud.deleted)
        self.assertFalse(any(method == "DELETE" for method, path in cloud.requests))

    def test_browser_cleanup_refuses_manual_retention_before_cloud_or_local_mutation(self):
        import prepare_browser_qa as helper
        owner, foreign = uid(), uid()
        cloud = CleanupCloud(owner, [uid()], [uid()], foreign)
        state = {"user_id": owner, "manual_retention_requested": {"reason": "User retained fixtures for manual acceptance"}}
        with patch.object(helper, "require_state", return_value=(state, {})), patch.object(helper, "save_state") as saved:
            with self.assertRaisesRegex(WorkerError, "browser_qa_manual_retention_requested"):
                helper.cleanup(cloud)
        self.assertFalse(cloud.requests)
        self.assertFalse(cloud.deleted)
        saved.assert_not_called()

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
