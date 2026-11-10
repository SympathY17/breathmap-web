import { describe, expect, it, vi } from 'vitest';
vi.mock('./supabase', () => ({ supabase: null }));
import { waveSegments, type Waveform } from './analysis';
import { clampRange, nearestSample, panRange, rangeContains, sampleValue, wheelRange, zoomRange } from './waveform-view';

const bounds = { start_s: 20, end_s: 3620 };
describe('waveform viewport', () => {
  it('preserves width while clamping both pan boundaries and nonzero origins', () => {
    expect(panRange({ start_s: 40, end_s: 50 }, -100, bounds)).toEqual({ start_s: 20, end_s: 30 });
    expect(panRange({ start_s: 40, end_s: 50 }, 9000, bounds)).toEqual({ start_s: 3610, end_s: 3620 });
  });
  it('zooms around the actual pointer anchor and bounds the smallest viewport', () => {
    expect(zoomRange({ start_s: 40, end_s: 50 }, .5, 42, bounds)).toEqual({ start_s: 41, end_s: 46 });
    expect(clampRange({ start_s: 21, end_s: 21.001 }, bounds)).toEqual({ start_s: 21, end_s: 21.1 });
    expect(zoomRange({ start_s: 40, end_s: 50 }, 10000, 45, bounds)).toEqual(bounds);
  });
  it('rejects a viewport extending beyond a loaded interval', () => {
    expect(rangeContains({ start_s: 40, end_s: 50 }, { start_s: 42, end_s: 48 })).toBe(true);
    expect(rangeContains({ start_s: 40, end_s: 50 }, { start_s: 45, end_s: 55 })).toBe(false);
  });
  it('does not round a viewport outside fractional record boundaries', () => {
    const fractional = { start_s: 2.0004, end_s: 2.1004 };
    const result = clampRange({ start_s: 0, end_s: 10 }, fractional);
    expect(result.start_s).toBeGreaterThanOrEqual(fractional.start_s);
    expect(result.end_s).toBeLessThanOrEqual(fractional.end_s);
  });
});

describe('wheel navigation commits', () => {
  const current = { start_s: 40, end_s: 50 };
  const base = { pixelWidth: 1000, pixelHeight: 180, anchor: 45 };
  it('pans with native deltaX even when deltaY is zero', () => {
    expect(wheelRange(current,bounds,{...base,deltaX:100,deltaY:0})).toEqual({range:{start_s:41.5,end_s:51.5},intent:'pan'});
    expect(wheelRange(current,bounds,{...base,deltaX:0,deltaY:100,shiftKey:true})).toEqual({range:{start_s:41.5,end_s:51.5},intent:'pan'});
  });
  it('zooms with vertical wheel deltas and normalizes line deltas', () => {
    const pixels = wheelRange(current,bounds,{...base,deltaX:0,deltaY:16});
    expect(pixels?.intent).toBe('zoom');
    expect(pixels!.range.end_s-pixels!.range.start_s).toBeGreaterThan(10);
    expect(wheelRange(current,bounds,{...base,deltaX:0,deltaY:1,deltaMode:1})).toEqual(pixels);
  });
  it('does not enqueue empty, nonfinite or clamped no-op gestures', () => {
    expect(wheelRange(current,bounds,{...base,deltaX:0,deltaY:0})).toBeNull();
    expect(wheelRange(current,bounds,{...base,deltaX:NaN,deltaY:20})).toBeNull();
    expect(wheelRange(bounds,bounds,{...base,deltaX:0,deltaY:100})).toBeNull();
    expect(wheelRange({start_s:3610,end_s:3620},bounds,{...base,deltaX:100,deltaY:0})).toBeNull();
  });
});

describe('source-point inspection', () => {
  const wave: Waveform = {
    columns: ['time_s', 'signal_mT', 'signal_valid', 'expiratory_flow_l_min', 'sig_input_uV', 'sig_valid'],
    points: [[40, 1, 1, 0, 2, 1], [40.01, 2, 1, null, 3, 0], [40.02, 3, 1, 4, 5, 1]],
    range: { start_s: 40, end_s: 40.03 }, break_before_columns: ['expiratory_flow_l_min'], break_before: [[false], [false], [true]],
  };
  it('returns an existing nearest source row, never a reconstructed sample', () => {
    expect(nearestSample(wave, 40.009)).toBe(wave.points[1]);
    expect(nearestSample(wave, 0, { start_s: 50, end_s: 60 })).toBeNull();
    expect(nearestSample(null, 40)).toBeNull();
  });
  it('keeps valid zero and independently respects missing/invalid channels', () => {
    expect(sampleValue(wave, wave.points[0], 'expiratory_flow_l_min')).toBe(0);
    expect(sampleValue(wave, wave.points[1], 'expiratory_flow_l_min')).toBeNull();
    expect(sampleValue(wave, wave.points[1], 'sig_input_uV')).toBeNull();
    expect(sampleValue(wave, wave.points[1], 'signal_mT')).toBe(2);
    expect(sampleValue(wave, wave.points[0], 'absent')).toBeNull();
  });
  it('retains channel discontinuities when plotting selected source points', () => {
    expect(waveSegments(wave, 'expiratory_flow_l_min')).toEqual([[[40, 0]], [[40.02, 4]]]);
    expect(waveSegments(wave, 'sig_input_uV')).toEqual([[[40, 2]], [[40.02, 5]]]);
  });
});
