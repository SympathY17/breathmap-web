// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  from: vi.fn(), download: vi.fn(), requestJob: vi.fn(),
  showAssistant: vi.fn(),
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'panel-test@example.invalid', fullName: 'Panel test' },
  record: null as any, result: null as any, jobs: [] as any[], heartbeat: [] as any[], overviews: {} as Record<string, any>,
}));
vi.mock('./lib/supabase', () => ({
  supabase: { from: mocked.from, storage: { from: () => ({ download: mocked.download }) } },
}));
vi.mock('./lib/user', () => ({ useAuth: () => ({ user: mocked.user }), useCurrentUser: () => mocked.user }));
vi.mock('./components/AssistantProvider', () => ({ useAssistant: () => ({ show: mocked.showAssistant }) }));
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
function rangeInputs() { return [...container.querySelectorAll<HTMLInputElement>('.wave-controls input')]; }
async function editRange(start: string, end: string) {
  await act(async () => {
    for (const [index, value] of [start, end].entries()) {
      const input = rangeInputs()[index];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}
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
  it('restores the saved interval in both waveforms and inputs before asking AI about it', async () => {
    mocked.jobs = [{ id: 'saved-interval', operation: 'waveform', status: 'completed', payload: { _result_sha256: hashA, start: 10, end: 20 }, result: { result_sha256: hashA, waveform: waveform(10, 20) } }];
    await mount();
    expect(plots()).toContain('Magnetic signal, 10–20 s');
    expect(rangeInputs().map(input => input.value)).toEqual(['10', '20']);
    await click(button('Ask about this interval'));
    expect(mocked.showAssistant).toHaveBeenCalledWith({ recordingId: recordId, resultHash: hashA, selection: { start_s: 10, end_s: 20 } });
    expect(mocked.requestJob).not.toHaveBeenCalled();
  });
  it('keeps edited bounds through polling and a pending interval reply without replacing the draft', async () => {
    const oldJob = { id: 'saved-interval', operation: 'waveform', status: 'completed', payload: { _result_sha256: hashA, start: 10, end: 20 }, result: { result_sha256: hashA, waveform: waveform(10, 20) } };
    mocked.jobs = [oldJob];
    await mount();
    await editRange('20', '40');
    mocked.jobs = [{ ...oldJob }]; await tick();
    expect(rangeInputs().map(input => input.value)).toEqual(['20', '40']);
    mocked.requestJob.mockImplementation(async () => {
      mocked.jobs = [{ id: 'pending-interval', operation: 'waveform', status: 'queued', payload: { _result_sha256: hashA, start: 20, end: 40 } }, oldJob];
      return { id: 'pending-interval' };
    });
    await act(async () => { container.querySelector('.wave-controls')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(mocked.requestJob).toHaveBeenCalledWith(recordId, 'waveform', expect.objectContaining({ start: 20, end: 40 }));
    await editRange('25', '45');
    mocked.jobs = [{ ...mocked.jobs[0], status: 'completed', result: { result_sha256: hashA, waveform: waveform(20, 40) } }, oldJob];
    await tick();
    expect(plots()).toContain('Magnetic signal, 20–40 s');
    expect(rangeInputs().map(input => input.value)).toEqual(['25', '45']);
    await tick();
    expect(rangeInputs().map(input => input.value)).toEqual(['25', '45']);
  });
  it('does not replace a citation-selected interval when the initial overview arrives later', async () => {
    let resolveOverview!: (response: any) => void;
    mocked.download.mockImplementationOnce(() => new Promise(resolve => { resolveOverview = resolve; }));
    await mount();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('breathmap:focus-evidence', { detail: { recordingId: recordId, resultHash: hashA, selection: { start_s: 10, end_s: 15, window_id: 'OLD-06', kind: 'model' } } }));
    });
    expect(rangeInputs().map(input => input.value)).toEqual(['10', '15']);
    await act(async () => { resolveOverview({ data: { size: 100, text: async () => JSON.stringify(waveform(0, 60)) }, error: null }); });
    expect(rangeInputs().map(input => input.value)).toEqual(['10', '15']);
    expect(container.querySelector('tr[aria-selected="true"]')?.textContent).toContain('OLD-06');
  });
  it('loads a selected window immediately and clears the old interval when a new result SHA arrives', async () => {
    mocked.result.display.report = { status: 'ready', source: 'simulated', claims: [{ text: 'Old synthetic explanation', evidence_ids: ['QA-OLD'], values: [] }], evidence: { 'QA-OLD': { values: { proof: 'OLD-SOURCE-ONLY' } } } };
    await mount();
    expect(plots()).toContain('Magnetic signal, 0–30 s');
    mocked.requestJob.mockImplementation(async (_id, operation, payload) => {
      expect(operation).toBe('waveform');
      expect(payload).toMatchObject({ start: 10, end: 15, result_sha256: hashA });
      mocked.jobs = [{ id: 'interval-a', operation: 'waveform', status: 'completed', payload: { _result_sha256: hashA, start: payload.start, end: payload.end }, result: { result_sha256: hashA, waveform: waveform(10, 15) } }];
      return { id: 'interval-a' };
    });
    await click(container.querySelectorAll('tbody tr')[5].querySelector('button')!);
    expect(plots()).toContain('Magnetic signal, 10–15 s');
    expect(mocked.requestJob).toHaveBeenCalledTimes(1);
    await click(button('Ask about this interval'));
    expect(mocked.showAssistant).toHaveBeenCalledWith({ recordingId: recordId, resultHash: hashA, selection: { start_s: 10, end_s: 15, window_id: 'OLD-06', kind: 'model' } });
    await click(button('Next'));
    expect(container.querySelector('tbody')?.textContent).toContain('OLD-21');

    mocked.result = resultFixture(hashB, 25, 90, 'NEW');
    // Retaining the old completed job in history must not block a new overview.
    await tick();
    expect(plots()).toContain('Magnetic signal, 0–30 s');
    expect(plots()).not.toContain('Magnetic signal, 10–15 s');
    expect(container.textContent).not.toContain('OLD-SOURCE-ONLY');
    expect(container.querySelector('tbody')?.textContent).toContain('NEW-01');
    expect(container.querySelector('tbody')?.textContent).not.toContain('NEW-21');
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
    expect(container.textContent).toContain('Saved numerical results are retained.');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(20);
    expect(plots()).toContain('Magnetic signal, 0–30 s');
    expect(button('Open AI assistant')).toBeTruthy();
    expect(mocked.requestJob).not.toHaveBeenCalled();
  });
  it('loads a current AI citation and rejects another recording or result version', async () => {
    await mount();
    const dispatch = (id: string, hash: string) => window.dispatchEvent(new CustomEvent('breathmap:focus-evidence', { detail: { recordingId: id, resultHash: hash, selection: { start_s: 10, end_s: 15, window_id: 'OLD-06', kind: 'model' } } }));
    await act(async () => { dispatch('33333333-3333-4333-8333-333333333333', hashA); dispatch(recordId, hashB); });
    expect(mocked.requestJob).not.toHaveBeenCalled();
    await act(async () => { dispatch(recordId, hashA); });
    expect(mocked.requestJob).toHaveBeenCalledWith(recordId, 'waveform', expect.objectContaining({ start: 10, end: 15, result_sha256: hashA }));
    expect(container.querySelector('tr[aria-selected="true"]')?.textContent).toContain('OLD-06');
  });
  it('opens a long record at 30 seconds and requests those details only once while the host is online', async () => {
    mocked.result = resultFixture(hashA,25,3600);
    mocked.heartbeat = [{last_seen:new Date().toISOString()}];
    mocked.requestJob.mockImplementation(async (_id, operation, payload) => {
      mocked.jobs = [{id:'initial-details',operation,status:'queued',payload:{...payload,_result_sha256:hashA}}];
      return {id:'initial-details'};
    });
    await mount();
    expect(rangeInputs().map(input=>input.value)).toEqual(['0','30']);
    expect(plots()).toContain('Magnetic signal, 0–30 s');
    expect(mocked.requestJob).toHaveBeenCalledWith(recordId,'waveform',expect.objectContaining({start:0,end:30}));
    await tick();
    expect(mocked.requestJob).toHaveBeenCalledTimes(1);
  });
  it('coalesces changes made during a pending read and never applies an older interval reply', async () => {
    const oldJob = {id:'saved',operation:'waveform',status:'completed',payload:{_result_sha256:hashA,start:10,end:20},result:{result_sha256:hashA,waveform:waveform(10,20)}};
    mocked.jobs = [oldJob];
    mocked.requestJob.mockImplementation(async (_id, operation, payload) => {
      const job={id:`read-${payload.start}`,operation,status:'queued',payload:{...payload,_result_sha256:hashA}};
      mocked.jobs=[job,...mocked.jobs];
      return {id:job.id};
    });
    await mount();
    await click(container.querySelectorAll('tbody tr')[5].querySelector('button')!);
    await click(container.querySelectorAll('tbody tr')[6].querySelector('button')!);
    expect(mocked.requestJob).toHaveBeenCalledTimes(1);
    expect(rangeInputs().map(input=>input.value)).toEqual(['12','17']);
    mocked.jobs=[{...mocked.jobs[0],status:'completed',result:{result_sha256:hashA,waveform:waveform(10,15)}},oldJob];
    await tick();
    expect(mocked.requestJob).toHaveBeenCalledTimes(2);
    expect(mocked.requestJob).toHaveBeenLastCalledWith(recordId,'waveform',expect.objectContaining({start:12,end:17}));
    expect(plots()).toContain('Magnetic signal, 12–17 s');
    expect(plots()).not.toContain('Magnetic signal, 10–15 s');
    mocked.jobs=[{...mocked.jobs[0],status:'completed',result:{result_sha256:hashA,waveform:waveform(12,17)}},...mocked.jobs.slice(1)];
    await tick();
    expect(plots()).toContain('Magnetic signal, 12–17 s');
    expect(mocked.requestJob).toHaveBeenCalledTimes(2);
  });
  it('keeps the selected model interval highlighted when zooming out for context', async () => {
    mocked.requestJob.mockImplementation(async (_id,operation,payload)=>{
      const id=`range-${payload.start}-${payload.end}`;
      mocked.jobs=[{id,operation,status:'completed',payload:{...payload,_result_sha256:hashA},result:{result_sha256:hashA,waveform:waveform(payload.start,payload.end)}},...mocked.jobs];
      return {id};
    });
    await mount();
    await click(container.querySelectorAll('tbody tr')[5].querySelector('button')!);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]')!);
    expect(plots()).toContain('Magnetic signal, 7.5–17.5 s');
    expect(container.querySelectorAll('.wfe-highlight')).toHaveLength(3);
    expect(container.querySelector('.interval-insight h3')?.textContent).toContain('10–15');
    await click(button('Ask about this interval'));
    expect(mocked.showAssistant).toHaveBeenCalledWith({recordingId:recordId,resultHash:hashA,selection:{start_s:10,end_s:15,window_id:'OLD-06',kind:'model'}});
  });
  it('shows available metrics and labels missing metrics without a coverage banner', async () => {
    mocked.result.display.summary.frequency_bpm = 0;
    mocked.result.display.summary.mean_expiratory_flow_l_min = null;
    await mount();
    expect(container.querySelector('[aria-label="Analysis coverage"]')).toBeNull();
    expect(container.querySelector('.result-status.warn')).toBeNull();
    const metrics = container.querySelectorAll('.result-grid .result-metric');
    expect(metrics[0].querySelector('strong')?.textContent).toBe('0');
    expect(metrics[0].querySelector('small')?.textContent).toBe('breaths/min');
    expect(metrics[1].querySelector('strong')?.textContent).toBe('—');
    expect(metrics[1].querySelector('small')?.textContent).toBe('Unavailable');
  });
  it('shows progress for a newly queued analysis and offers a retry after failure', async () => {
    mocked.result = null;
    mocked.heartbeat = [{ last_seen: new Date().toISOString() }];
    const job = { id: 'upload-analysis', operation: 'analyse', status: 'queued' };
    mocked.jobs = [job];
    await mount();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('queued');
    expect(container.textContent).not.toMatch(/Ready to analyse|Start analysis|Retry analysis/);
    expect(container.querySelector('.result-grid')).toBeNull();

    mocked.jobs = [{ ...job, status: 'running' }];
    await tick();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('being processed');
    expect(container.textContent).not.toMatch(/Ready to analyse|Start analysis|Retry analysis/);

    mocked.jobs = [{ ...job, status: 'failed' }];
    await tick();
    expect(button('Retry analysis')).toBeTruthy();
    expect(mocked.requestJob).not.toHaveBeenCalled();
  });
  it('restores a cached detail after returning to the overview without creating another job', async () => {
    mocked.jobs=[{id:'cached',operation:'waveform',status:'completed',payload:{_result_sha256:hashA,start:10,end:15},result:{result_sha256:hashA,waveform:waveform(10,15)}}];
    await mount();
    expect(plots()).toContain('Magnetic signal, 10–15 s');
    await click(button('Full recording'));
    expect(plots()).toContain('Magnetic signal, 0–60 s');
    await click(container.querySelectorAll('tbody tr')[5].querySelector('button')!);
    expect(plots()).toContain('Magnetic signal, 10–15 s');
    expect(container.querySelector('.wfe-loading')).toBeNull();
    expect(mocked.requestJob).not.toHaveBeenCalled();
  });
  it('does not show a failed old range request after the user has selected a newer interval', async () => {
    let failOld!: (reason:Error)=>void;
    mocked.requestJob.mockImplementation(async (_id,operation,payload)=>{
      mocked.jobs=[{id:'new-range',operation,status:'completed',payload:{...payload,_result_sha256:hashA},result:{result_sha256:hashA,waveform:waveform(payload.start,payload.end)}}];
      return {id:'new-range'};
    });
    // Keep the first call unresolved while selecting the newer window.
    mocked.requestJob.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{failOld=reject;}));
    await mount();
    await click(container.querySelectorAll('tbody tr')[5].querySelector('button')!);
    await click(container.querySelectorAll('tbody tr')[6].querySelector('button')!);
    await act(async()=>{failOld(new Error('stale-range-error'));});
    expect(container.textContent).not.toContain('stale-range-error');
    expect(plots()).toContain('Magnetic signal, 12–17 s');
    expect(mocked.requestJob).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.wfe-loading')).toBeNull();
  });
  it('does not let a slower refresh restore an older result SHA', async () => {
    await mount();
    const originalFrom=mocked.from.getMockImplementation()!;
    let resolveOld!:(value:any)=>void;
    let delay=true;
    const oldResult=mocked.result;
    mocked.from.mockImplementation((table:string)=>{
      const query=originalFrom(table);
      if(table==='analysis_results'&&delay)query.maybeSingle=()=>new Promise(resolve=>{resolveOld=resolve;});
      return query;
    });
    await click(button('Refresh'));
    delay=false;
    mocked.result=resultFixture(hashB,25,90,'NEW');
    await click(button('Refresh'));
    expect(container.querySelector('tbody')?.textContent).toContain('NEW-01');
    await act(async()=>{resolveOld({data:oldResult,error:null});});
    expect(container.querySelector('tbody')?.textContent).toContain('NEW-01');
    expect(container.querySelector('tbody')?.textContent).not.toContain('OLD-01');
  });
});
