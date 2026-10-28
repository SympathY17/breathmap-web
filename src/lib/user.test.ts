import { describe, expect, it, vi } from 'vitest';
vi.mock('./supabase', () => ({ supabase: null, isConfigured: false }));
import { restoreAuthSession } from './user';

describe('restoring an authentication callback', () => {
  it('preserves a rejected PKCE callback when getSession returns no error', async () => {
    const auth = {
      initialize: vi.fn().mockResolvedValue({ error: { message: 'code verifier missing' } }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    };
    const restored = await restoreAuthSession(auth as any);
    expect(restored.session).toBeNull();
    expect(restored.error).toContain('Request a new link');
    expect(restored.error).not.toContain('code verifier');
    expect(auth.initialize.mock.invocationCallOrder[0]).toBeLessThan(auth.getSession.mock.invocationCallOrder[0]);
  });
  it('keeps an existing session after successful initialization', async () => {
    const session = { user: { id: 'owned-user' } };
    const restored = await restoreAuthSession({
      initialize: vi.fn().mockResolvedValue({ error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    } as any);
    expect(restored).toEqual({ session, error: '' });
  });
  it.each([
    'https://breathmap.example/reset-password?code=expired-fixture',
    'https://breathmap.example/#access_token=unsupported-fixture&type=magiclink',
  ])('explains an unrecognized callback without a restored session: %s', async callbackUrl => {
    const restored = await restoreAuthSession({
      initialize: vi.fn().mockResolvedValue({ error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    } as any, callbackUrl);
    expect(restored.error).toContain('Request a new link');
  });
  it('does not report a valid restored callback as expired', async () => {
    const session = { user: { id: 'owned-user' } };
    const restored = await restoreAuthSession({
      initialize: vi.fn().mockResolvedValue({ error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    } as any, 'https://breathmap.example/reset-password?code=valid-fixture');
    expect(restored).toEqual({ session, error: '' });
  });
  it('does not hide an independent session restoration failure', async () => {
    const restored = await restoreAuthSession({
      initialize: vi.fn().mockResolvedValue({ error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: { message: 'network' } }),
    } as any);
    expect(restored.error).toContain('Please sign in again');
  });
});
