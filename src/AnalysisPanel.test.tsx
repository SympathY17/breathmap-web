// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  from: vi.fn(), download: vi.fn(), requestJob: vi.fn(),
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'panel-test@example.invalid', fullName: 'Panel test' },
  record: null as any, result: null as any, jobs: [] as any[], heartbeat: [] as any[], overviews: {} as Record<string, any>,
}));
vi.mock('./lib/supabase', () => ({
  supabase: { from: mocked.from, storage: { from: () => ({ download: mocked.download }) } },
}));
vi.mock('./lib/user', () => ({ useAuth: () => ({ user: mocked.user }), useCurrentUser: () => mocked.user }));
vi.mock('./lib/analysis', async importOriginal => ({
  ...await importOriginal<typeof import('./lib/analysis')>(), requestJob: mocked.requestJob,
}));
import AnalysisPanel from './AnalysisPanel';

const recordId = '22222222-2222-4222-8222-222222222222';
const hashA = 'a'.repeat(64), hashB = 'b'.repeat(64);
let container: HTMLDivElement, root: Root;
function waveform(start: number, end: number, height = 1) {
  return { columns: ['time_s', 'signal_mT', 'expiratory_flow_l_min', 'sig_input_uV', 'signal_valid', 'sig_valid'], points: [[start, height, 1, 2, 1, 1], [end, height + 1, 3, 4, 1, 1]], break_before_columns: [], break_before: [[], []], range: { start_s: start, end_s: end } };
}
function resultFixture(hash: string, count = 25, duration = 60, prefix = 'OLD') {
  const path = `${mocked.user.id}/${recordId}/${hash}/overview.json`;
  mocked.overviews[path] = waveform(0, duration, hash === hashA ? 1 : 100);
  const model = Array.from({ length: count }, (_, i) => ({ window_id: `${prefix}-${String(i + 1).padStart(2, '0')}`, start_s: i * 2, end_s: i * 2 + 5, label: 'normal', top_score: .98 }));
  return {
    recording_id: recordId, result_sha256: hash,
    display: { source_result_sha256: hash, execution: { status: 'partial', partial_reasons: ['flow_partial_coverage'] }, summary: { frequency_bpm: 17, mean_expiratory_flow_l_min: 8.1 }, extent: { duration_s: duration, analysis_end_s: duration }, window_counts: { model: count, valid_model: count }, report: { status: 'absent' } },
    windows: { model: { source_result_sha256: hash, items: model }, statistics: { source_result_sha256: hash, items: [] }, attention: { source_result_sha256: hash, items: [] } },
    wave_manifest: { source_result_sha256: hash, overview: { bucket: 'analysis-artifacts', path } },
  };
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); }
function plots() { return [...container.querySelectorAll('svg[role="img"]')].map(element => element.getAttribute('aria-label')); }
async function mount() { await act(async () => { root.render(<AnalysisPanel recordingId={recordId} detailed />); }); }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); localStorage.setItem('breathmap-language', 'en');
  window.scrollTo = vi.fn(); HTMLElement.prototype.scrollIntoView = vi.fn();
  mocked.record = { id: recordId, user_id: mocked.user.id, title: 'Synthetic component fixture', notes: '', details: '', file_path: `${mocked.user.id}/${recordId}/input.xlsx`, file_name: 'synthetic.xlsx', file_size: 1, recorded_at: '2026-10-28T01:00:00Z', uploaded_at: '2026-10-28T01:00:00Z', trashed_at: null };
  mocked.jobs = []; mocked.heartbeat = []; mocked.overviews = {};
  mocked.result = resultFixture(hashA);
  mocked.from.mockImplementation((table: string) => {
    const response = () => ({ data: table === 'recordings' ? mocked.record : table === 'analysis_results' ? mocked.result : table === 'analysis_jobs' ? mocked.jobs : mocked.heartbeat, error: null });
    const query: any = { select: () => query, eq: () => query, is: () => query, order: () => query, limit: () => query, maybeSingle: async () => response(), then: (resolve: any, reject: any) => Promise.resolve(response()).then(resolve, reject) };
    return query;
  });
  mocked.download.mockImplementation(async (path: string) => ({ data: { size: 100, text: async () => JSON.stringify(mocked.overviews[path]) }, error: null }));
  mocked.requestJob.mockResolvedValue({ id: 'requested-job' });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.useRealTimers(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });

