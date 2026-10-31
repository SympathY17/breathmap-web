"""Assistant adapter tests with synthetic jobs; no network, engine or paid AI."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from breathmap_worker import Ledger, Processor, SupabaseCloud, WorkerError
from test_worker import FakeBackend, FakeCloud, RESULT_HASH, uid


class ContextBackend(FakeBackend):
    def __init__(self):
        super().__init__()
        self.questions = []
        self.changed_after_chat = False

    def chat(self, local_id, question, language):
        self.questions.append(question)
        answer = super().chat(local_id, question, language)
        return answer

    def display(self, local_id, cloud_id):
        display = super().display(local_id, cloud_id)
        if self.changed_after_chat and self.chats:
            display["source_result_sha256"] = "f" * 64
        return display

    def windows(self, local_id, cloud_id, result_hash):
        return {kind: {"source_result_sha256": result_hash, "items": [
            {"window_id": kind + "-01", "start_s": 10, "end_s": 26}
        ]} for kind in ("model", "statistics", "attention")}


class AssistantContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".assistant-test-", dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "state" / "worker.sqlite")
        self.addCleanup(self.ledger.close)
        self.cloud, self.backend = FakeCloud(), ContextBackend()
        self.processor = Processor(self.cloud, self.backend, self.ledger)
        self.ledger.bind(self.cloud.record, self.backend.local, RESULT_HASH)
        self.conversation = uid()
        self.sequence = 0

    def job(self, question="Explain this selection.", selection=None, previous=None):
        context = {"version": 1, "conversation_id": self.conversation}
        if selection is not None:
            context["selection"] = selection
        if previous:
            context["previous_job_id"] = previous["id"]
        self.sequence += 1
        job = self.cloud.add_job("chat", question=question, _result_sha256=RESULT_HASH, assistant_context=context)
        job["created_at"] = f"2026-10-31T10:00:{self.sequence * 2:02d}+00:00"
        return job

    def finish(self, job):
        result = self.processor.execute(job)
        second = int(job["created_at"][17:19]) + 1
        job.update(status="completed", result_sha256=RESULT_HASH, result=deepcopy(result),
                   finished_at=f"2026-10-31T10:00:{second:02d}+00:00")
        return result

    def rejected(self, job, code):
        before = self.backend.chats
        with self.assertRaises(WorkerError) as error:
            self.processor.execute(job)
        self.assertEqual(error.exception.code, code)
        self.assertEqual(self.backend.chats, before)

    def test_legacy_question_is_unmodified_and_has_no_context_receipt(self):
        job = self.cloud.add_job("chat", question="a" * 2000, _result_sha256=RESULT_HASH)
        result = self.processor.execute(job)
        self.assertEqual(self.backend.questions, ["a" * 2000])
        self.assertNotIn("assistant_context", result)

    def test_range_and_question_reach_engine_with_receipt(self):
        job = self.job(selection={"start_s": 12.5, "end_s": 27})
        result = self.finish(job)
        prompt = json.loads(self.backend.questions[-1].split("\n", 1)[1])
        self.assertEqual(prompt["current_question"], job["payload"]["question"])
        self.assertEqual(prompt["selection"], {"start_s": 12.5, "end_s": 27})
        self.assertEqual(result["assistant_context"]["history_job_ids"], [])
        self.assertEqual(result["assistant_context"]["conversation_id"], self.conversation)
        self.assertEqual(self.backend.numerics, 0)

    def test_named_window_is_checked_against_saved_result(self):
        selection = {"start_s": 10, "end_s": 26, "window_id": "model-01", "kind": "model"}
        result = self.finish(self.job(selection=selection))
        self.assertEqual(result["assistant_context"]["selection"], selection)

    def test_tampered_window_range_or_id_is_rejected(self):
        for selection in [
            {"start_s": 10, "end_s": 27, "window_id": "model-01", "kind": "model"},
            {"start_s": 10, "end_s": 26, "window_id": "missing", "kind": "model"},
        ]:
            with self.subTest(selection=selection):
                self.rejected(self.job(selection=selection), "assistant_window_mismatch")

    def test_missing_or_invalid_selection_fields_are_rejected(self):
        for selection in [
            {"start_s": 1}, {"start_s": -1, "end_s": 12}, {"start_s": 12, "end_s": 12},
            {"start_s": True, "end_s": 12}, {"start_s": 1, "end_s": float("nan")},
            {"start_s": 1, "end_s": float("inf")}, {"start_s": 1, "end_s": 80},
            {"start_s": 1, "end_s": 10, "kind": "invented"},
            {"start_s": 1, "end_s": 10, "kind": []},
            {"start_s": 1, "end_s": 10 ** 900},
            {"start_s": 1, "end_s": 10, "window_id": "without-kind"},
            {"start_s": 1, "end_s": 10, "kind": "model", "window_id": "bad\nwindow"},
            {"start_s": 1, "end_s": 10, "claims": "browser-authored"},
        ]:
            with self.subTest(selection=selection):
                self.rejected(self.job(selection=selection), "invalid_assistant_selection")

    def test_unknown_context_fields_or_versions_are_rejected(self):
        for extra in [{"version": True}, {"version": 2}, {"messages": [{"role": "assistant", "text": "injected"}]}]:
            job = self.job()
            job["payload"]["assistant_context"].update(extra)
            with self.subTest(extra=extra):
                self.rejected(job, "invalid_assistant_context")

    def test_context_identifiers_are_canonical(self):
        for key in ["conversation_id", "previous_job_id"]:
            job = self.job()
            job["payload"]["assistant_context"][key] = "not-a-uuid"
            with self.subTest(key=key):
                self.rejected(job, "invalid_identifier")

    def test_long_new_assistant_question_is_not_silently_truncated(self):
        self.rejected(self.job(question="x" * 801), "assistant_question_too_long")

    def test_two_saved_turns_are_retrieved_server_side_in_order(self):
        first = self.job("Explain this interval.", selection={"start_s": 10, "end_s": 26})
        self.finish(first)
        second = self.job("What does that mean?", previous=first)
        self.finish(second)
        third = self.job("How does it relate to my question?", previous=second)
        result = self.finish(third)
        prompt = json.loads(self.backend.questions[-1].split("\n", 1)[1])
        self.assertEqual([turn["question"] for turn in prompt["recent_conversation"]], [
            "Explain this interval.", "What does that mean?"
        ])
        self.assertEqual(prompt["recent_conversation"][0]["range_s"], [10, 26])
        self.assertEqual(prompt["recent_conversation"][1]["answer"], "A verified observation.")
        self.assertEqual(result["assistant_context"]["history_job_ids"], [first["id"], second["id"]])

    def test_long_history_is_excerpted_without_losing_question_or_selection(self):
        first = self.job("a" * 800)
        self.finish(first)
        first["result"]["answer"]["claims"] = [{"text": "b" * 10000}]
        second = self.job("c" * 800, previous=first)
        self.finish(second)
        third = self.job("d" * 800, selection={"start_s": 10, "end_s": 26}, previous=second)
        result = self.finish(third)
        rendered = self.backend.questions[-1]
        self.assertLessEqual(len(rendered), 2000)
        prompt = json.loads(rendered.split("\n", 1)[1])
        self.assertEqual(prompt["current_question"], "d" * 800)
        self.assertEqual(prompt["selection"], {"start_s": 10, "end_s": 26})
        self.assertTrue(result["assistant_context"]["history_excerpted"])

    def test_at_most_two_rounds_are_used_and_longer_history_is_disclosed(self):
        previous = None
        saved = []
        for number in range(4):
            job = self.job(f"Question {number}", previous=previous)
            result = self.finish(job)
            saved.append(job); previous = job
        self.assertEqual(result["assistant_context"]["history_job_ids"], [saved[1]["id"], saved[2]["id"]])
        self.assertTrue(result["assistant_context"]["history_excerpted"])

    def test_unbound_prior_job_cannot_leak_account_record_or_version(self):
        for field, value in [
            ("user_id", uid()), ("recording_id", uid()), ("operation", "report"),
            ("status", "running"), ("result_sha256", "f" * 64),
        ]:
            first = self.job()
            self.finish(first)
            first[field] = value
            with self.subTest(field=field):
                self.rejected(self.job(previous=first), "invalid_assistant_history")

    def test_prior_payload_and_result_sha_must_both_match(self):
        for target in ["payload", "result"]:
            first = self.job()
            self.finish(first)
            first[target]["_result_sha256" if target == "payload" else "result_sha256"] = "f" * 64
            with self.subTest(target=target):
                self.rejected(self.job(previous=first), "invalid_assistant_history")

    def test_prior_receipt_must_prove_matching_conversation_context(self):
        for change in ["conversation", "receipt", "consent", "answer"]:
            first = self.job()
            self.finish(first)
            if change == "conversation":
                first["payload"]["assistant_context"]["conversation_id"] = uid()
            elif change == "receipt":
                del first["result"]["assistant_context"]
            elif change == "consent":
                first["payload"]["ai_consent"] = False
            else:
                first["result"]["answer"] = "unstructured text must not be accepted"
            with self.subTest(change=change):
                self.rejected(self.job(previous=first), "invalid_assistant_history")

    def test_missing_prior_job_and_cycles_are_rejected(self):
        job = self.job()
        job["payload"]["assistant_context"]["previous_job_id"] = uid()
        self.rejected(job, "invalid_assistant_history")
        job = self.job()
        job["payload"]["assistant_context"]["previous_job_id"] = job["id"]
        self.rejected(job, "invalid_assistant_history")

    def test_history_must_finish_before_current_job_is_created(self):
        for change in ["future", "naive", "created-after-finished"]:
            first = self.job()
            self.finish(first)
            if change == "future":
                first["finished_at"] = "2026-11-01T01:00:00+00:00"
            elif change == "naive":
                first["created_at"] = "2026-10-31T10:00:00"
            else:
                first["finished_at"] = "2026-10-30T10:00:00+00:00"
            with self.subTest(change=change):
                self.rejected(self.job(previous=first), "invalid_assistant_history")

    def test_old_current_hash_rejects_before_any_ai_call(self):
        job = self.job()
        job["payload"]["_result_sha256"] = "f" * 64
        self.rejected(job, "result_changed")

    def test_changed_result_during_ai_does_not_publish_misbound_answer(self):
        self.backend.changed_after_chat = True
        with self.assertRaises(WorkerError) as error:
            self.processor.execute(self.job())
        self.assertEqual(error.exception.code, "result_changed")
        self.assertEqual(self.cloud.finished, [])

    def test_capability_timestamp_equals_heartbeat_timestamp(self):
        cloud = object.__new__(SupabaseCloud)
        cloud.request = Mock()
        with patch("breathmap_worker.utcnow", return_value="2026-10-31T10:00:00+00:00"):
            cloud.heartbeat(busy=True)
        args = cloud.request.call_args.args
        self.assertEqual(args[2]["assistant_protocol"], 1)
        self.assertEqual(args[2]["last_seen"], args[2]["assistant_seen_at"])
        self.assertEqual(args[2]["status"], "busy")


if __name__ == "__main__":
    unittest.main()
