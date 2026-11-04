import { describe, expect, it, vi } from 'vitest';
import { handleSleepChat } from '../netlify/functions/sleep-chat.mjs';

const owner = '11111111-1111-4111-8111-111111111111';
const conversation = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const environment = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-key', SUPABASE_SECRET_KEY: 'server-key', DEEPSEEK_API_KEY: 'provider-key' };
const body = { conversation_id: conversation, request_id: requestId, message: 'How can I improve my bedtime routine?', language: 'en', ai_consent: true };
const respond = (value, status = 200) => new Response(JSON.stringify(value), { status });
const request = (value = body, headers = {}) => new Request('https://breathmap.example/.netlify/functions/sleep-chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user-jwt', ...headers }, body: JSON.stringify(value) });
const deps = fetch => ({ fetch, env: key => environment[key] });
function service(options = {}) {
  return vi.fn(async (url, init) => {
    if (url.endsWith('/auth/v1/user')) return respond(options.user ?? { id: owner }, options.authStatus ?? 200);
    if (url.endsWith('/begin_sleep_chat')) return respond(options.claim ?? { status: 'claimed', history: [] }, options.claimStatus ?? 200);
    if (url.endsWith('/finish_sleep_chat')) {
      if (options.finishFails) throw new Error('database temporarily unavailable');
      return respond({ status: 'completed' });
    }
    if (url === 'https://api.deepseek.com/chat/completions') {
      if (options.providerError) throw options.providerError;
      return respond(options.providerResponse ?? { choices: [{ message: { content: 'Try a consistent wind-down routine.' } }] }, options.providerStatus ?? 200);
    }
    throw new Error('Unexpected network access: ' + url);
  });
}

describe('general sleep chat endpoint', () => {
  it('rejects unauthenticated, cross-origin and oversized requests without contacting any service', async () => {
    const fetch = service();
    expect((await handleSleepChat(request(body, { Authorization: '' }), deps(fetch))).status).toBe(401);
    expect((await handleSleepChat(request(body, { Origin: 'https://other.example' }), deps(fetch))).status).toBe(403);
    expect((await handleSleepChat(request({ ...body, message: 'x'.repeat(9000) }), deps(fetch))).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires explicit consent, an owned session identity and bounded valid input', async () => {
    const fetch = service();
    expect((await handleSleepChat(request({ ...body, ai_consent: false }), deps(fetch))).status).toBe(400);
    expect((await handleSleepChat(request({ ...body, message: 'x'.repeat(801) }), deps(fetch))).status).toBe(400);
    expect((await handleSleepChat(request({ ...body, conversation_id: '../../recordings' }), deps(fetch))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    const rejected = service({ authStatus: 401 });
    expect((await handleSleepChat(request(), deps(rejected))).status).toBe(401);
    expect(rejected).toHaveBeenCalledTimes(1);
    const anonymous = service({ user: { id: owner, is_anonymous: true } });
    expect((await handleSleepChat(request(), deps(anonymous))).status).toBe(401);
    expect(anonymous).toHaveBeenCalledTimes(1);
  });
  it('uses the verified owner, stores the answer and sends only bounded conversation context', async () => {
    const fetch = service({ claim: { status: 'claimed', history: Array.from({ length: 8 }, (_, i) => ({ question: 'question ' + i, answer: 'a'.repeat(3000) })) } });
    const response = await handleSleepChat(request({ ...body, user_id: 'forged-owner' }), deps(fetch));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'completed', answer: 'Try a consistent wind-down routine.' });
    const start = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('/begin_sleep_chat'))[1].body);
    expect(start.p_user_id).toBe(owner);
    const provider = fetch.mock.calls.find(([url]) => url.includes('deepseek'))[1];
    const payload = JSON.parse(provider.body);
    expect(payload.messages).toHaveLength(14);
    expect(payload.messages[0].content).toContain('no access');
    expect(payload.messages[0].content).toContain('Answer in English');
    expect(payload.messages[2].content).toHaveLength(2400);
    expect(payload.messages.at(-1).content).toBe(body.message);
    expect(fetch.mock.calls.some(([url]) => /recordings|diary|analysis_results/.test(url))).toBe(false);
    const finish = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('/finish_sleep_chat'))[1].body);
    expect(finish).toEqual({ p_user_id: owner, p_request_id: requestId, p_answer: 'Try a consistent wind-down routine.', p_error: null });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('returns completed, pending or failed duplicate requests without a second paid call', async () => {
    for (const [status, code] of [['completed',200],['pending',202],['failed',502]]) {
      const fetch = service({ claim: { status, answer: status === 'completed' ? 'Saved answer' : null, error: status === 'failed' ? 'AI_TIMEOUT' : null } });
      const response = await handleSleepChat(request(), deps(fetch));
      expect(response.status).toBe(code);
      expect((await response.json()).status).toBe(status);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });
  it('obeys atomic database rate limits, ownership and request-id conflicts before billing', async () => {
    for (const [error, status] of [['RATE_LIMITED',429],['CONVERSATION_BUSY',409],['CONVERSATION_NOT_FOUND',404],['REQUEST_ID_CONFLICT',409]]) {
      const fetch = service({ claim: { message: error }, claimStatus: 400 });
      const response = await handleSleepChat(request(), deps(fetch));
      expect(response.status).toBe(status);
      expect((await response.json()).error).toBe(error);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });
  it('records provider failure without exposing provider internals or attempting an automatic retry', async () => {
    const fetch = service({ providerResponse: { error: { message: 'private provider details' } }, providerStatus: 401 });
    const response = await handleSleepChat(request(), deps(fetch));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ status: 'failed', error: 'AI_UNAVAILABLE' });
    expect(fetch.mock.calls.filter(([url]) => url.includes('deepseek'))).toHaveLength(1);
    const finish = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('/finish_sleep_chat'))[1].body);
    expect(finish.p_answer).toBeNull(); expect(finish.p_error).toBe('AI_UNAVAILABLE');
  });
  it('handles timeout and malformed AI answers as explicit failed turns', async () => {
    for (const option of [{ providerError: new DOMException('timeout', 'TimeoutError') }, { providerResponse: { choices: [] } }]) {
      const fetch = service(option);
      const response = await handleSleepChat(request(), deps(fetch));
      expect([502,504]).toContain(response.status);
      expect((await response.json()).status).toBe('failed');
      expect(fetch.mock.calls.filter(([url]) => url.includes('deepseek'))).toHaveLength(1);
    }
  });
  it('keeps billing uncertainty pending if answer persistence fails', async () => {
    const fetch = service({ finishFails: true });
    const response = await handleSleepChat(request(), deps(fetch));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'pending', error: 'RESULT_PENDING' });
    expect(fetch.mock.calls.filter(([url]) => url.includes('deepseek'))).toHaveLength(1);
  });
});
