import { describe, expect, it, vi } from 'vitest';

// Pure presentation helpers must not require a configured database or network.
vi.mock('./supabase', () => ({ supabase: null }));
import { formatNumber, resultIsCurrent, waveSegments, type Waveform } from './analysis';

function wave(points: (number | null)[][], breaks: boolean[][] = []): Waveform {
  return {
    columns: ['time_s', 'signal_mT', 'signal_valid', 'expiratory_flow_l_min', 'sig_input_uV', 'sig_valid'],
    // Deliberately differs from point-column order. Gaps are per channel.
    break_before_columns: ['sig_input_uV', 'expiratory_flow_l_min', 'signal_mT'],
    points,
    break_before: breaks,
    range: { start_s: 0, end_s: 30 },
  };
}

describe('recording metric presentation', () => {
  it('retains a real zero instead of treating it as unavailable', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-0)).toBe('-0');
    expect(formatNumber(12.345, 2)).toBe('12.35');
  });

  it.each([null, undefined, '', '0', NaN, Infinity, -Infinity])('does not coerce missing or nonnumeric %s into a metric', value => {
    expect(formatNumber(value)).toBe('—');
  });
});

describe('saved waveform rendering', () => {
  it('keeps zero-flow samples as real points', () => {
    expect(waveSegments(wave([[0, -2, 1, 0, 3, 1], [1, -1, 1, 0, 2, 1]]), 'expiratory_flow_l_min'))
      .toEqual([[[0, 0], [1, 0]]]);
  });

  it('breaks at a null sample and never fills it with zero or interpolation', () => {
    expect(waveSegments(wave([[0, 1, 1, 2, 10, 1], [1, null, 1, 2, 11, 1], [2, 3, 1, 2, 12, 1]]), 'signal_mT'))
      .toEqual([[[0, 1]], [[2, 3]]]);
  });

  it('keeps a SIG-only gap separate from magnetic and flow channels', () => {
    const input = wave(
      [[0, 1, 1, 2, 10, 1], [1, 2, 1, 3, 20, 1], [2, 3, 1, 4, 30, 1]],
      [[true, true, true], [true, false, false], [false, false, false]],
    );
    expect(waveSegments(input, 'sig_input_uV')).toEqual([[[0, 10]], [[1, 20], [2, 30]]]);
    expect(waveSegments(input, 'signal_mT')).toEqual([[[0, 1], [1, 2], [2, 3]]]);
    expect(waveSegments(input, 'expiratory_flow_l_min')).toEqual([[[0, 2], [1, 3], [2, 4]]]);
  });

  it('propagates a hidden gap reported between retained downsampled points', () => {
    const input = wave([[0, 1, 1, 2, 10, 1], [12, 2, 1, 3, 20, 1]], [[true, true, true], [false, true, false]]);
    expect(waveSegments(input, 'expiratory_flow_l_min')).toEqual([[[0, 2]], [[12, 3]]]);
    expect(waveSegments(input, 'signal_mT')).toEqual([[[0, 1], [12, 2]]]);
  });

  it('uses SIG validity independently of magnetic validity', () => {
    const input = wave([[0, 1, 1, 2, 10, 1], [1, 2, 0, 3, 20, 1], [2, 3, 1, 4, 30, 1]]);
    expect(waveSegments(input, 'signal_mT')).toEqual([[[0, 1]], [[2, 3]]]);
    expect(waveSegments(input, 'expiratory_flow_l_min')).toEqual([[[0, 2]], [[2, 4]]]);
    expect(waveSegments(input, 'sig_input_uV')).toEqual([[[0, 10], [1, 20], [2, 30]]]);
  });

  it('does not hide valid magnetic data when SIG alone is invalid', () => {
    const input = wave([[0, 1, 1, 2, 10, 1], [1, 2, 1, 3, 20, 0], [2, 3, 1, 4, 30, 1]]);
    expect(waveSegments(input, 'sig_input_uV')).toEqual([[[0, 10]], [[2, 30]]]);
    expect(waveSegments(input, 'signal_mT')).toEqual([[[0, 1], [1, 2], [2, 3]]]);
  });

  it('excludes null validity flags and nonfinite time/value rows without bridging them', () => {
    const input = wave([[0, 1, 1, 2, 10, 1], [1, 2, null, 3, 20, null], [2, 3, 1, 4, 30, 1], [NaN, 4, 1, 5, 40, 1], [3, Infinity, 1, 6, 50, 1], [4, 6, 1, 7, 60, 1]]);
    expect(waveSegments(input, 'signal_mT')).toEqual([[[0, 1]], [[2, 3]], [[4, 6]]]);
  });

  it('does not invent a missing channel or missing time axis', () => {
    const input = wave([[0, 1, 1, 2, 10, 1]]);
    expect(waveSegments(input, 'co2')).toEqual([]);
    expect(waveSegments({ ...input, columns: ['signal_mT'] }, 'signal_mT')).toEqual([]);
  });
});

describe('immutable result binding', () => {
  const current = 'a'.repeat(64), old = 'b'.repeat(64);

  it('accepts only the same complete result SHA-256', () => {
    expect(resultIsCurrent({ source_result_sha256: current }, current)).toBe(true);
    expect(resultIsCurrent({ source_result_sha256: old }, current)).toBe(false);
  });

  it('rejects absent bindings even when both objects have no hash', () => {
    expect(resultIsCurrent({}, undefined)).toBe(false);
    expect(resultIsCurrent(null, current)).toBe(false);
    expect(resultIsCurrent({ source_result_sha256: null }, null)).toBe(false);
  });

  it.each(['', 'same-label', 'a'.repeat(63), 'A'.repeat(64)])('rejects a matching malformed digest %s', hash => {
    expect(resultIsCurrent({ source_result_sha256: hash }, hash)).toBe(false);
  });
});
