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
  it('does not hide an independent session restoration failure', async () => {
    const restored = await restoreAuthSession({
      initialize: vi.fn().mockResolvedValue({ error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: { message: 'network' } }),
    } as any);
    expect(restored.error).toContain('Please sign in again');
  });
});
