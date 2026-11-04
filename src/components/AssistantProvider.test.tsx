// @vitest-environment happy-dom
/** Session persistence and account-isolation checks; no production Auth or AI. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ user: null as any, loading: false }));
vi.mock('../lib/user', () => ({ useAuth: () => auth }));
import { AssistantProvider, useAssistant } from './AssistantProvider';

const userA = '11111111-1111-4111-8111-111111111111', userB = '99999999-9999-4999-8999-999999999999';
const recordId = '22222222-2222-4222-8222-222222222222', conversation = '33333333-3333-4333-8333-333333333333', jobId = '44444444-4444-4444-8444-444444444444';
const hash = 'a'.repeat(64), key = `${recordId}:${hash}`, draftKey = `${key}:${conversation}`;
let latest: ReturnType<typeof useAssistant>, root: Root, container: HTMLDivElement;
function Probe() { latest = useAssistant(); return <span>{latest.target?.recordingId || 'none'}</span>; }
async function mount() { await act(async () => { root.render(<AssistantProvider><Probe /></AssistantProvider>); }); }

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  auth.user = { id: userA }; auth.loading = false;
  sessionStorage.clear(); localStorage.clear();
  window.history.replaceState(null, '', '/assistant');
  container = document.createElement('div'); container.id = 'root'; document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe('shared assistant session', () => {
  it('restores a URL recording and interval after authentication finishes', async () => {
    auth.user = null; auth.loading = true;
    window.history.replaceState(null, '', `/assistant?recordId=${recordId}&result=${hash}&start=10&end=26`);
    await mount();
    auth.user = { id: userA }; auth.loading = false;
    await mount();
    expect(latest.target).toEqual({ recordingId: recordId, resultHash: hash, selection: { start_s: 10, end_s: 26 } });
  });
  it('keeps a draft, interval and conversation when closing and reopening, then remounting', async () => {
    window.history.replaceState(null, '', `/analysis?recordId=${recordId}`);
    await mount();
    await act(async () => {
      latest.show({ recordingId: recordId, resultHash: hash, selection: { start_s: 10, end_s: 26 } });
      latest.setConversation(key, conversation); latest.saveDraft(draftKey, { question: 'Why this interval?', selection: { start_s: 10, end_s: 26 } });
    });
    await act(async () => latest.close());
    expect(latest.open).toBe(false);
    await act(async () => latest.show());
    expect(latest.open).toBe(true);
    expect(latest.drafts[draftKey].question).toBe('Why this interval?');
    await act(async () => root.unmount()); root = createRoot(container);
    await mount();
    expect(latest.conversations[key]).toBe(conversation);
    expect(latest.drafts[draftKey].question).toBe('Why this interval?');
    expect(latest.target?.selection).toEqual({ start_s: 10, end_s: 26 });
    expect(latest.open).toBe(false);
  });
  it('does not erase an existing interval when the same-record floating entry reopens', async () => {
    window.history.replaceState(null, '', `/analysis?recordId=${recordId}`);
    await mount();
    await act(async () => latest.show({ recordingId: recordId, resultHash: hash, selection: { start_s: 12, end_s: 16 } }));
    await act(async () => latest.close());
    await act(async () => latest.show());
    expect(latest.target?.selection).toEqual({ start_s: 12, end_s: 16 });
  });
  it('starts general discussion from a generic entry and retains the previous record draft', async () => {
    await mount();
    await act(async () => {
      latest.show({ recordingId: recordId, resultHash: hash });
      latest.saveDraft(draftKey, { question: 'A saved record question' });
      latest.close();
    });
    window.history.replaceState(null, '', '/?ctxRecord=' + recordId);
    await act(async () => latest.show());
    expect(latest.target).toBeUndefined();
    expect(latest.drafts[draftKey].question).toBe('A saved record question');
    await act(async () => latest.selectRecord({ recordingId: recordId }));
    await act(async () => latest.clearRecord());
    expect(latest.target).toBeUndefined();
  });
  it('isolates accounts and rejects late callbacks captured by the previous account', async () => {
    await mount();
    await act(async () => { latest.show({ recordingId: recordId, resultHash: hash }); latest.saveDraft(draftKey, { question: 'A private draft' }); });
    const old = latest;
    auth.user = { id: userB }; await mount();
    await act(async () => {
      old.saveDraft(draftKey, { question: 'A delayed RPC failure' });
      old.setConversation(key, conversation);
      old.rememberJob({ id: jobId, recordingId: recordId, resultHash: hash, operation: 'chat', conversationId: conversation });
      old.show({ recordingId: recordId });
    });
    expect(latest.target).toBeUndefined(); expect(latest.open).toBe(false);
    expect(latest.drafts).toEqual({}); expect(latest.conversations).toEqual({}); expect(latest.acceptedJobs).toEqual({});
    expect(sessionStorage.getItem(`breathmap:assistant:v1:${userA}`)).toBeNull();
    expect(sessionStorage.getItem(`breathmap:assistant:v1:${userB}`)).not.toContain('A delayed RPC failure');
  });
  it('retains accepted-job locks across a panel remount until explicitly resolved', async () => {
    await mount();
    await act(async () => latest.rememberJob({ id: jobId, recordingId: recordId, resultHash: hash, operation: 'chat', conversationId: conversation }));
    await act(async () => root.unmount()); root = createRoot(container); await mount();
    expect(latest.acceptedJobs[jobId]?.conversationId).toBe(conversation);
    await act(async () => latest.forgetJob(jobId));
    expect(latest.acceptedJobs).toEqual({});
  });
});
