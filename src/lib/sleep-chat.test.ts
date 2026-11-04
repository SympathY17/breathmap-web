import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('./supabase', () => ({ requireSupabase: () => ({ auth: { getSession: state.getSession } }) }));
import { sendSleepQuestion } from './sleep-chat';
const request = { conversation_id: '11111111-1111-4111-8111-111111111111', request_id: '22222222-2222-4222-8222-222222222222', message: 'A question from account A', language: 'en' as const, ai_consent: true as const };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('sleep chat request account binding', () => {
  it('refuses a changed account returned after session lookup without sending the old question', async () => {
    let resolve!: (value: any) => void;
    state.getSession.mockReturnValue(new Promise(value => { resolve = value; }));
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const response = sendSleepQuestion(request, 'account-a');
    resolve({ data: { session: { access_token: 'token-b', user: { id: 'account-b' } } }, error: null });
    expect(await response).toMatchObject({ status: 'failed', error: 'AUTH_REQUIRED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends only when the resolved token belongs to the initiating account', async () => {
    state.getSession.mockResolvedValue({ data: { session: { access_token: 'token-a', user: { id: 'account-a' } } }, error: null });
    const fetcher = vi.fn().mockResolvedValue({ json: async () => ({ conversation_id: request.conversation_id, request_id: request.request_id, status: 'completed', answer: 'Reply' }) });
    vi.stubGlobal('fetch', fetcher);
    expect(await sendSleepQuestion(request, 'account-a')).toMatchObject({ status: 'completed' });
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer token-a');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(request);
  });
});
