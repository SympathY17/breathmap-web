export type AssistantSelection = {
  start_s: number;
  end_s: number;
  window_id?: string;
  kind?: 'model' | 'statistics' | 'attention';
};
export type AssistantTarget = { recordingId: string; resultHash?: string; selection?: AssistantSelection };
export type AssistantContext = { version: 1; conversation_id: string; selection?: AssistantSelection; previous_job_id?: string };
export const ASSISTANT_QUESTION_LIMIT = 800;
export const assistantUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const assistantHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function validSelection(value: unknown, duration?: number): AssistantSelection | undefined {
  const selection = value as AssistantSelection;
  if (!selection || !Number.isFinite(selection.start_s) || !Number.isFinite(selection.end_s)
    || selection.start_s < 0 || selection.end_s <= selection.start_s || selection.end_s > (duration ?? 43200)) return;
  if (selection.window_id !== undefined && (typeof selection.window_id !== 'string' || !/^[\w.-]{1,80}$/.test(selection.window_id))) return;
  if (selection.kind !== undefined && !['model', 'statistics', 'attention'].includes(selection.kind)) return;
  if (selection.window_id && !selection.kind) return;
  return { start_s: selection.start_s, end_s: selection.end_s,
    ...(selection.window_id ? { window_id: selection.window_id, kind: selection.kind } : {}) };
}

export function assistantTargetFromUrl(): AssistantTarget | undefined {
  const query = new URLSearchParams(window.location.search);
  const id = query.get('recordId') || query.get('record') || query.get('ctxRecord');
  if (!assistantUuid(id)) return;
  const range = query.has('start') && query.has('end') ? validSelection({ start_s: Number(query.get('start')), end_s: Number(query.get('end')),
    ...(query.get('windowId') ? { window_id: query.get('windowId'), kind: query.get('kind') } : {}) }) : undefined;
  return { recordingId: id, ...(assistantHash(query.get('result')) ? { resultHash: query.get('result')! } : {}), ...(range ? { selection: range } : {}) };
}

export function analysisLink(target: AssistantTarget): string {
  const query = new URLSearchParams({ recordId: target.recordingId });
  if (target.resultHash) query.set('result', target.resultHash);
  if (target.selection) {
    query.set('start', String(target.selection.start_s)); query.set('end', String(target.selection.end_s));
    if (target.selection.window_id) { query.set('windowId', target.selection.window_id); query.set('kind', target.selection.kind!); }
  }
  return '/analysis?' + query + (target.selection ? '#waveforms' : '');
}

export function evidenceSelection(result: any, id: string): AssistantSelection | undefined {
  if (!id || id === 'SUM') return;
  const colon = id.indexOf(':');
  if (colon < 1) return;
  const prefix = id.slice(0, colon), rawId = id.slice(colon + 1);
  const windowId = prefix === 'SEG' && rawId.startsWith('MW-') ? rawId.slice(3) : rawId;
  const kinds = prefix === 'STAT' ? ['statistics'] : prefix === 'SEG' ? ['attention', 'model'] : ['model'];
  for (const kind of kinds) {
    const collection = result?.windows?.[kind];
    if (collection?.source_result_sha256 !== result?.result_sha256) continue;
    const row = collection.items?.find((item: any) => item.window_id === windowId || item.window_id === rawId);
    const selection = row && validSelection({ start_s: row.start_s, end_s: row.end_s, window_id: row.window_id, kind }, result?.display?.extent?.duration_s);
    if (selection) return selection;
  }
}

export function currentAssistantJob(job: any, recordingId: string, hash: string): boolean {
  return job?.recording_id === recordingId && (job.payload?._result_sha256 ?? job.payload?.result_sha256) === hash
    && (job.status !== 'completed' || job.result?.result_sha256 === hash);
}

export function confirmedAssistantContext(job: any): boolean {
  const requested = job?.payload?.assistant_context, receipt = job?.result?.assistant_context;
  if (requested?.version !== 1 || receipt?.version !== 1 || !assistantUuid(requested.conversation_id)
    || requested.conversation_id !== receipt.conversation_id || requested.previous_job_id !== receipt.previous_job_id) return false;
  if (!requested.selection && !receipt.selection) return true;
  const left = validSelection(requested.selection), right = validSelection(receipt.selection);
  return !!left && !!right && (['start_s', 'end_s', 'window_id', 'kind'] as const).every(key => left[key] === right[key]);
}

export function assistantServiceState(heartbeat: any, now = Date.now()) {
  const seen = Date.parse(heartbeat?.last_seen);
  const age = now - seen;
  const online = Number.isFinite(seen) && age >= -5000 && age < 90000;
  const supportsContext = heartbeat?.assistant_protocol === 1 && Number.isFinite(seen)
    && Date.parse(heartbeat?.assistant_seen_at) === seen;
  return { online, supportsContext, ready: online && supportsContext };
}
