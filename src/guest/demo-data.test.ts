import { describe, expect, it } from 'vitest';
import { guestDemo } from './demo-data';

describe('public synthetic demonstration data', () => {
  it('identifies the known synthetic source and saved explanation rather than a live request', () => {
    expect(guestDemo.provenance.synthetic).toBe(true);
    expect(guestDemo.provenance.label).toEqual({ en: 'Synthetic demo data', zh: '合成演示数据' });
    expect(guestDemo.provenance.inputSha256).toBe('88237b14ec805f516ef041dac422a8eac0158b7bca1212dd22778aef122f2db1');
    expect(guestDemo.provenance.resultSha256).toBe('9b7c5daa5e2185a3b6bed1b9cc3c9993a77da4fe3a5751680b682452a7e51273');
    expect(guestDemo.provenance.explanationSource).toBe('saved');
  });

  it('contains no private account identifiers, object locations or provider receipts', () => {
    const publicPayload = JSON.stringify(guestDemo);
    expect(publicPayload).not.toMatch(/[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}/i);
    expect(publicPayload).not.toMatch(/https?:\/\/|[A-Z]:\\|@|sb_secret_|sb_publishable_/i);
    expect(publicPayload).not.toMatch(/"(?:user_id|record_id|job_id|access_token|refresh_token|file_path|provider_model)"/);
  });

  it('keeps source limitations and absent signal samples visible', () => {
    expect(guestDemo.summary.executionStatus).toBe('partial');
    expect(guestDemo.summary.note.en).toContain('partial flow and voltage coverage');
    expect(guestDemo.points.some(point => point.flow === null)).toBe(true);
    expect(guestDemo.points.some(point => point.sig === null)).toBe(true);
    expect(guestDemo.report.some(item => item.text.en.includes('cannot confirm or exclude OSA'))).toBe(true);
    expect(guestDemo.report.some(item => item.text.en.includes('not event boundaries'))).toBe(true);
  });

  it('keeps actual sample times, channel breaks and cited intervals within the recording', () => {
    expect(guestDemo.points).toHaveLength(741);
    for (const [index, point] of guestDemo.points.entries()) {
      expect(point.t).toBeGreaterThanOrEqual(0);
      expect(point.t).toBeLessThan(guestDemo.durationSeconds);
      if (index > 0) expect(point.t).toBeGreaterThan(guestDemo.points[index - 1].t);
      for (const value of [point.magnetic, point.flow, point.sig]) {
        expect(value === null || Number.isFinite(value)).toBe(true);
      }
    }
    for (const indices of Object.values(guestDemo.breakBefore)) {
      for (const index of indices) {
        expect(Number.isInteger(index)).toBe(true);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(guestDemo.points.length);
      }
    }
    for (const interval of [...guestDemo.intervals, ...guestDemo.report, guestDemo.answer]) {
      expect(interval.start).toBeGreaterThanOrEqual(0);
      expect(interval.end).toBeLessThanOrEqual(guestDemo.durationSeconds);
      expect(interval.start).toBeLessThan(interval.end);
    }
  });
});
