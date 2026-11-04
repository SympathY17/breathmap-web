// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  user: { id: 'qa-user' },
  assistant: { lang: 'en', conversations: { general: '11111111-1111-4111-8111-111111111111' }, drafts: {} as Record<string, {question: string}>, setConversation: vi.fn(), saveDraft: vi.fn() },
  send: vi.fn(), list: vi.fn(), turns: vi.fn(), remove: vi.fn(),
}));
vi.mock('../lib/user', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('./AssistantProvider', () => ({ useAssistant: () => state.assistant }));
vi.mock('../lib/sleep-chat', () => ({ loadSleepConversations: state.list, loadSleepTurns: state.turns, sendSleepQuestion: state.send, deleteSleepConversation: state.remove, sleepChatError: () => 'Service unavailable' }));
import GeneralSleepChat from './GeneralSleepChat';
let container: HTMLDivElement, root: Root;
const key = 'general:11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); sessionStorage.clear();
  state.user = { id: 'qa-user' }; state.assistant.lang = 'en';
  state.assistant.conversations.general = '11111111-1111-4111-8111-111111111111';
  state.assistant.setConversation.mockImplementation((_key, id) => { state.assistant.conversations.general = id; });
  state.assistant.drafts = { [key]: { question: 'Why am I tired?' } };
  state.assistant.saveDraft.mockImplementation((name, draft) => { state.assistant.drafts[name] = draft; });
  state.list.mockResolvedValue([]); state.turns.mockResolvedValue([]);
  state.send.mockImplementation(async input => ({ conversation_id: input.conversation_id, request_id: input.request_id, status: 'completed', answer: 'A saved reply.' }));
  state.remove.mockImplementation(async id => { state.list.mockResolvedValue([]); state.turns.mockResolvedValue([]); return { conversation_id: id, status: 'deleted' }; });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function mount(add?: () => void) { await act(async () => { root.render(<GeneralSleepChat onAddRecord={add} />); }); }
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
const button = (name: string, scope: ParentNode = container) => Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === name)!;
function savedConversation() {
  state.list.mockResolvedValue([{ id: state.assistant.conversations.general, title: 'My sleep conversation', created_at: '2026-11-04T01:00:00Z', updated_at: '2026-11-04T01:00:00Z' }]);
  state.turns.mockResolvedValue([{ id: '22222222-2222-4222-8222-222222222222', conversation_id: state.assistant.conversations.general, question: 'A saved question', answer: 'A saved answer', status: 'completed', language: 'en', error_code: null, created_at: '2026-11-04T01:00:00Z' }]);
}
async function openDelete() { await act(async () => button('Delete conversation').click()); return document.querySelector('[role=dialog]')!; }
describe('General sleep conversation', () => {
  it('sends an ordinary question directly without a recording or consent checkbox', async () => {
    await mount(); expect(container.textContent).toContain('What would you like to talk about?');
    expect(container.querySelector('input[type=checkbox]')).toBeNull();
    expect(container.textContent).toContain('Replies are provided by DeepSeek.');
    await submit(); expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0][0]).toMatchObject({ message: 'Why am I tired?', language: 'en' });
    expect(state.send.mock.calls[0][0]).not.toHaveProperty('ai_consent');
    expect(state.send.mock.calls[0][0]).not.toHaveProperty('recording_id');
  });
  it('keeps the original request and language when checking after reopening', async () => {
    state.send.mockRejectedValueOnce(new Error('network'));
    await mount(); await submit();
    const first = state.send.mock.calls[0][0];
    await act(async () => root.unmount()); root = createRoot(container);
    state.assistant.lang = 'zh';
    await mount();
    const check = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '检查回复')!;
    await act(async () => check.click());
    expect(state.send.mock.calls[1][0]).toEqual(first);
  });
  it('restores a pending cloud turn as a locked original request', async () => {
    state.turns.mockResolvedValue([{ id: '22222222-2222-4222-8222-222222222222', conversation_id: state.assistant.conversations.general, question: 'An earlier question', answer: null, status: 'pending', language: 'zh', error_code: null, created_at: '2026-11-04T01:00:00Z' }]);
    await mount();
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    expect(container.querySelector('textarea')?.value).toBe('An earlier question');
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
    await mount(); await submit();
    const request = state.send.mock.calls[0][0];
    expect(state.send.mock.calls[0][1]).toBe('qa-user');
    await act(async () => root.unmount()); root = createRoot(container);
    state.assistant.saveDraft.mockClear();
    await act(async () => resolve({ conversation_id: request.conversation_id, request_id: request.request_id, status: 'completed', answer: 'Late reply' }));
    expect(state.assistant.saveDraft).not.toHaveBeenCalled();
    expect(state.assistant.drafts[key].question).toBe('Why am I tired?');
  });
  it('confirms deletion with the conversation title, defaults to cancel and does not delete on cancel', async () => {
    savedConversation(); await mount(); const dialog = await openDelete();
    expect(dialog.textContent).toContain('My sleep conversation');
    expect(dialog.textContent).toContain('This cannot be undone.');
    expect(document.activeElement).toBe(button('Cancel', dialog));
    await act(async () => button('Cancel', dialog).click());
    expect(state.remove).not.toHaveBeenCalled(); expect(container.textContent).toContain('A saved answer');
  });
  it('deletes only after confirmation, clears the conversation draft and starts a new chat', async () => {
    savedConversation(); await mount(); const old = state.assistant.conversations.general;
    const dialog = await openDelete();
    await act(async () => button('Delete conversation', dialog).click());
    expect(state.remove).toHaveBeenCalledWith(old, 'qa-user');
    expect(state.assistant.saveDraft).toHaveBeenCalledWith('general:' + old, { question: '' });
    expect(state.assistant.conversations.general).not.toBe(old);
    expect(container.textContent).not.toContain('A saved answer');
    expect(container.textContent).toContain('Conversation deleted.');
  });
  it('retains messages and the confirmation when deletion fails', async () => {
    savedConversation(); state.remove.mockRejectedValueOnce(new Error('network'));
    await mount(); const old = state.assistant.conversations.general; const dialog = await openDelete();
    await act(async () => button('Delete conversation', dialog).click());
    expect(state.assistant.conversations.general).toBe(old);
    expect(container.textContent).toContain('A saved answer');
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('Deletion could not be confirmed.');
    expect(state.assistant.saveDraft).not.toHaveBeenCalled();
  });
  it('disables deletion for unsaved chats and pending replies', async () => {
    await mount(); expect(button('Delete conversation').disabled).toBe(true);
    savedConversation(); state.send.mockReturnValue(new Promise(() => {}));
    await act(async () => root.unmount()); root = createRoot(container); await mount();
    expect(button('Delete conversation').disabled).toBe(false);
    await submit(); expect(button('Delete conversation').disabled).toBe(true);
    expect(state.remove).not.toHaveBeenCalled();
  });
  it('does not clear another account or conversation when an earlier deletion completes late', async () => {
    savedConversation(); let resolve!: (value: any) => void;
    state.remove.mockReturnValue(new Promise(value => { resolve = value; }));
    await mount(); const old = state.assistant.conversations.general; const dialog = await openDelete();
    await act(async () => button('Delete conversation', dialog).click());
    state.user = { id: 'another-account' }; state.assistant.conversations.general = '33333333-3333-4333-8333-333333333333';
    await mount(); state.assistant.saveDraft.mockClear(); state.assistant.setConversation.mockClear();
    await act(async () => resolve({ conversation_id: old, status: 'deleted' }));
    expect(state.assistant.saveDraft).not.toHaveBeenCalled(); expect(state.assistant.setConversation).not.toHaveBeenCalled();
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });
  it('starts a new conversation and keeps the unsent question when another tab deleted the old conversation', async () => {
    savedConversation(); state.send.mockImplementationOnce(async input => ({ conversation_id: input.conversation_id, request_id: input.request_id, status: 'failed', error: 'CONVERSATION_DELETED' }));
    await mount(); const old = state.assistant.conversations.general; await submit();
    expect(state.assistant.conversations.general).not.toBe(old);
    expect(state.assistant.drafts['general:' + state.assistant.conversations.general].question).toBe('Why am I tired?');
    expect(container.textContent).toContain('Your question is kept in a new conversation.');
    expect(container.querySelector('textarea')?.disabled).toBe(false);
  });
});
