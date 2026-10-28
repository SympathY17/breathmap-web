import { supabase } from './supabase';
export type Waveform = { columns: string[]; points: (number | null)[][]; break_before_columns: string[]; break_before: boolean[][]; range: { start_s: number; end_s: number }; sampling?: { downsampled: boolean; returned_points: number; source_rows_in_range: number } };
export const formatNumber = (value: unknown, digits = 2) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-GB', { maximumFractionDigits: digits }) : '—';
export function waveSegments(wave: Waveform, column: string): Array<Array<[number, number]>> {
  const index = wave.columns.indexOf(column), time = wave.columns.indexOf('time_s'), gap = wave.break_before_columns.indexOf(column);
  if (index < 0 || time < 0) return [];
  const flag = wave.columns.indexOf(column === 'sig_input_uV' ? 'sig_valid' : 'signal_valid');
  const segments: Array<Array<[number, number]>> = []; let current: Array<[number, number]> = [];
  wave.points.forEach((row, n) => {
    const x = row[time], y = row[index];
    if (gap >= 0 && wave.break_before?.[n]?.[gap] && current.length) { segments.push(current); current = []; }
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y) || flag >= 0 && row[flag] !== 1) { if (current.length) segments.push(current); current = []; return; }
    current.push([x, y]);
  });
  if (current.length) segments.push(current);
  return segments;
}
const pendingRequestKeys = new Map<string, string>();
export async function requestJob(recordingId: string, operation: 'analyse' | 'report' | 'chat' | 'waveform', payload: Record<string, unknown>) {
  if (!supabase) throw new Error('Database connection is not configured.');
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) throw new Error('Sign in before requesting analysis.');
  const encoded = new TextEncoder().encode(JSON.stringify([sessionData.session.user.id, recordingId, operation, payload]));
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)), byte => byte.toString(16).padStart(2, '0')).join('');
  const storageKey = `breathmap:pending-request:${fingerprint}`;
  let key = pendingRequestKeys.get(storageKey);
  try { key ??= sessionStorage.getItem(storageKey) ?? undefined; } catch { /* In-memory retry protection remains active. */ }
  key ??= crypto.randomUUID(); pendingRequestKeys.set(storageKey, key);
  try { sessionStorage.setItem(storageKey, key); } catch { /* Do not prevent a request when browser storage is disabled. */ }
  // Retain the same key after an uncertain network result; a retry cannot create
  // a second paid operation merely because the acknowledgement was lost.
  const { data, error } = await supabase.rpc('request_analysis_job', { p_recording_id: recordingId, p_operation: operation, p_payload: payload, p_request_key: key });
  if (error) throw error;
  pendingRequestKeys.delete(storageKey);
  try { sessionStorage.removeItem(storageKey); } catch { /* No question or result is stored here. */ }
  return Array.isArray(data) ? data[0] : data;
}
export function resultIsCurrent(candidate: any, hash: string | null | undefined) {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) && candidate?.source_result_sha256 === hash;
}
