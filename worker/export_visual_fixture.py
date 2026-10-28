"""Export only the known cached synthetic QA record for read-only visual QA."""
import hashlib
import json
from pathlib import Path
import sys

from breathmap_worker import DEFAULT_BACKEND_PROJECT, canonical, stamp_report_source


def main():
    project = DEFAULT_BACKEND_PROJECT
    backend = project / "app" / "breathmap-deepseek-20261024"
    sys.path.insert(0, str(backend))
    from result_reader import read_record_display, read_record_windows
    from result_presentation import present_display
    from waveform_reader import read_record_waveform
    root = project / "integration" / "local-workspace-20261027" / "qa-runtime" / "records"
    source_id = "e7757b93-540b-4319-8624-a3a2a9c25e94"
    known_hash = "88237b14ec805f516ef041dac422a8eac0158b7bca1212dd22778aef122f2db1"
    owner = "11111111-1111-4111-8111-111111111111"
    cloud_id = "22222222-2222-4222-8222-222222222222"
    folder = root / source_id
    tracked = (folder / "record.json", folder / "input.xlsx", folder / "analysis" / "result.json", folder / "analysis" / "waveform.csv", folder / "report.json")
    before = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in tracked}
    metadata = json.loads((folder / "record.json").read_text(encoding="utf-8"))
    assert metadata.get("input_sha256") == before[folder / "input.xlsx"] == known_hash
    assert metadata.get("local_identity") == "ISOLATED_BROWSER_QA_ONLY"
    assert metadata.get("qa_mode") == "SIMULATED_UI_DEVELOPMENT_CHECK_NOT_REAL_AI"

    class ReadOnlyService:
        def __init__(self):
            self.root = root
        def get_record(self, record_id):
            assert record_id == source_id
            return json.loads((folder / "record.json").read_text(encoding="utf-8"))

    service = ReadOnlyService()
    display = read_record_display(service, source_id)
    result_hash = display["source_result_sha256"]
    assert result_hash == before[folder / "analysis" / "result.json"]
    display["record_id"] = cloud_id
    display["record"].update(state="analysis_available", stage="done", report_status="not_requested")
    # Existing cached mock explanations are deliberately excluded. The fixture
    # exercises the missing-report UI, never fabricates a real provider response.
    display["report"] = stamp_report_source({"status": "absent", "reason_code": "offline_visual_qa_report_not_requested"}, None)
    display["presentation"] = present_display(display)
    windows = {}
    for kind in ("model", "statistics", "attention"):
        items, offset = [], 0
        while True:
            page = read_record_windows(service, source_id, kind, offset, 200, result_hash)
            items.extend(page["items"])
            if page["next_offset"] is None:
                windows[kind] = {**page, "record_id": cloud_id, "offset": 0,
                                 "limit": len(items), "items": items, "next_offset": None}
                break
            offset = page["next_offset"]
    extent = display["extent"]
    start, end = extent.get("analysis_start_s") or 0, extent.get("analysis_end_s") or extent["duration_s"]
    waveform = read_record_waveform(service, source_id, start, end, 5000)
    waveform["record_id"] = cloud_id
    manifest = {"schema": "breathmap-wave-manifest-1", "source_result_sha256": result_hash,
                "on_demand": True, "range": {"start_s": start, "end_s": end},
                "overview": {"bucket": "analysis-artifacts", "path": f"{owner}/{cloud_id}/{result_hash}/overview.json"}}
    summary = {"schema": "breathmap-web-summary-1", "metrics": display["presentation"]["cards"],
               "analysis": display["execution"], "report": display["report"],
               "versions": display["versions"], "extent": extent,
               "window_counts": display["window_counts"], "source_result_sha256": result_hash,
               "presentation": display["presentation"]}
    fixture = {"offlineQA": True,
               "source": {"label": "Known cached synthetic QA, sixty seconds", "input_sha256": known_hash,
                          "result_sha256": result_hash, "model_runs": 0, "ai_calls": 0, "cloud_calls": 0},
               "recording": {"id": cloud_id, "user_id": owner, "title": "SYNTHETIC Offline QA — 60 seconds",
                             "details": "Offline visual QA with previously saved synthetic numerical results.",
                             "notes": "Synthetic QA only. No participant data or live AI response.",
                             "recorded_at": "2026-10-28T01:00:00Z", "uploaded_at": "2026-10-28T01:00:00Z",
                             "trashed_at": None, "file_path": f"{owner}/{cloud_id}/input.xlsx",
                             "file_name": "SYNTHETIC Offline QA 60s.xlsx",
                             "file_size": (folder / "input.xlsx").stat().st_size, "input_sha256": known_hash},
               "display": display, "summary": summary, "windows": windows,
               "wave_manifest": manifest, "waveform": waveform, "result_sha256": result_hash}
    assert before == {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in tracked}
    output = Path(__file__).resolve().parents[1] / ".tmp" / "visual-fixture.json"
    output.parent.mkdir(exist_ok=True)
    output.write_bytes(canonical(fixture))
    print(json.dumps({"status": "exported", "offline_qa": True, "output": str(output),
                      "input_sha256": known_hash, "result_sha256": result_hash,
                      "model_runs": 0, "ai_calls": 0, "cloud_calls": 0,
                      "source_unchanged": True, "waveform_points": len(waveform["points"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
