// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { analysisLink, assistantServiceState, assistantTargetFromUrl, currentAssistantJob, evidenceSelection, validSelection } from './assistant-context';

const recordId = '22222222-2222-4222-8222-222222222222';
const hash = 'a'.repeat(64);

describe('assistant context boundaries', () => {
  it('rejects invalid and out-of-record intervals instead of making them appear selected', () => {
    for (const selection of [null, { start_s: NaN, end_s: 10 }, { start_s: 3, end_s: Infinity },
      { start_s: -1, end_s: 1 }, { start_s: 10, end_s: 10 }, { start_s: 0, end_s: 61 },
      { start_s: 0, end_s: 10, window_id: 'M01' }, { start_s: 0, end_s: 10, window_id: '../private', kind: 'model' }]) {
      expect(validSelection(selection, 60)).toBeUndefined();
    }
    expect(validSelection({ start_s: 0, end_s: 16, window_id: 'M01', kind: 'model' }, 60))
      .toEqual({ start_s: 0, end_s: 16, window_id: 'M01', kind: 'model' });
  });
  it('round trips an analysis link with the exact recording, result and selected window', () => {
    const target = { recordingId: recordId, resultHash: hash, selection: { start_s: 10.5, end_s: 26, window_id: 'M01', kind: 'model' as const } };
    const href = analysisLink(target);
    expect(href.startsWith('/analysis?')).toBe(true);
    expect(href.endsWith('#waveforms')).toBe(true);
    window.history.replaceState(null, '', href);
    expect(assistantTargetFromUrl()).toEqual(target);
    window.history.replaceState(null, '', '/assistant?recordId=not-a-record&start=1&end=2');
    expect(assistantTargetFromUrl()).toBeUndefined();
  });
  it('resolves citations only against windows bound to the current analysis result', () => {
    const result: any = { result_sha256: hash, display: { extent: { duration_s: 60 } }, windows: {
      statistics: { source_result_sha256: hash, items: [{ window_id: 'S01', start_s: 0, end_s: 30 }] },
      model: { source_result_sha256: hash, items: [{ window_id: 'M01', start_s: 10, end_s: 26 }] },
    } };
    expect(evidenceSelection(result, 'STAT:S01')).toEqual({ start_s: 0, end_s: 30, window_id: 'S01', kind: 'statistics' });
    expect(evidenceSelection(result, 'SEG:MW-M01')).toEqual({ start_s: 10, end_s: 26, window_id: 'M01', kind: 'model' });
    expect(evidenceSelection(result, 'SUM')).toBeUndefined();
    result.windows.model.source_result_sha256 = 'b'.repeat(64);
    expect(evidenceSelection(result, 'MODEL:M01')).toBeUndefined();
    expect(evidenceSelection(result, 'MODEL:missing')).toBeUndefined();
  });
  it('excludes questions and completed answers from another recording or result version', () => {
    const job = { recording_id: recordId, status: 'completed', payload: { _result_sha256: hash }, result: { result_sha256: hash } };
    expect(currentAssistantJob(job, recordId, hash)).toBe(true);
    expect(currentAssistantJob({ ...job, recording_id: 'other' }, recordId, hash)).toBe(false);
    expect(currentAssistantJob({ ...job, result: { result_sha256: 'b'.repeat(64) } }, recordId, hash)).toBe(false);
    expect(currentAssistantJob({ ...job, payload: { _result_sha256: 'b'.repeat(64) } }, recordId, hash)).toBe(false);
  });
  it('requires a fresh heartbeat whose context capability was stamped at that exact time', () => {
    const now = Date.parse('2026-10-31T10:00:00Z'), seen = new Date(now - 5000).toISOString();
    expect(assistantServiceState({ last_seen: seen, assistant_protocol: 1, assistant_seen_at: seen }, now).ready).toBe(true);
    expect(assistantServiceState({ last_seen: seen }, now).ready).toBe(false);
    expect(assistantServiceState({ last_seen: seen, assistant_protocol: 1, assistant_seen_at: new Date(now - 6000).toISOString() }, now).ready).toBe(false);
    expect(assistantServiceState({ last_seen: new Date(now - 90001).toISOString(), assistant_protocol: 1, assistant_seen_at: new Date(now - 90001).toISOString() }, now).ready).toBe(false);
    expect(assistantServiceState({ last_seen: 'invalid' }, now).ready).toBe(false);
  });
});
