import { describe, expect, it } from 'vitest';
import { loginHref, safeReturnTo } from './auth-return';

const recordId = '11111111-1111-4111-8111-111111111111';
describe('safe post-login destinations', () => {
  it.each(['/upload', '/recordings', '/assistant', '/account', '/demo', '/learn', '/'])('keeps the internal destination %s', target => {
    expect(safeReturnTo(target)).toBe(target);
  });

  it.each([undefined, null, 42, '', 'https://evil.example/upload', 'https://breathmap.invalid/upload', '//evil.example/upload', '/\\evil.example', '/upload\n', '/unknown', '/login?returnTo=/upload', '/sign-up', '/forgot-password', '/reset-password'])('rejects an external, unknown or looping destination %s', target => {
    expect(safeReturnTo(target)).toBe('/');
  });

  it('removes callback secrets, arbitrary text, nested redirects and fragments while preserving the requested record', () => {
    expect(safeReturnTo(`/analysis?recordId=${recordId}&access_token=secret&refresh_token=secret&code=secret&token_hash=secret&email=private%40example.com&question=private&returnTo=https://evil.example#access_token=secret`)).toBe(`/analysis?recordId=${recordId}`);
  });

  it('preserves validated date and tool context without accepting arbitrary values', () => {
    const result = new URL(safeReturnTo(`/wellbeing/?view=diary&ctxDate=2026-11-09&ctxRecord=${recordId}&ctxPlan=bad`), 'https://breathmap.invalid');
    expect(result.pathname).toBe('/wellbeing');
    expect(Object.fromEntries(result.searchParams)).toEqual({ ctxRecord: recordId, ctxDate: '2026-11-09', view: 'diary' });
    expect(safeReturnTo('/wellbeing?view=evil&ctxDate=2026-02-31')).toBe('/wellbeing');
    expect(safeReturnTo('/wellbeing?ctxDate=2026-99-99')).toBe('/wellbeing');
  });

  it('preserves a valid analysis selection and drops a malformed one', () => {
    const target = new URL(safeReturnTo(`/analysis?recordId=${recordId}&result=${'a'.repeat(64)}&start=1.5&end=5&windowId=MW-1&kind=model#secret`), 'https://breathmap.invalid');
    expect(Object.fromEntries(target.searchParams)).toEqual({ recordId, result: 'a'.repeat(64), start: '1.5', end: '5', windowId: 'MW-1', kind: 'model' });
    expect(safeReturnTo('/analysis?recordId=demo&result=secret&start=-1&end=5&windowId=1&kind=model')).toBe('/analysis');
    expect(safeReturnTo('/analysis?start=&end=5')).toBe('/analysis');
  });

  it('encodes the sanitized target once when building a login link', () => {
    const href = loginHref('/wellbeing?view=diary&access_token=secret');
    const login = new URL(href, 'https://breathmap.invalid');
    expect(login.pathname).toBe('/login');
    expect(login.searchParams.get('returnTo')).toBe('/wellbeing?view=diary');
    expect(href).not.toContain('secret');
    expect(new URL(loginHref('//evil.example'), 'https://breathmap.invalid').searchParams.get('returnTo')).toBe('/');
  });
});
