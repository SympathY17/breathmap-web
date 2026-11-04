// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ user: { id: 'qa-user' } as any, loading: false }));
vi.mock('../lib/user', () => ({ useAuth: () => auth }));
import DesktopNavigation from './DesktopNavigation';
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  auth.user = { id: 'qa-user' }; auth.loading = false;
  localStorage.setItem('breathmap-language', 'en');
  window.history.replaceState(null, '', '/');
  container = document.createElement('div'); container.id = 'root'; document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function mount() { await act(async () => root.render(<DesktopNavigation />)); }
describe('Desktop workspace navigation', () => {
  it('hides the authenticated rail during sign-out and recovery', async () => {
    auth.user = null; await mount(); expect(container.querySelector('aside')).toBeNull();
    auth.user = { id: 'qa-user' }; window.history.replaceState(null, '', '/reset-password'); await mount(); expect(container.querySelector('aside')).toBeNull();
  });
  it('opens general sleep chat from global navigation without implicitly attaching a recording', async () => {
    window.history.replaceState(null, '', '/analysis?recordId=qa-record'); await mount();
    expect(container.querySelector('a[aria-current="page"]')?.textContent).toBe('History');
    expect(container.querySelector<HTMLAnchorElement>('a[href^="/assistant"]')?.getAttribute('href')).toBe('/assistant');
  });
  it('routes navigation through the existing unsaved-edit guard', async () => {
    window.history.replaceState(null, '', '/wellbeing?view=diary&ctxDate=2026-11-04&ctxRecord=qa-record'); await mount();
    const handler = vi.fn(); window.addEventListener('breathmap:tool-select', handler);
    const target = container.querySelector<HTMLAnchorElement>('a[href*="view=trends"]')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ view: 'trends', context: { date: '2026-11-04', recordingId: 'qa-record' } });
    await act(async () => container.querySelector<HTMLAnchorElement>('a[href^="/assistant"]')!.click());
    expect((handler.mock.calls[1][0] as CustomEvent).detail).toEqual({ page: 'assistant' });
    window.removeEventListener('breathmap:tool-select', handler);
  });
});
