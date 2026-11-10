// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GuestExperience from './GuestExperience';

let container: HTMLDivElement, root: Root;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('breathmap-language', 'en');
  fetchSpy = vi.fn(() => { throw new Error('The public preview must not request private or live services'); });
  vi.stubGlobal('fetch', fetchSpy);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function mount(props: Parameters<typeof GuestExperience>[0] = {}) { await act(async () => root.render(<GuestExperience {...props} />)); }
function button(text: string) {
  const result = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.trim() === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
async function click(text: string) { await act(async () => button(text).click()); }
function dialog() { return document.querySelector('[role="dialog"]'); }
function setValue(label: string, value: string) {
  const input = Array.from(container.querySelectorAll('label')).find(item => item.textContent?.trim() === label)?.querySelector('input');
  if (!input) throw new Error(`Missing input: ${label}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('public guest preview', () => {
  it('shows saved synthetic results and their limitations without starting a network request', async () => {
    await mount();
    expect(container.textContent).toContain('Synthetic demo data');
    expect(container.textContent).toContain('15.0');
    expect(container.textContent).toContain('7.13');
    expect(container.textContent).toContain('11/11');
    expect(container.textContent).toContain('partial flow and voltage coverage');
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['overview', 'Upload my recording', '/upload'],
    ['overview', 'My saved recordings', '/recordings'],
    ['overview', 'My sleep diary', '/wellbeing?view=diary'],
    ['waveform', 'Analyse my recording', '/upload'],
    ['waveform', 'Ask my own question', '/assistant'],
    ['waveform', 'Save my notes', '/recordings'],
    ['explanation', 'Sign in to ask', '/assistant'],
    ['learn', 'Keep my sleep diary', '/wellbeing?view=diary'],
  ] as const)('gates %s / %s before any account action', async (initialView, label, target) => {
    await mount({ initialView });
    await click(label);
    expect(dialog()).not.toBeNull();
    const signIn = dialog()!.querySelector<HTMLAnchorElement>('a');
    expect(new URL(signIn!.href, window.location.origin).searchParams.get('returnTo')).toBe(target);
    expect(dialog()!.textContent).toContain('New registration is temporarily unavailable');
    expect(dialog()!.querySelector('a[href="/sign-up"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    await click('Continue exploring');
    expect(dialog()).toBeNull();
  });

  it('presents a login gate for a direct private record URL without reading its data', async () => {
    const target = '/analysis?recordId=78f547de-8299-4a44-a565-7742399be7b2&access_token=private';
    await mount({ initialLoginTarget: target });
    expect(dialog()?.textContent).toContain('Sign in to view your saved recordings');
    const href = dialog()!.querySelector('a')!.getAttribute('href')!;
    expect(new URL(href, window.location.origin).searchParams.get('returnTo')).toBe('/analysis?recordId=78f547de-8299-4a44-a565-7742399be7b2');
    expect(href).not.toContain('access_token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads a local interval, rejects invalid edits and preserves channel gaps', async () => {
    await mount({ initialView: 'waveform' });
    await act(async () => { setValue('Start (seconds)', '12'); setValue('End (seconds)', '22'); });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Showing 12–22 seconds');
    expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(3);
    expect(container.querySelector('svg[aria-label^="Magnetic signal"]')?.getAttribute('aria-label')).toContain('12–22');
    await act(async () => { setValue('Start (seconds)', '25'); setValue('End (seconds)', '20'); });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('end after the start');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Showing 12–22 seconds');
    await act(async () => { setValue('Start (seconds)', '0'); setValue('End (seconds)', '60'); });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const flowPath = container.querySelector('svg[aria-label^="Estimated expiratory flow"] path')?.getAttribute('d')!;
    expect(flowPath).not.toMatch(/NaN|Infinity/);
    // This fixture has unavailable leading flow samples and trailing SIG samples,
    // rather than an interior gap. Their paths must stop at the real data bounds.
    expect(flowPath).toMatch(/^M88\.33,/);
    const sigPath = container.querySelector('svg[aria-label^="SIG differential voltage"] path')?.getAttribute('d')!;
    expect(sigPath).toMatch(/L883\.42,[\d.]+\s*$/);
    expect(sigPath).not.toMatch(/NaN|Infinity/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('follows a saved explanation citation into its exact local waveform interval', async () => {
    await mount({ initialView: 'explanation' });
    expect(container.textContent).toContain('Your visit does not send a new AI request');
    const researchClaim = Array.from(container.querySelectorAll('.guest-saved-claim')).find(item => item.textContent?.includes('frozen research model'))!;
    await act(async () => researchClaim.querySelector<HTMLButtonElement>('button')!.click());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Demo waveform');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Showing 50–60 seconds');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('supports keyboard section navigation and switches the login explanation language', async () => {
    await mount();
    const overview = button('Overview'); overview.focus();
    await act(async () => overview.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Sleep guide');
    expect(document.activeElement?.textContent).toBe('Sleep guide');
    await click('中文');
    expect(container.getAttribute('lang')).toBeNull();
    expect(container.querySelector('main')?.lang).toBe('zh-CN');
    await click('记录我的睡眠日记');
    expect(dialog()?.textContent).toContain('登录后记录你的睡眠日记');
    expect(dialog()?.textContent).toContain('注册暂未开放');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the public demo separate when an existing user visits it', async () => {
    await mount({ signedIn: true });
    const workspace = Array.from(container.querySelectorAll('a')).find(item => item.textContent === 'Go to workspace');
    expect(workspace?.getAttribute('href')).toBe('/');
    expect(container.textContent).toContain('Synthetic demo data');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
