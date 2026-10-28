"""Explicit synthetic-only offline verification against the existing real model.

Cloud I/O is replaced by an in-memory tape; AI is never enabled. Temporary
runtime files stay in a new workspace directory, not E:\\breathmap. The script
does not change the existing runtime configuration, model or source files.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

from breathmap_worker import DEFAULT_BACKEND_PROJECT, ExistingBackend, Ledger, Processor
import test_worker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-synthetic", action="store_true", required=True)
    args = parser.parse_args()
    project = DEFAULT_BACKEND_PROJECT
    backend_dir = project / "app" / "breathmap-deepseek-20261024"
    sys.path.insert(0, str(backend_dir))
    from runtime_sandbox import RuntimeSandbox
    fixture = backend_dir / "fixtures" / "synthetic-acquisition.xlsx"
    raw = fixture.read_bytes()
    test_worker.CONTENT = raw
    test_worker.INPUT_HASH = hashlib.sha256(raw).hexdigest()
    backend = ledger = None
    with tempfile.TemporaryDirectory(prefix=".synthetic-check-", dir=Path(__file__).resolve().parent) as folder:
        sandbox = RuntimeSandbox(Path(folder) / "runtime")
        try:
            with patch.object(RuntimeSandbox, "from_config", return_value=sandbox):
                backend = ExistingBackend(project)
            ledger = Ledger(Path(folder) / "ledger" / "worker.sqlite")
            cloud = test_worker.FakeCloud()
            cloud.add_job()
            outcome = Processor(cloud, backend, ledger).one()
            if outcome.get("status") != "completed":
                raise RuntimeError(outcome.get("error_code", "synthetic_check_failed"))
            published = cloud.finished[-1]["analysis"]
            display = published["display"]
            windows = published["windows"]
            assert display["source_result_sha256"] == published["result_sha256"]
            assert all(page["total"] is None or len(page["items"]) == page["total"] for page in windows.values())
            assert display["record_id"] == cloud.record["id"]
            assert published["wave_manifest"]["overview"] is not None
            overview = next(iter(cloud.artifacts.values()))
            assert overview["sampling"]["interpolation"] is False
            assert overview["sampling"]["returned_points"] <= 5000
            assert display["report"]["status"] != "ready"
            # Construct explicit local test reports with valid evidence/value
            # bindings. Their saved provenance, not the configured client label,
            # must determine whether the webpage may call them live.
            from grounding import project_result
            local_id = ledger.binding(cloud.record["id"])["local_id"]
            record_folder = backend.service._folder(local_id)
            result = backend.service._read_saved(record_folder / "analysis" / "result.json")
            projection = project_result(result)
            report = {
                "status": "ready", "language": "en", "model": None,
                "claims": [
                    {"text": "The saved analysis has usable outputs.", "evidence_ids": ["EXEC"],
                     "values": [{"evidence_id": "EXEC", "field": "status", "value": result["execution"]["status"]}]},
                    {"text": "The breathing rate comes from the saved result.", "evidence_ids": ["SUM"],
                     "values": [{"evidence_id": "SUM", "field": "frequency_bpm", "value": projection["evidence"]["SUM"]["values"]["frequency_bpm"]}]}],
                "evidence": projection["context"]["evidence"], "omitted": projection["omitted"],
                "verified_summary": projection["evidence"]["SUM"]["values"],
                "projection_sha256": projection["projection_sha256"]}
            backend.service._write_saved(record_folder / "report.json", report)
            backend.service._update(record_folder, report_status="ready", report_binding={
                "input_sha256": test_worker.INPUT_HASH, "result_sha256": published["result_sha256"],
                "projection_sha256": projection["projection_sha256"]})
            backend.service.client = SimpleNamespace(model="deepseek-flash")
            unknown = backend.display(local_id, cloud.record["id"])["report"]
            assert unknown["status"] == "ready" and unknown["source"] == "unknown"
            assert unknown["provider_model"] is None
            report["model"] = "OFFLINE_QA_STUB_NOT_DEEPSEEK"
            backend.service._write_saved(record_folder / "report.json", report)
            simulated = backend.display(local_id, cloud.record["id"])["report"]
            assert simulated["source"] == "simulated" and simulated["simulated"] is True
            assert simulated["provider_model"] == "OFFLINE_QA_STUB_NOT_DEEPSEEK"
            print(json.dumps({"status": "passed", "synthetic_only": True,
                              "cloud_calls": 0, "ai_calls": 0,
                              "input_sha256": test_worker.INPUT_HASH,
                              "execution": display["execution"],
                              "window_counts": display["window_counts"],
                              "overview_points": len(overview["points"]),
                              "unknown_report_not_marked_live": True,
                              "saved_simulated_report_preserved": True,
                              "result_schema": display["schema"]}, ensure_ascii=False, allow_nan=False))
        finally:
            if ledger:
                ledger.close()
            if backend:
                backend.close()


if __name__ == "__main__":
    main()
