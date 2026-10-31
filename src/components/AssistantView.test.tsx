// @vitest-environment happy-dom
/** Actual React UI plus session state, against a disposable data-hook boundary.
 * These tests do not execute Supabase, the analysis engine or a language model. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  auth: { user: null as any, loading: false }, data: {} as Record<string, any>, choices: [] as any[],
  from: vi.fn(), requestJob: vi.fn(), refresh: vi.fn(),
}));
vi.mock('../lib/user', () => ({ useAuth: () => fake.auth }));
vi.mock('../lib/supabase', () => ({ supabase: { from: fake.from } }));
vi.mock('../lib/use-assistant-record', () => ({ useAssistantRecord: (id: string | undefined, owner: string | undefined) => ({
  ...(fake.data[`${owner}:${id}`] ?? { jobs: [], loading: false, failed: false }), refresh: fake.refresh,
}) }));
vi.mock('../lib/analysis', async original => ({ ...await original<typeof import('../lib/analysis')>(), requestJob: fake.requestJob }));
import AssistantView from './AssistantView';
import { AssistantProvider, useAssistant } from './AssistantProvider';

const userA = '11111111-1111-4111-8111-111111111111', userB = '99999999-9999-4999-8999-999999999999';
const recordA = '22222222-2222-4222-8222-222222222222', recordB = '55555555-5555-4555-8555-555555555555';
const conversation = '33333333-3333-4333-8333-333333333333', priorId = '44444444-4444-4444-8444-444444444444', acceptedId = '66666666-6666-4666-8666-666666666666';
const hashA = 'a'.repeat(64), hashB = 'b'.repeat(64), selection = { start_s: 10, end_s: 26, window_id: 'M01', kind: 'model' as const };
let live: ReturnType<typeof useAssistant>, container: HTMLDivElement, root: Root;
function Probe() { live = useAssistant(); return null; }
function result(hash = hashA) { return {
  result_sha256: hash,
  display: { source_result_sha256: hash, execution: { status: 'success' }, extent: { duration_s: 60 },
    report: { status: 'ready', source: 'simulated', claims: [{ text: 'Saved synthetic explanation.', evidence_ids: ['MODEL:M01'] }] } },
  windows: { model: { source_result_sha256: hash, items: [{ window_id: 'M01', start_s: 10, end_s: 26 }] } },
}; }
function completedJob(overrides: any = {}) { return {
  id: priorId, recording_id: recordA, operation: 'chat', status: 'completed', created_at: '2026-10-31T09:00:00Z', finished_at: '2026-10-31T09:01:00Z',
  payload: { question: 'Previous synthetic question.', _result_sha256: hashA, assistant_context: { version: 1, conversation_id: conversation, selection } },
  result: { result_sha256: hashA, assistant_context: { version: 1, conversation_id: conversation, selection }, answer: { claims: [{ text: 'Previous saved synthetic answer.', evidence_ids: ['MODEL:M01'] }] } },
  ...overrides,
}; }
function data(id = recordA, hash = hashA) {
  const now = new Date().toISOString();
  return { record: { id, title: id === recordA ? 'Synthetic A recording' : 'Synthetic B recording', recorded_at: '2026-10-31T08:00:00Z' },
    result: result(hash), jobs: [completedJob()], heartbeat: { last_seen: now, assistant_protocol: 1, assistant_seen_at: now }, loading: false, failed: false };
}
async function mount() { await act(async () => root.render(<AssistantProvider><Probe /><AssistantView /></AssistantProvider>)); }
async function click(element: HTMLElement) { await act(async () => element.click()); }
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function question() { const element = container.querySelector<HTMLTextAreaElement>('textarea'); if (!element) throw new Error('Question textarea missing'); return element; }
async function fill(value: string) { await act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(question(), value);
  question().dispatchEvent(new Event('input', { bubbles: true }));
}); }
async function consent() { await click(container.querySelector<HTMLInputElement>('input[type=checkbox]')!); }
async function submitTwice() { await act(async () => { const form = container.querySelector('form')!; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fake.auth = { user: { id: userA }, loading: false }; fake.data = { [`${userA}:${recordA}`]: data(), [`${userA}:${recordB}`]: { ...data(recordB), jobs: [] } };
  fake.choices = [fake.data[`${userA}:${recordA}`].record, fake.data[`${userA}:${recordB}`].record];
  fake.refresh.mockReset().mockResolvedValue(undefined); fake.requestJob.mockReset().mockResolvedValue({ id: acceptedId });
  fake.from.mockReset().mockImplementation(() => { const query: any = { select: () => query, eq: () => query, is: () => query, order: () => query, limit: () => Promise.resolve({ data: fake.choices, error: null }) }; return query; });
  localStorage.clear(); localStorage.setItem('breathmap-language', 'en'); sessionStorage.clear();
  window.history.replaceState(null, '', `/assistant?recordId=${recordA}&result=${hashA}&start=10&end=26&windowId=M01&kind=model`);
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div'); container.id = 'root'; document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe('AI assistant workspace behaviour', () => {
  it('reads a saved explanation without generating a new paid request', async () => {
    await mount(); await click(button('AI explanation'));
    expect(container.textContent).toContain('Saved synthetic explanation.');
    expect(fake.requestJob).not.toHaveBeenCalled();
    expect(button('Regenerate explanation').disabled).toBe(true);
  });
  it('sends the chosen record, interval and previous job, without browser-supplied answer history', async () => {
    await mount(); await consent(); await fill('Why did that interval change?'); await submitTwice();
    expect(fake.requestJob).toHaveBeenCalledOnce();
    expect(fake.requestJob).toHaveBeenCalledWith(recordA, 'chat', {
      language: 'en', result_sha256: hashA, ai_consent: true, question: 'Why did that interval change?',
      assistant_context: { version: 1, conversation_id: conversation, selection, previous_job_id: priorId },
    });
    expect(fake.requestJob.mock.calls[0][2]).not.toHaveProperty('history');
    expect(fake.requestJob.mock.calls[0][2]).not.toHaveProperty('messages');
    expect(question().value).toBe('');
  });
  it('retains an accepted chat lock before the next polling snapshot and after reopening the view', async () => {
    await mount(); await consent(); await fill('A first question'); await submitTwice();
    expect(button('Waiting for answer').disabled).toBe(true);
    await fill('Do not submit this twice'); await submitTwice();
    expect(fake.requestJob).toHaveBeenCalledOnce();
    await act(async () => root.unmount()); root = createRoot(container); await mount();
    await consent();
    expect(button('Waiting for answer').disabled).toBe(true);
    await submitTwice(); expect(fake.requestJob).toHaveBeenCalledOnce();
    fake.data[`${userA}:${recordA}`].jobs = [completedJob({ id: acceptedId }), completedJob()];
    await mount();
    expect(live.acceptedJobs[acceptedId]).toBeUndefined();
    expect(button('Send').disabled).toBe(false);
  });
  it('blocks duplicate submits during an unresolved request and keeps the draft after failure', async () => {
    let reject!: (reason: Error) => void;
    fake.requestJob.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    await mount(); await consent(); await fill('Keep my unfinished question'); await submitTwice();
    expect(fake.requestJob).toHaveBeenCalledOnce(); expect(question().disabled).toBe(true);
    await act(async () => reject(new Error('Synthetic unavailable transport')));
    expect(question().value).toBe('Keep my unfinished question');
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Your draft is saved');
  });
  it('does not reintroduce account A text when a delayed failed request settles after account B signs in', async () => {
    let reject!: (reason: Error) => void;
    fake.requestJob.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    await mount(); await consent(); await fill('A private delayed question'); await submitTwice();
    fake.auth = { user: { id: userB }, loading: false }; fake.choices = [];
    window.history.replaceState(null, '', '/assistant'); await mount();
    await act(async () => reject(new Error('Synthetic late rejection')));
    expect(JSON.stringify(live.drafts)).not.toContain('private delayed');
    expect(JSON.stringify(live.acceptedJobs)).not.toContain(recordA);
    expect(container.textContent).not.toContain('Previous saved synthetic answer.');
  });
  it.each([
    ['missing capability', () => ({ last_seen: new Date().toISOString() })],
    ['mismatched capability time', () => ({ last_seen: new Date().toISOString(), assistant_protocol: 1, assistant_seen_at: new Date(Date.now() - 10000).toISOString() })],
    ['offline', () => { const seen = new Date(Date.now() - 100000).toISOString(); return { last_seen: seen, assistant_protocol: 1, assistant_seen_at: seen }; }],
  ])('keeps saved content readable but blocks context-aware sending when %s', async (_name, heartbeat) => {
    fake.data[`${userA}:${recordA}`].heartbeat = heartbeat();
    await mount(); await consent(); await fill('A question that must wait');
    expect(container.textContent).toContain('Previous saved synthetic answer.');
    expect(button('Send').disabled).toBe(true); await submitTwice(); expect(fake.requestJob).not.toHaveBeenCalled();
    await click(button('AI explanation')); expect(container.textContent).toContain('Saved synthetic explanation.');
  });
  it('revokes consent and clears the old interval when the analysis version changes', async () => {
    await mount(); await consent(); await fill('Question for the old result');
    expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
    fake.data[`${userA}:${recordA}`].result = result(hashB);
    fake.data[`${userA}:${recordA}`].jobs = [];
    await mount();
    expect(live.target).toEqual({ recordingId: recordA, resultHash: hashB });
    expect(container.querySelector('.assistant-selection')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
    expect(question().value).toBe('');
    expect(container.textContent).not.toContain('Previous saved synthetic answer.');
  });
  it('changes records without carrying the previous record draft, consent or answer', async () => {
    await mount(); await consent(); await fill('A-only draft');
    const picker = container.querySelector<HTMLSelectElement>('#assistant-record-page')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(picker, recordB); picker.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('.assistant-context-bar strong')?.textContent).toBe('Synthetic B recording');
    expect(question().value).toBe('');
    expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
    expect(container.textContent).not.toContain('Previous saved synthetic answer.');
    expect(live.target?.selection).toBeUndefined();
  });
  it('focuses a cited interval on the current analysis page and makes a versioned URL elsewhere', async () => {
    window.history.replaceState(null, '', `/analysis?recordId=${recordA}`);
    await mount();
    const focus = vi.fn(); window.addEventListener('breathmap:focus-evidence', focus);
    try {
      const citation = container.querySelector<HTMLAnchorElement>('.assistant-evidence a')!;
      const url = new URL(citation.href);
      expect(url.searchParams.get('recordId')).toBe(recordA); expect(url.searchParams.get('result')).toBe(hashA);
      expect(url.searchParams.get('start')).toBe('10'); expect(url.searchParams.get('end')).toBe('26');
      await click(citation);
      expect(focus).toHaveBeenCalledOnce();
      expect((focus.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ recordingId: recordA, resultHash: hashA, selection });
    } finally { window.removeEventListener('breathmap:focus-evidence', focus); }
  });
  it('keeps legacy question history readable without falsely treating it as a shared conversation', async () => {
    fake.data[`${userA}:${recordA}`].jobs = [completedJob({ payload: { question: 'Legacy question', _result_sha256: hashA } })];
    await mount();
    const choose = container.querySelector<HTMLSelectElement>('select[aria-label="Choose conversation"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(choose, 'legacy'); choose.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.textContent).toContain('Legacy question');
    expect(container.textContent).toContain('no confirmed shared context');
    expect(question().disabled).toBe(true);
    await submitTwice(); expect(fake.requestJob).not.toHaveBeenCalled();
  });
  it.each([
    ['conversation', { version: 1, conversation_id: '77777777-7777-4777-8777-777777777777', selection }],
    ['interval', { version: 1, conversation_id: conversation, selection: { ...selection, end_s: 27 } }],
    ['previous question', { version: 1, conversation_id: conversation, selection, previous_job_id: acceptedId }],
    ['protocol', { version: 2, conversation_id: conversation, selection }],
  ])('does not treat an answer with a mismatched %s receipt as verified follow-up context', async (_name, receipt) => {
    fake.data[`${userA}:${recordA}`].jobs = [completedJob({ result: { result_sha256: hashA, assistant_context: receipt, answer: { claims: [{ text: 'Saved response with an unconfirmed receipt.', evidence_ids: [] }] } } })];
    await mount(); await consent();
    expect(container.textContent).toContain('Saved response with an unconfirmed receipt.');
    expect(container.textContent).toContain('no confirmed shared context');
    expect(question().disabled).toBe(true); await submitTwice(); expect(fake.requestJob).not.toHaveBeenCalled();
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="New conversation"]')!);
    expect(question().disabled).toBe(false); expect(live.conversations[`${recordA}:${hashA}`]).not.toBe(conversation);
  });
});
