// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ user: { id: 'qa-user' } as { id: string } | null, loading: false, error: '' }));
vi.mock('./lib/user', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => auth,
}));
vi.mock('./lib/supabase', () => ({ isConfigured: true }));
vi.mock('./AuthPages', () => ({ default: ({ path }: { path: string }) => <main data-auth-path={path}>Account access</main> }));
vi.mock('./AnalysisPanel', () => ({ default: () => <main>Recording analysis</main> }));
vi.mock('./AssistantPage', () => ({ default: () => <main>Sleep chat</main> }));
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
  it.each(['/', '/recordings', '/analysis?recordId=qa-record', '/account'])('keeps anonymous %s outside the workspace shell', async path => {
    auth.user = null;
    await renderAt(path);
    expectStandalone();
    expect(container.querySelector('[data-auth-path]')?.getAttribute('data-auth-path')).toBe(path === '/account' ? '/account' : '/login');
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

  it('removes the workspace shell when the current session is signed out', async () => {
    await renderAt('/assistant');
    expect(container.querySelector('.workspace-shell')).not.toBeNull();
    auth.user = null;
    await renderAt('/assistant');
    expectStandalone();
    expect(container.querySelector('[data-auth-path="/login"]')).not.toBeNull();
  });
});
