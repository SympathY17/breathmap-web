import { describe, expect, it } from 'vitest';
import { buildCoverageNotice, buildIntervalInsight, type InsightSelection } from './recording-insights';

function hourResult() {
  return {
    execution: { status: 'partial', partial_reasons: ['flow_partial_coverage', 'voltage_partial_coverage'] },
    extent: { duration_s: 3600, analysis_start_s: 0, analysis_end_s: 3600 },
    summary: { frequency_bpm: 17.79, mean_expiratory_flow_l_min: 5.99, flow_valid_s: 3594.72, flow_coverage_fraction: 3594.72 / 3600 },
    quality: {
      bad_input_rows: 0, invalid_sample_s: 0, model_rejected_windows: 0,
      flow: { phase_seconds: { '-1': 1400, '0': 0, '1': 2194.72, '3': 0, '8': .28, '9': 5 } },
      voltage: { aligned_coverage_fraction: 359999 / 360000 },
    },
  };
}

describe('saved coverage explanations', () => {
  it('explains the one-hour saved example as information, preserving its actual metrics', () => {
    const source = hourResult(), snapshot = structuredClone(source);
    const notice = buildCoverageNotice(source, 'zh');
    const text = notice.details.join('\n');
    expect(notice.tone).toBe('info');
    expect(text).toContain('3,594.72 / 3,600 秒');
    expect(text).toContain('5.28 秒未计入');
    expect(text).toContain('99.85%');
    expect(text).toContain('预热或无效阶段共 5 秒');
    expect(text).toContain('0.28 秒呼气片段的计算样本不足');
    expect(text).toContain('约 0.01 秒未覆盖');
    expect(text).toContain('99.9997%');
    expect(text).toContain('零值不是缺失');
    expect(text).not.toContain('前 5 秒');
    expect(source).toEqual(snapshot);
    expect(source.summary.mean_expiratory_flow_l_min).toBe(5.99);
  });

  it('uses the saved duration rather than absolute end time for a nonzero analysis origin', () => {
    const source = hourResult();
    source.extent.analysis_start_s = 120;
    source.extent.analysis_end_s = 3720;
    const notice = buildCoverageNotice(source, 'en');
    expect(notice.tone).toBe('info');
    expect(notice.details.join(' ')).toContain('3,594.72 / 3,600 s');
    expect(notice.details.join(' ')).not.toContain('3,720');
  });

  it('keeps real bad rows, invalid samples and rejected model windows as warnings', () => {
    for (const key of ['bad_input_rows', 'invalid_sample_s', 'model_rejected_windows'] as const) {
      const source = hourResult(); source.quality[key] = 1;
      const notice = buildCoverageNotice(source, 'en');
      expect(notice.tone).toBe('warn');
      expect(notice.details.join(' ')).toMatch(/failed validation|were invalid|were rejected/);
    }
  });

  it('does not downplay substantial flow or voltage gaps', () => {
    const flow = hourResult();
    flow.summary.flow_valid_s = 3500; flow.summary.flow_coverage_fraction = 3500 / 3600;
    flow.quality.flow.phase_seconds = { '-1': 1400, '0': 0, '1': 2100, '3': 0, '8': 0, '9': 100 };
    expect(buildCoverageNotice(flow, 'en').tone).toBe('warn');
    const voltage = hourResult(); voltage.quality.voltage.aligned_coverage_fraction = .5;
    const notice = buildCoverageNotice(voltage, 'zh');
    expect(notice.tone).toBe('warn');
    expect(notice.details.join(' ')).toContain('约 1,800 秒未覆盖');
  });

  it('is conservative when old phase metadata or quality checks are missing', () => {
    const old: any = hourResult(); delete old.quality.flow.phase_seconds;
    const notice = buildCoverageNotice(old, 'zh');
    expect(notice.tone).toBe('warn');
    expect(notice.details.join(' ')).toContain('不足以完整解释');
    delete old.quality.bad_input_rows;
    expect(buildCoverageNotice(old, 'en').details.join(' ')).toContain('quality checks were not saved');
    expect(buildCoverageNotice(null, 'zh').tone).toBe('warn');
  });

  it('does not conceal unknown reasons or inconsistent metadata', () => {
    const unknown = hourResult(); unknown.execution.partial_reasons.push('new_unexplained_reason');
    expect(buildCoverageNotice(unknown, 'zh').tone).toBe('warn');
    const mismatch = hourResult(); mismatch.summary.flow_coverage_fraction = .5;
    expect(buildCoverageNotice(mismatch, 'zh').details.join(' ')).toContain('覆盖比例不一致');
    const phases = hourResult(); phases.quality.flow.phase_seconds['9'] = 4;
    expect(buildCoverageNotice(phases, 'zh').tone).toBe('warn');
  });

  it('retains an actually zero flow metric and a fully computable zero-valued phase', () => {
    const source = hourResult();
    source.execution = { status: 'success', partial_reasons: [] };
    source.summary = { ...source.summary, mean_expiratory_flow_l_min: 0, flow_valid_s: 3600, flow_coverage_fraction: 1 };
    source.quality.flow.phase_seconds = { '-1': 0, '0': 3600, '1': 0, '3': 0, '8': 0, '9': 0 };
    source.quality.voltage.aligned_coverage_fraction = 1;
    const notice = buildCoverageNotice(source, 'en');
    expect(notice.tone).toBe('info');
    expect(notice.details.join(' ')).toContain('3,600 / 3,600 s (100%)');
    expect(source.summary.mean_expiratory_flow_l_min).toBe(0);
  });

  it('does not coerce a missing or string-valued coverage field into zero or success', () => {
    const source: any = hourResult(); source.summary.flow_valid_s = '3594.72';
    source.quality.voltage.aligned_coverage_fraction = null;
    const notice = buildCoverageNotice(source, 'en');
    expect(notice.tone).toBe('warn');
    expect(notice.details.join(' ')).toContain('not replaced with zero');
    expect(notice.details.join(' ')).toContain('coverage is unavailable');
  });
});

