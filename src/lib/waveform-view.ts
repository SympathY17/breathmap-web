import type { Waveform } from './analysis';

export type TimeRange = { start_s: number; end_s: number };
export const rangeWidth = (range: TimeRange) => range.end_s - range.start_s;
export function clampRange(range: TimeRange, bounds: TimeRange, minimum = .1): TimeRange {
  const available = bounds.end_s - bounds.start_s;
  if (!Number.isFinite(available) || available <= 0) return { ...bounds };
  if (!Number.isFinite(range.start_s) || !Number.isFinite(range.end_s)) return { ...bounds };
  const width = Math.min(available, Math.max(Math.min(minimum, available), rangeWidth(range)));
  const start = Math.min(bounds.end_s - width, Math.max(bounds.start_s, range.start_s));
  // Millisecond rounding keeps pointer noise out of saved requests, without
  // changing or rounding any source sample time or value.
  const roundedStart = Math.max(bounds.start_s, Math.min(bounds.end_s - width, Math.round(start * 1000) / 1000));
  return { start_s: roundedStart, end_s: Math.min(bounds.end_s, Math.max(roundedStart + Math.min(minimum, available), Math.round((roundedStart + width) * 1000) / 1000)) };
}
export function panRange(range: TimeRange, delta: number, bounds: TimeRange): TimeRange {
  return clampRange({ start_s: range.start_s + delta, end_s: range.end_s + delta }, bounds);
}
export function zoomRange(range: TimeRange, factor: number, anchor: number, bounds: TimeRange): TimeRange {
  if (!Number.isFinite(factor) || factor <= 0) return clampRange(range, bounds);
  const width = Math.max(.1, Math.min(rangeWidth(bounds), rangeWidth(range) * factor));
  const fraction = Math.max(0, Math.min(1, (anchor - range.start_s) / rangeWidth(range)));
  return clampRange({ start_s: anchor - width * fraction, end_s: anchor + width * (1 - fraction) }, bounds);
}
export function rangeContains(outer: TimeRange, inner: TimeRange): boolean {
  return outer.start_s <= inner.start_s + .000001 && outer.end_s >= inner.end_s - .000001;
}
export function sameRange(a: TimeRange, b: TimeRange): boolean {
  return Math.abs(a.start_s - b.start_s) < .00001 && Math.abs(a.end_s - b.end_s) < .00001;
}
export function wheelRange(range: TimeRange, bounds: TimeRange, input: { deltaX: number; deltaY: number; shiftKey?: boolean; deltaMode?: number; pixelWidth: number; pixelHeight: number; anchor: number }): { range: TimeRange; intent: 'pan' | 'zoom' } | null {
  if (!Number.isFinite(input.deltaX) || !Number.isFinite(input.deltaY)) return null;
  const horizontal = !!input.shiftKey || Math.abs(input.deltaX) > Math.abs(input.deltaY);
  const rawDelta = horizontal && input.deltaX ? input.deltaX : input.deltaY;
  const delta = rawDelta * (input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? input.pixelHeight : 1);
  if (!Number.isFinite(delta) || !delta) return null;
  const next = horizontal
    ? panRange(range, delta / Math.max(100, input.pixelWidth) * rangeWidth(range) * 1.5, bounds)
    : zoomRange(range, Math.exp(Math.max(-.6, Math.min(.6, delta * .002))), input.anchor, bounds);
  return sameRange(range, next) ? null : { range: next, intent: horizontal ? 'pan' : 'zoom' };
}
export function nearestSample(wave: Waveform | null, time: number, range?: TimeRange): (number | null)[] | null {
  if (!wave || !Number.isFinite(time)) return null;
  const column = wave.columns.indexOf('time_s');
  if (column < 0) return null;
  let left = 0, right = wave.points.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    const value = wave.points[middle]?.[column];
    if (typeof value === 'number' && Number.isFinite(value) && value < time) left = middle + 1;
    else right = middle;
  }
  return [wave.points[left - 1], wave.points[left]].filter(row => {
    const value = row?.[column];
    return typeof value === 'number' && Number.isFinite(value) && (!range || value >= range.start_s && value < range.end_s);
  }).sort((a, b) => Math.abs(a[column]! - time) - Math.abs(b[column]! - time))[0] ?? null;
}
export function sampleValue(wave: Waveform, row: (number | null)[], column: string): number | null {
  const index = wave.columns.indexOf(column);
  const flag = wave.columns.indexOf(column === 'sig_input_uV' ? 'sig_valid' : 'signal_valid');
  const value = row[index];
  return index >= 0 && typeof value === 'number' && Number.isFinite(value) && (flag < 0 || row[flag] === 1) ? value : null;
}
