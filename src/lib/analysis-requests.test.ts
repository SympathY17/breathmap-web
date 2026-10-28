import { beforeEach, describe, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ rpc: vi.fn(), auth: { getSession: vi.fn() } }));
vi.mock('./supabase', () => ({ supabase: client }));
import { requestJob } from './analysis';

describe('analysis request acknowledgement', () => {
  beforeEach(() => {
    client.rpc.mockReset(); client.auth.getSession.mockReset();
    client.auth.getSession.mockResolvedValue({ data: { session: { user: { id: '11111111-1111-4111-8111-111111111111' } } } });
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  });
  it('reuses the same request key when acknowledgement is lost, then permits a later deliberate action', async () => {
    const payload = { question: 'Explain the selected interval.', ai_consent: true };
    client.rpc.mockResolvedValueOnce({ data: null, error: new Error('Network response lost') }).mockResolvedValue({ data: { id: 'saved-job' }, error: null });
    await expect(requestJob('record-one', 'chat', payload)).rejects.toThrow('Network response lost');
    await requestJob('record-one', 'chat', payload);
    expect(client.rpc.mock.calls[0][1].p_request_key).toBe(client.rpc.mock.calls[1][1].p_request_key);
    await requestJob('record-one', 'chat', payload);
    expect(client.rpc.mock.calls[2][1].p_request_key).not.toBe(client.rpc.mock.calls[1][1].p_request_key);
  });
  it('does not reuse an uncertain request key for different question content', async () => {
    client.rpc.mockResolvedValue({ data: null, error: new Error('Unavailable') });
    await expect(requestJob('record-two', 'chat', { question: 'First question' })).rejects.toThrow();
    await expect(requestJob('record-two', 'chat', { question: 'Different question' })).rejects.toThrow();
    expect(client.rpc.mock.calls[0][1].p_request_key).not.toBe(client.rpc.mock.calls[1][1].p_request_key);
  });
  it('does not send a task without an active session', async () => {
    client.auth.getSession.mockResolvedValue({ data: { session: null } });
    await expect(requestJob('record-three', 'analyse', {})).rejects.toThrow('Sign in');
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