const model = [
  { window_id: 'M1', start_s: 120, end_s: 130, valid: true, label: '正常呼吸', top_score: .93 },
  { window_id: 'M2', start_s: 125, end_s: 135, valid: true, label: '呼吸障碍（未吸气）', top_score: 0 },
  { window_id: 'M3', start_s: 130, end_s: 140, valid: false, label: '正常呼吸', top_score: .99 },
];
const statistics = [
  { window_id: 'S1', start_s: 120, end_s: 150, frequency_bpm: 0, mean_expiratory_flow_l_min: 0 },
  { window_id: 'S2', start_s: 150, end_s: 180, frequency_bpm: 18, mean_expiratory_flow_l_min: null },
];
function insight(selection: InsightSelection) { return buildIntervalInsight({ selection, model, statistics }, 'zh'); }

describe('saved interval explanations', () => {
  it('identifies an exact model window, including a real zero model score', () => {
    const result = insight({ start_s: 125, end_s: 135, window_id: 'M2', kind: 'model' });
    const text = result.details.join(' ');
    expect(result.title).toContain('125–135秒');
    expect(text).toContain('M2（125–135秒）');
    expect(text).toContain('模型标记为吸气中断模式，分数 0.000');
    expect(text).toContain('分数不是准确率或患病概率');
    expect(text).toContain('3 个已保存模型窗口');
    expect(text).toContain('重叠窗口不等于独立事件');
    expect(result.highlights).toHaveLength(2);
    expect(result.highlights[0]).toContain('M2（125–135秒）');
    expect(result.highlights[1]).toContain('统计窗口 S1（120–150秒）');
    expect(result.highlights.join(' ')).not.toContain('患病概率');
  });

  it('labels saved statistics with their original interval rather than selected-range metrics', () => {
    const text = insight({ start_s: 132, end_s: 134 }).details.join(' ');
    expect(text).toContain('统计窗口 S1（120–150秒）');
    expect(text).toContain('呼吸频率 0 次/分');
    expect(text).toContain('平均估计呼气流量 0 L/min');
    expect(text).toContain('未对选区重新计算');
    expect(text).toContain('未通过质量检查，分类不可用');
    expect(text).not.toContain('分数 0.990');
  });

  it('uses half-open interval overlap and excludes windows touching only a boundary', () => {
    const text = insight({ start_s: 150, end_s: 160 }).details.join(' ');
    expect(text).toContain('没有相交的模型窗口');
    expect(text).toContain('统计窗口 S2（150–180秒）');
    expect(text).not.toContain('120–150秒');
    expect(text).toContain('流量 不可用');
    expect(text).not.toContain('不可用 L/min');
  });

  it('handles mixed overlapping windows without merging their statistics or inventing event counts', () => {
    const result = insight({ start_s: 130, end_s: 160 });
    const text = result.details.join(' ');
    expect(text).toContain('2 个已保存模型窗口');
    expect(text).toContain('统计窗口 S1（120–150秒）');
    expect(text).toContain('统计窗口 S2（150–180秒）');
    expect(result.highlights).toHaveLength(3);
    expect(result.highlights[0]).toContain('M2');
    expect(result.highlights[1]).toContain('M3');
    expect(result.highlights[2]).toContain('统计窗口 S1');
    expect(text).not.toContain('2 个呼吸事件');
  });

  it('does not misidentify a stale window ID as an exact saved selection', () => {
    const text = insight({ start_s: 125, end_s: 135, window_id: 'M1', kind: 'model' }).details.join(' ');
    expect(text).toContain('标识与已保存边界不一致');
    expect(text).not.toContain('精确对应已保存窗口');
  });

  it('handles missing collections and invalid selections without making up results', () => {
    const result = buildIntervalInsight({ selection: { start_s: 5, end_s: 8 }, model: [], statistics: [] }, 'en');
    expect(result.details.join(' ')).toContain('No saved model window');
    expect(result.details.join(' ')).toContain('metrics are unavailable');
    expect(result.highlights).toEqual([]);
    expect(insight({ start_s: 10, end_s: 10 }).title).toBe('请选择有效区间');
    expect(insight({ start_s: -1, end_s: 10 }).title).toBe('请选择有效区间');
  });
});
