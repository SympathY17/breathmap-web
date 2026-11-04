// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  user: { id: 'qa-user' },
  assistant: { lang: 'en', conversations: { general: '11111111-1111-4111-8111-111111111111' }, drafts: {} as Record<string, {question: string}>, setConversation: vi.fn(), saveDraft: vi.fn() },
  send: vi.fn(), list: vi.fn(), turns: vi.fn(),
}));
vi.mock('../lib/user', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('./AssistantProvider', () => ({ useAssistant: () => state.assistant }));
vi.mock('../lib/sleep-chat', () => ({ loadSleepConversations: state.list, loadSleepTurns: state.turns, sendSleepQuestion: state.send, sleepChatError: () => 'Service unavailable' }));
import GeneralSleepChat from './GeneralSleepChat';
let container: HTMLDivElement, root: Root;
const key = 'general:11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); sessionStorage.clear();
  state.user = { id: 'qa-user' }; state.assistant.lang = 'en';
  state.assistant.drafts = { [key]: { question: 'Why am I tired?' } };
  state.assistant.saveDraft.mockImplementation((name, draft) => { state.assistant.drafts[name] = draft; });
  state.list.mockResolvedValue([]); state.turns.mockResolvedValue([]);
  state.send.mockImplementation(async input => ({ conversation_id: input.conversation_id, request_id: input.request_id, status: 'completed', answer: 'A saved reply.' }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function mount(add?: () => void) { await act(async () => { root.render(<GeneralSleepChat onAddRecord={add} />); }); }
async function consent() { await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()); }
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
describe('General sleep conversation', () => {
  it('allows a question without a recording and requires AI consent before sending', async () => {
    await mount(); expect(container.textContent).toContain('What would you like to talk about?');
    await submit(); expect(state.send).not.toHaveBeenCalled();
    await consent(); await submit(); expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0][0]).toMatchObject({ message: 'Why am I tired?', ai_consent: true, language: 'en' });
    expect(state.send.mock.calls[0][0]).not.toHaveProperty('recording_id');
  });
  it('keeps the original request and language when checking after reopening', async () => {
    state.send.mockRejectedValueOnce(new Error('network'));
    await mount(); await consent(); await submit();
    const first = state.send.mock.calls[0][0];
    await act(async () => root.unmount()); root = createRoot(container);
    state.assistant.lang = 'zh';
    await mount(); await consent();
    const check = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '检查回复')!;
    await act(async () => check.click());
    expect(state.send.mock.calls[1][0]).toEqual(first);
  });
  it('restores a pending cloud turn as a locked original request', async () => {
    state.turns.mockResolvedValue([{ id: '22222222-2222-4222-8222-222222222222', conversation_id: state.assistant.conversations.general, question: 'An earlier question', answer: null, status: 'pending', language: 'zh', error_code: null, created_at: '2026-11-04T01:00:00Z' }]);
    await mount();
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    expect(container.querySelector('textarea')?.value).toBe('An earlier question');
    await consent();
    const check = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Check reply')!;
    await act(async () => check.click());
    expect(state.send.mock.calls[0][0]).toMatchObject({ request_id: '22222222-2222-4222-8222-222222222222', message: 'An earlier question', language: 'zh' });
  });
  it('leaves recording selection behind an explicit action', async () => {
    const add = vi.fn(); await mount(add);
    expect(container.querySelector('select')?.options).toHaveLength(1);
    const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === 'Add a recording')!;
    await act(async () => button.click()); expect(add).toHaveBeenCalledTimes(1);
    expect(state.send).not.toHaveBeenCalled();
  });
  it('does not clear a shared draft when a request finishes after unmounting', async () => {
    let resolve!: (value: any) => void;
    state.send.mockReturnValue(new Promise(value => { resolve = value; }));
    await mount(); await consent(); await submit();
    const request = state.send.mock.calls[0][0];
    expect(state.send.mock.calls[0][1]).toBe('qa-user');
    await act(async () => root.unmount()); root = createRoot(container);
    state.assistant.saveDraft.mockClear();
    await act(async () => resolve({ conversation_id: request.conversation_id, request_id: request.request_id, status: 'completed', answer: 'Late reply' }));
    expect(state.assistant.saveDraft).not.toHaveBeenCalled();
    expect(state.assistant.drafts[key].question).toBe('Why am I tired?');
  });
});