describe('AnalysisPanel saved-result version boundaries', () => {
  it('replaces an interval waveform and clears old evidence when a new result SHA arrives', async () => {
    mocked.result.display.report = { status: 'ready', source: 'simulated', claims: [{ text: 'Old synthetic explanation', evidence_ids: ['QA-OLD'], values: [] }], evidence: { 'QA-OLD': { values: { proof: 'OLD-SOURCE-ONLY' } } } };
    await mount();
    expect(plots()).toContain('Magnetic signal, 0–60 s');
    await click(container.querySelectorAll('tbody tr')[5].querySelector('button')!);
    mocked.requestJob.mockImplementation(async (_id, operation, payload) => {
      expect(operation).toBe('waveform');
      expect(payload).toMatchObject({ start: 10, end: 15, result_sha256: hashA });
      mocked.jobs = [{ id: 'interval-a', operation: 'waveform', status: 'completed', payload: { _result_sha256: hashA }, result: { result_sha256: hashA, waveform: waveform(10, 15) } }];
      return { id: 'interval-a' };
    });
    await act(async () => { container.querySelector('form.wave-controls')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(plots()).toContain('Magnetic signal, 10–15 s');
    await click(button('QA-OLD'));
    expect(container.textContent).toContain('OLD-SOURCE-ONLY');
    await click(button('Next'));
    expect(container.querySelector('tbody')?.textContent).toContain('OLD-21');
    await click(container.querySelector('input[type="checkbox"]')!);
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);

    mocked.result = resultFixture(hashB, 25, 90, 'NEW');
    // Retaining the old completed job in history must not block a new overview.
    await tick();
    expect(plots()).toContain('Magnetic signal, 0–90 s');
    expect(plots()).not.toContain('Magnetic signal, 10–15 s');
    expect(container.textContent).not.toContain('OLD-SOURCE-ONLY');
    expect(container.querySelector('tbody')?.textContent).toContain('NEW-01');
    expect(container.querySelector('tbody')?.textContent).not.toContain('NEW-21');
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    expect(mocked.download).toHaveBeenCalledWith(`${mocked.user.id}/${recordId}/${hashB}/overview.json`);
  });
  it('shows every saved window across pages without recalculating or requesting AI', async () => {
    await mount();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(20);
    expect(container.querySelector('tbody')?.textContent).toContain('OLD-20');
    expect(container.querySelector('tbody')?.textContent).not.toContain('OLD-21');
    await click(button('Next'));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(container.querySelector('tbody')?.textContent).toContain('OLD-21');
    expect(container.querySelector('tbody')?.textContent).toContain('OLD-25');
    expect(button('Next').disabled).toBe(true);
    await click(button('Previous'));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(20);
    expect(container.querySelector('tbody')?.textContent).toContain('OLD-01');
    expect(mocked.requestJob).not.toHaveBeenCalled();
  });
  it('retains numerical results, windows and cached waveforms while AI fails and the host is offline', async () => {
    mocked.result.display.report = { status: 'failed' };
    mocked.jobs = [{ id: 'queued-chat', operation: 'chat', status: 'queued', payload: { _result_sha256: hashA, question: 'Synthetic follow-up' } }, { id: 'failed-report', operation: 'report', status: 'failed', error_code: 'PROVIDER_UNAVAILABLE' }];
    await mount();
    expect([...container.querySelectorAll('.result-metric strong')].map(element => element.textContent)).toEqual(['17', '8.1', '25 / 25']);
    expect(container.textContent).toContain('Your request has been saved. It will continue when the analysis host is available.');
    expect(container.textContent).toContain('Your numerical results remain accessible.');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(20);
    expect(plots()).toContain('Magnetic signal, 0–60 s');
    expect(button('Generate or retry explanation').disabled).toBe(true);
    expect(mocked.requestJob).not.toHaveBeenCalled();
  });
});
