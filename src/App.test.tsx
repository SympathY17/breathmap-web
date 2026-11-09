// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ user: { id: 'qa-user' } as { id: string } | null, loading: false, error: '' }));
const config = vi.hoisted(() => ({ ready: true }));
vi.mock('./lib/user', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => auth,
}));
vi.mock('./lib/supabase', () => ({ get isConfigured() { return config.ready; } }));
vi.mock('./AuthPages', () => ({ default: ({ path }: { path: string }) => <main data-auth-path={path}>Account access</main> }));
vi.mock('./AnalysisPanel', () => ({ default: () => <main>Recording analysis</main> }));
vi.mock('./AssistantPage', () => ({ default: () => <main>Sleep chat</main> }));
vi.mock('./guest/GuestExperience', () => ({ default: ({ initialLoginTarget, initialView, signedIn }: { initialLoginTarget?: string; initialView?: string; signedIn?: boolean }) => <main data-guest-target={initialLoginTarget} data-guest-view={initialView} data-guest-signed-in={String(!!signedIn)}>Public synthetic demo</main> }));
vi.mock('./components/AssistantProvider', () => ({ AssistantProvider: ({ children }: { children: ReactNode }) => children }));
// These deliberately do not check auth themselves: the outer layout must prevent mounting workspace chrome.
vi.mock('./components/DesktopNavigation', () => ({ default: () => <aside data-workspace-chrome>Desktop navigation</aside> }));
vi.mock('./components/MobileNavigation', () => ({ default: () => <nav data-workspace-chrome>Mobile navigation</nav> }));
vi.mock('./components/AssistantSurface', () => ({ default: () => <section data-workspace-chrome>Assistant panel</section> }));

import App from './App';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  auth.user = { id: 'qa-user' }; auth.loading = false; auth.error = '';
  config.ready = true;
  window.history.replaceState(null, '', '/assistant');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  await act(async () => root.render(<App />));
}
function expectStandalone() {
  expect(container.querySelector('.workspace-shell')).toBeNull();
  expect(container.querySelector('.workspace-content')).toBeNull();
  expect(container.querySelector('[data-workspace-chrome]')).toBeNull();
}

describe('authentication layout boundary', () => {
  it.each(['/', '/demo', '/learn'])('opens public examples at %s without an account', async path => {
    auth.user = null;
    await renderAt(path);
    expectStandalone();
    expect(container.querySelector('[data-guest-view]')?.getAttribute('data-guest-view')).toBe(path === '/learn' ? 'learn' : 'overview');
    expect(container.querySelector('[data-guest-target]')).toBeNull();
    expect(container.querySelector('[data-auth-path]')).toBeNull();
  });

  it.each(['/upload', '/recordings', '/account', '/assistant', '/wellbeing?view=diary', '/analysis?recordId=22222222-2222-4222-8222-222222222222'])('gates private %s without mounting private content', async path => {
    auth.user = null;
    await renderAt(path);
    expectStandalone();
    expect(container.querySelector('[data-guest-target]')?.getAttribute('data-guest-target')).toBe(path);
    expect(container.textContent).not.toContain('Recording analysis');
    expect(container.textContent).not.toContain('Sleep chat');
    expect(container.querySelector('[data-auth-path]')).toBeNull();
  });

  it.each(['/login', '/sign-up', '/forgot-password', '/reset-password/'])('keeps explicit auth route %s standalone even with a session', async path => {
    await renderAt(path);
    expectStandalone();
    expect(container.querySelector('[data-auth-path]')?.getAttribute('data-auth-path')).toBe(path.replace(/\/$/, ''));
  });

  it('waits for restored authentication before mounting workspace navigation', async () => {
    auth.loading = true;
    await renderAt('/assistant');
    expectStandalone();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Opening BreathMap…');

    auth.loading = false;
    await renderAt('/assistant');
    expect(container.querySelector('.workspace-shell')?.textContent).toContain('Sleep chat');
    expect(container.querySelectorAll('[data-workspace-chrome]')).toHaveLength(3);
  });

  it('preserves the workspace around the signed-in account screen', async () => {
    await renderAt('/account');
    expect(container.querySelector('.workspace-shell [data-auth-path="/account"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-workspace-chrome]')).toHaveLength(3);
  });

  it('keeps the public demo independent of database configuration and session loading', async () => {
    auth.user = null; auth.loading = true; config.ready = false;
    await renderAt('/demo');
    expectStandalone();
    expect(container.textContent).toContain('Public synthetic demo');
    auth.loading = false;
    await renderAt('/');
    expect(container.textContent).toContain('Public synthetic demo');
  });

  it('does not swallow a failed email or recovery callback behind the public landing page', async () => {
    auth.user = null; auth.error = 'This sign-in link is invalid';
    await renderAt('/?code=expired');
    expectStandalone();
    expect(container.querySelector('[data-auth-path="/login"]')).not.toBeNull();
  });

  it('allows signed-in people to preview the same public example without mounting live tools', async () => {
    await renderAt('/demo');
    expectStandalone();
    expect(container.querySelector('[data-guest-signed-in="true"]')).not.toBeNull();
  });

  it('shows a genuine not-found page for unknown public paths', async () => {
    auth.user = null;
    await renderAt('/unknown-page');
    expectStandalone();
    expect(container.textContent).toContain('Page not found');
    expect(container.querySelector('[data-guest-target]')).toBeNull();
  });

  it('removes the workspace shell when the current session is signed out', async () => {
    await renderAt('/assistant');
    expect(container.querySelector('.workspace-shell')).not.toBeNull();
    auth.user = null;
    await renderAt('/assistant');
    expectStandalone();
    expect(container.querySelector('[data-guest-target="/assistant"]')).not.toBeNull();
  });
});
