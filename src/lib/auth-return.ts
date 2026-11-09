const allowedPaths = new Set(['/', '/demo', '/recordings', '/upload', '/report', '/analysis', '/trash', '/preferences', '/security', '/learn', '/wellbeing', '/assistant', '/account']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toolViews = new Set(['monitoring', 'trends', 'diary', 'reaction', 'routine', 'relax', 'visits']);

/** Keep only known internal destinations and navigation context, never callback tokens or free text. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  const base = 'https://breathmap.invalid';
  let url: URL;
  try { url = new URL(value, base); } catch { return '/'; }
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (url.origin !== base || !allowedPaths.has(path)) return '/';
  const query = new URLSearchParams();
  for (const key of ['recordId', 'record', 'ctxRecord', 'ctxPlan']) {
    const id = url.searchParams.get(key);
    if (id && uuid.test(id)) query.set(key, id);
  }
  const date = url.searchParams.get('ctxDate');
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const parsed = new Date(date);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date) query.set('ctxDate', date);
  }
  const view = url.searchParams.get('view');
  if (path === '/wellbeing' && view && toolViews.has(view)) query.set('view', view);
  if (['/analysis', '/report', '/assistant'].includes(path)) {
    const hash = url.searchParams.get('result');
    if (hash && /^[0-9a-f]{64}$/.test(hash)) query.set('result', hash);
    const start = url.searchParams.get('start'), end = url.searchParams.get('end');
    if (start !== null && end !== null && start.trim() && end.trim() && Number.isFinite(Number(start)) && Number.isFinite(Number(end)) && Number(start) >= 0 && Number(end) > Number(start) && Number(end) <= 43200) {
      query.set('start', String(Number(start))); query.set('end', String(Number(end)));
      const windowId = url.searchParams.get('windowId'), kind = url.searchParams.get('kind');
      if (windowId && /^[\w.-]{1,80}$/.test(windowId) && kind && ['model', 'statistics', 'attention'].includes(kind)) { query.set('windowId', windowId); query.set('kind', kind); }
    }
  }
  return path + (query.size ? '?' + query : '');
}

export function loginHref(returnTo: string): string {
  return '/login?' + new URLSearchParams({ returnTo: safeReturnTo(returnTo) });
}
