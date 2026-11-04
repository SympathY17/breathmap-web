// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ user: { id: 'synthetic-user' } as any, loading: false }));
vi.mock('../lib/user', () => ({ useAuth: () => auth }));
import MobileNavigation from './MobileNavigation';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  auth.user = { id: 'synthetic-user' }; auth.loading = false;
  localStorage.setItem('breathmap-language', 'en');
  window.history.replaceState(null, '', '/');
  container = document.createElement('div'); container.id = 'root';
  document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function mount() { await act(async () => root.render(<MobileNavigation />)); }

describe('Mobile navigation preserves existing app destinations', () => {
  it('is absent while signed out, loading or on a sign-in page', async () => {
    auth.user = null; await mount(); expect(container.querySelector('nav')).toBeNull();
    auth.user = { id: 'synthetic-user' }; auth.loading = true; await mount(); expect(container.querySelector('nav')).toBeNull();
    auth.loading = false; window.history.replaceState(null, '', '/login'); await mount(); expect(container.querySelector('nav')).toBeNull();
  });
  it('groups detailed analysis under Records and keeps the five primary destinations', async () => {
    window.history.replaceState(null, '', '/analysis?recordId=synthetic-record'); await mount();
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Records');
    expect([...container.querySelectorAll('nav > a')].map(a => a.getAttribute('href'))).toEqual(['/', '/recordings', '/wellbeing?view=diary', '/learn']);
    expect(container.querySelector('button')?.getAttribute('aria-haspopup')).toBe('dialog');
  });
  it('switches wellbeing tools through the existing guarded route event and preserves context', async () => {
    window.history.replaceState(null, '', '/wellbeing?view=trends&ctxDate=2026-10-28&ctxRecord=synthetic-record');
    await mount();
    const diary = container.querySelector<HTMLAnchorElement>('a[href^="/wellbeing"]')!;
    expect(diary.getAttribute('href')).toContain('ctxRecord=synthetic-record');
    expect(diary.getAttribute('href')).toContain('ctxDate=2026-10-28');
    const route = vi.fn(); window.addEventListener('breathmap:tool-select', route);
    await act(async () => diary.click());
    expect(route).toHaveBeenCalledOnce();
    expect((route.mock.calls[0][0] as CustomEvent).detail).toEqual({ view: 'diary', context: { date: '2026-10-28', recordingId: 'synthetic-record' } });
    window.removeEventListener('breathmap:tool-select', route);
  });
  it('uses the existing leave-page guard when leaving an editable wellbeing view', async () => {
    window.history.replaceState(null, '', '/wellbeing?view=diary'); await mount();
    const route = vi.fn(); window.addEventListener('breathmap:tool-select', route);
    await act(async () => container.querySelector<HTMLAnchorElement>('a[href="/"]')!.click());
    expect((route.mock.calls[0][0] as CustomEvent).detail).toEqual({ page: 'home' });
    window.removeEventListener('breathmap:tool-select', route);
  });
  it('opens general sleep chat in More without implicitly attaching a record', async () => {
    window.history.replaceState(null, '', '/analysis?recordId=synthetic-record&ctxDate=2026-10-28');
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('nav > button')!.click());
    const assistant = document.querySelector<HTMLAnchorElement>('[role="dialog"] a[href^="/assistant"]')!;
    expect(assistant.textContent).toBe('AI assistant');
    const destination = new URL(assistant.href);
    expect(destination.searchParams.get('recordId')).toBeNull();
    expect(destination.searchParams.get('ctxDate')).toBeNull();
    expect([...container.querySelectorAll('nav > a')].map(a => a.textContent)).toEqual(['Home', 'Records', 'Diary', 'Learn']);
  });
  it('routes the assistant through the wellbeing leave guard rather than navigating directly', async () => {
    window.history.replaceState(null, '', '/wellbeing?view=diary&ctxRecord=synthetic-record&ctxDate=2026-10-28');
    await mount();
    const route = vi.fn(); window.addEventListener('breathmap:tool-select', route);
    await act(async () => container.querySelector<HTMLButtonElement>('nav > button')!.click());
    const assistant = document.querySelector<HTMLAnchorElement>('[role="dialog"] a[href^="/assistant"]')!;
    expect(new URL(assistant.href).searchParams.get('recordId')).toBeNull();
    await act(async () => assistant.click());
    expect(route).toHaveBeenCalledOnce();
    expect((route.mock.calls[0][0] as CustomEvent).detail).toEqual({ page: 'assistant' });
    window.removeEventListener('breathmap:tool-select', route);
  });
  it('marks the assistant as the current More destination', async () => {
    window.history.replaceState(null, '', '/assistant?recordId=synthetic-record'); await mount();
    expect(container.querySelector('nav > button')?.getAttribute('data-current')).toBe('true');
    await act(async () => container.querySelector<HTMLButtonElement>('nav > button')!.click());
    expect(document.querySelector('[role="dialog"] a[aria-current="page"]')?.textContent).toBe('AI assistant');
  });
});
