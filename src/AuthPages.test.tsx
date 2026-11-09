// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ signUp: vi.fn(), resetPasswordForEmail: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() }));
const auth = vi.hoisted(() => ({ user: null as null | { id: string; email: string; fullName: string } }));
vi.mock('./lib/supabase', () => ({ supabase: { auth: api } }));
vi.mock('./lib/user', () => ({ useAuth: () => auth }));
import AuthPages from './AuthPages';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  auth.user = null;
  window.history.replaceState(null, '', '/login');
  localStorage.setItem('breathmap-language', 'zh');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function submitAt(path: string) {
  await act(async () => root.render(<AuthPages path={path} />));
  const form = container.querySelector('form')!;
  // The API is mocked: no email, real password or account is created by these error-state checks.
  if (path === '/sign-up') {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      input.click();
      const passwords = container.querySelectorAll<HTMLInputElement>('input[type="password"]');
      for (const password of passwords) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(password, 'Synthetic-only-password-123');
        password.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

describe('account email failure messages', () => {
  it('explains the signup email limit without reporting account creation as successful', async () => {
    api.signUp.mockResolvedValue({ data: {}, error: Object.assign(new Error('email rate limit exceeded'), { code: 'over_email_send_rate_limit', status: 429 }) });
    await submitAt('/sign-up');
    expect(api.signUp).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('验证邮件发送已达上限');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button.solid-button')?.disabled).toBe(false);
  });

  it('also explains a rate-limited password recovery in the selected language', async () => {
    localStorage.setItem('breathmap-language', 'en');
    api.resetPasswordForEmail.mockResolvedValue({ error: new Error('email rate limit exceeded') });
    await submitAt('/forgot-password');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('verification email sending limit');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('distinguishes an unauthorized email destination from invalid login credentials', async () => {
    api.resetPasswordForEmail.mockResolvedValue({ error: Object.assign(new Error('Email address not authorized'), { code: 'email_address_not_authorized' }) });
    await submitAt('/forgot-password');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('完成发信配置');
  });

  it('keeps other sign-in errors unchanged', async () => {
    api.signInWithPassword.mockResolvedValue({ error: new Error('Invalid login credentials') });
    await submitAt('/login');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Invalid login credentials');
  });
});

describe('guest entry and login return', () => {
  it('offers guest browsing and explains unavailable registration without a signup link', async () => {
    await act(async () => root.render(<AuthPages path="/login" />));
    expect(container.querySelector<HTMLAnchorElement>('a[href="/demo"]')?.textContent).toBe('游客体验');
    expect(container.textContent).toContain('注册暂未开放');
    expect(container.querySelector('a[href="/sign-up"]')).toBeNull();
    expect(container.querySelector('a[href="/forgot-password"]')).not.toBeNull();
    expect(api.signUp).not.toHaveBeenCalled();
  });

  it.each([
    ['/upload', '/upload'],
    ['/wellbeing?view=diary&code=secret', '/wellbeing?view=diary'],
    ['//evil.example', '/'],
  ])('returns to a sanitized destination after signing in: %s', async (returnTo, expected) => {
    const redirect = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    window.history.replaceState(null, '', '/login?' + new URLSearchParams({ returnTo }));
    api.signInWithPassword.mockResolvedValue({ error: null });
    await submitAt('/login');
    expect(api.signInWithPassword).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledWith(expected);
  });

  it('honors the same return destination when the login page already has a session', async () => {
    const redirect = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    auth.user = { id: 'qa-user', email: 'synthetic@example.invalid', fullName: 'Synthetic' };
    window.history.replaceState(null, '', '/login?returnTo=%2Fassistant');
    await act(async () => root.render(<AuthPages path="/login" />));
    expect(redirect).toHaveBeenCalledWith('/assistant');
    expect(api.signInWithPassword).not.toHaveBeenCalled();
  });

  it('keeps sign-out directed to login rather than the requested return destination', async () => {
    const redirect = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    auth.user = { id: 'qa-user', email: 'synthetic@example.invalid', fullName: 'Synthetic' };
    window.history.replaceState(null, '', '/account?returnTo=%2Fassistant');
    api.signOut.mockResolvedValue({ error: null });
    await act(async () => root.render(<AuthPages path="/account" />));
    const signOut = Array.from(container.querySelectorAll<HTMLButtonElement>('.auth-links button')).find(button => button.textContent === '退出登录')!;
    await act(async () => signOut.click());
    expect(api.signOut).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledWith('/login');
  });
});
