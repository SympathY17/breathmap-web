/** Read-only explanations of saved results. These helpers never recalculate metrics. */
export type InsightLang = 'zh' | 'en';
export interface CoverageNotice { tone: 'info' | 'warn'; title: string; details: string[] }
export interface InsightSelection {
  start_s: number;
  end_s: number;
  window_id?: string;
  kind?: 'model' | 'statistics' | 'attention';
}
export interface IntervalInsight { title: string; details: string[]; highlights: string[] }
export interface IntervalInsightInput {
  selection: InsightSelection;
  model: readonly unknown[];
  statistics: readonly unknown[];
}

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const fraction = (value: unknown): value is number => nonnegative(value) && value <= 1;
const number = (value: number, digits = 2) => (Object.is(value, -0) ? 0 : value).toLocaleString('en-GB', { maximumFractionDigits: digits });
const seconds = (value: number) => number(value, 3);
const percent = (value: number, digits = 2) => number(value * 100, digits) + '%';
const close = (a: number, b: number) => Math.abs(a - b) <= .021;

export function buildCoverageNotice(input: unknown, lang: InsightLang): CoverageNotice {
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  const display = object(input), execution = object(display.execution), quality = object(display.quality);
  const summary = object(display.summary), extent = object(display.extent), flow = object(quality.flow), voltage = object(quality.voltage);
  const duration = extent.duration_s;
  const details: string[] = [];
  let warn = !['success', 'partial'].includes(execution.status);
  const reasons = Array.isArray(execution.partial_reasons) ? execution.partial_reasons : [];
  const coverageReasons = new Set(['flow_partial_coverage', 'voltage_partial_coverage']);
  if (reasons.some(reason => typeof reason !== 'string' || !coverageReasons.has(reason))) {
    warn = true;
    details.push(t('Other analysis limitations need review.', '另有分析限制，需进一步复核。'));
  }
  if (execution.status === 'partial' && reasons.length === 0) {
    warn = true;
    details.push(t('The reason for the analysis limitation was not saved.', '分析受限原因未保存。'));
  }
  const checks = [
    ['bad_input_rows', 'input rows failed validation', '条输入数据未通过检查'],
    ['invalid_sample_s', 'seconds of magnetic samples were invalid', '秒磁场样本无效'],
    ['model_rejected_windows', 'model windows were rejected', '个模型窗口被拒绝'],
  ];
  let missingQuality = false;
  for (const [key, en, zh] of checks) {
    const value = quality[key];
    if (!nonnegative(value)) { missingQuality = true; warn = true; }
    else if (value > 0) { warn = true; details.push(t(`${number(value, 3)} ${en}.`, `${number(value, 3)} ${zh}。`)); }
  }
  if (missingQuality) details.push(t('Some input-quality checks were not saved.', '部分输入质量检查信息未保存。'));
  if (!finite(duration) || duration <= 0) {
    return { tone: 'warn', title: t('Review the analysis information', '需复核分析信息'), details: [...details, t('The recording duration is unavailable; coverage cannot be checked.', '记录时长不可用，无法核对覆盖比例。')] };
  }

  const covered = summary.flow_valid_s;
  if (nonnegative(covered) && covered <= duration + .021) {
    const missing = Math.max(0, duration - covered), ratio = Math.min(1, covered / duration);
    details.push(t(
      `Flow calculations cover ${seconds(covered)} / ${seconds(duration)} s (${percent(ratio)}); ${seconds(missing)} s are excluded.`,
      `流量统计覆盖 ${seconds(covered)} / ${seconds(duration)} 秒（${percent(ratio)}），${seconds(missing)} 秒未计入。`,
    ));
    if (fraction(summary.flow_coverage_fraction) && Math.abs(summary.flow_coverage_fraction - ratio) > .00001) {
      warn = true; details.push(t('The saved flow duration and coverage fraction disagree.', '已保存流量覆盖时间与覆盖比例不一致。'));
    }
    if (missing > .000001) {
      const phase = object(flow.phase_seconds), codes = ['-1', '0', '1', '3', '8', '9'];
      const complete = codes.every(code => nonnegative(phase[code]));
      const consistent = complete && close(codes.reduce((sum, code) => sum + phase[code], 0), duration)
        && close(phase['-1'] + phase['0'] + phase['1'], covered);
      if (!consistent) {
        warn = true; details.push(t('The saved phase information does not fully explain the excluded time.', '相位信息不足以完整解释未计入的时间。'));
      } else {
        if (phase['9'] > 0) details.push(t(`Warmup or invalid phases total ${seconds(phase['9'])} s.`, `预热或无效阶段共 ${seconds(phase['9'])} 秒。`));
        if (phase['8'] > 0) details.push(t(`${seconds(phase['8'])} s of expiratory segments have insufficient samples for calculation.`, `${seconds(phase['8'])} 秒呼气片段的计算样本不足。`));
        if (phase['3'] > 0) { warn = true; details.push(t(`${seconds(phase['3'])} s have an undetermined flow direction.`, `${seconds(phase['3'])} 秒的流量方向未确定。`)); }
      }
      // Presentation severity only: this does not change analysis acceptance or means.
      if (missing / duration > .01) warn = true;
    } else if (reasons.includes('flow_partial_coverage')) {
      warn = true; details.push(t('The saved flow limitation does not match its complete coverage figure.', '已保存的流量受限原因与完整覆盖数值不一致。'));
    }
    details.push(t('Inspiration and baseline-equal phases contribute zero expiratory flow; zero is not missing data.', '吸气及基线相等阶段按零呼气流量计入，零值不是缺失。'));
  } else {
    warn = true; details.push(t('Computable flow time is missing or inconsistent; it is not replaced with zero.', '可计算流量时间缺失或不一致，未用零代替。'));
  }

  if (fraction(voltage.aligned_coverage_fraction)) {
    const ratio = voltage.aligned_coverage_fraction, missing = Math.max(0, duration * (1 - ratio));
    details.push(t(`SIG voltage coverage: ${percent(ratio, 4)}; approximately ${seconds(missing)} s are not covered.`, `SIG 电压覆盖 ${percent(ratio, 4)}，约 ${seconds(missing)} 秒未覆盖。`));
    // A few grid points merit an explanation; larger gaps remain a warning.
    if (missing > Math.min(.1, duration * .001) + .000001) warn = true;
    if (missing <= .000001 && reasons.includes('voltage_partial_coverage')) {
      warn = true; details.push(t('The saved voltage limitation does not match its complete coverage figure.', '已保存的电压受限原因与完整覆盖数值不一致。'));
    }
  } else {
    warn = true; details.push(t('SIG voltage coverage is unavailable.', 'SIG 电压覆盖信息不可用。'));
  }
  return { tone: warn ? 'warn' : 'info', title: warn ? t('Review the analysis limitations', '请复核分析限制') : t('Analysis complete: coverage details', '分析已完成：计算覆盖说明'), details };
}

const labels: Record<string, [string, string]> = {
  normal: ['Normal breathing pattern', '正常呼吸模式'], cont: ['Normal breathing pattern', '正常呼吸模式'], continuous: ['Normal breathing pattern', '正常呼吸模式'],
  '正常呼吸': ['Normal breathing pattern', '正常呼吸模式'],
  no_inhale: ['Inspiratory interruption pattern', '吸气中断模式'], '呼吸障碍（未吸气）': ['Inspiratory interruption pattern', '吸气中断模式'],
  no_exhale: ['Expiratory interruption pattern', '呼气中断模式'], '呼吸障碍（未呼气）': ['Expiratory interruption pattern', '呼气中断模式'],
  pause: ['No-breathing pattern', '无呼吸模式'], '呼吸暂停': ['No-breathing pattern', '无呼吸模式'],
  invalid: ['Unavailable', '不可用'], unknown: ['Uncertain', '不确定'], '无法判断': ['Uncertain', '不确定'],
};
function windowRows(value: readonly unknown[] | undefined) {
  return (Array.isArray(value) ? value : []).map(object).filter(row => nonnegative(row.start_s) && finite(row.end_s) && row.end_s > row.start_s);
}
const range = (row: Record<string, any>, lang: InsightLang = 'en') => `${seconds(row.start_s)}–${seconds(row.end_s)}${lang === 'zh' ? '秒' : ' s'}`;
const sameRange = (row: Record<string, any>, selection: InsightSelection) => Math.abs(row.start_s - selection.start_s) < 1e-7 && Math.abs(row.end_s - selection.end_s) < 1e-7;

export function buildIntervalInsight({ selection, model, statistics }: IntervalInsightInput, lang: InsightLang): IntervalInsight {
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  if (!selection || !nonnegative(selection.start_s) || !finite(selection.end_s) || selection.end_s <= selection.start_s) {
    return { title: t('Choose a valid interval', '请选择有效区间'), details: [t('Enter valid times, with the end after the start.', '请输入有效时间，且终点晚于起点。')], highlights: [] };
  }
  const overlaps = (row: Record<string, any>) => row.start_s < selection.end_s && row.end_s > selection.start_s;
  const models = windowRows(model).filter(overlaps), stats = windowRows(statistics).filter(overlaps);
  const details: string[] = [];
  const modelFacts: string[] = [], statisticFacts: string[] = [];
  const fact = (text: string, collection: string[]) => { details.push(text); collection.push(text); };
  const selectedCollection = selection.kind === 'statistics' ? stats : models;
  if (selection.window_id && !selectedCollection.some(row => row.window_id === selection.window_id && sameRange(row, selection))) {
    details.push(t('The selected window ID does not match its saved range.', '所选窗口标识与已保存边界不一致。'));
  }
  if (models.length) {
    details.push(t(`${models.length} saved model window(s) intersect the selection; overlapping windows are not independent events.`, `${models.length} 个已保存模型窗口与选区相交，重叠窗口不等于独立事件。`));
    const exact = models.find(row => sameRange(row, selection) && (!selection.window_id || selection.kind === 'statistics' || row.window_id === selection.window_id));
    const shown = exact ? [exact] : models.slice(0, 3);
    for (const row of shown) {
      const id = typeof row.window_id === 'string' ? row.window_id : t('Model window', '模型窗口');
      const label = labels[String(row.label ?? '').toLowerCase().replace(/[ .-]/g, '_')];
      const labelText = label ? t(...label) : t('Unrecognized classification label', '未识别的分类标签');
      if (row.valid === false) fact(t(`${id} (${range(row)}): failed quality checks; classification unavailable.`, `${id}（${range(row, lang)}）：未通过质量检查，分类不可用。`), modelFacts);
      else {
        const score = fraction(row.top_score) ? row.top_score.toFixed(3) : t('unavailable', '不可用');
        fact(t(`${id} (${range(row)}): the model labels this ${labelText.toLowerCase()}; score ${score}.${row.valid === true ? '' : ' Window validity was not saved.'}`, `${id}（${range(row, lang)}）：模型标记为${labelText}，分数 ${score}。${row.valid === true ? '' : '窗口有效性未保存。'}`), modelFacts);
      }
    }
    if (!exact && models.length > shown.length) details.push(t(`Showing ${shown.length} of ${models.length} model windows.`, `仅列出 ${models.length} 个模型窗口中的 ${shown.length} 个。`));
    details.push(t('Scores are not accuracy or disease probability; window boundaries are not exact event boundaries.', '分数不是准确率或患病概率，窗口边界也不是事件的精确边界。'));
  } else details.push(t('No saved model window intersects this interval.', '此区间没有相交的模型窗口。'));
  if (stats.length) {
    const chosen = selection.kind === 'statistics' && selection.window_id ? stats.find(row => row.window_id === selection.window_id && sameRange(row, selection)) : undefined;
    const shown = chosen ? [chosen] : stats.slice(0, 3);
    for (const row of shown) {
      const rate = finite(row.frequency_bpm) ? number(row.frequency_bpm) : t('unavailable', '不可用');
      const flow = finite(row.mean_expiratory_flow_l_min) ? number(row.mean_expiratory_flow_l_min) : t('unavailable', '不可用');
      const id = typeof row.window_id === 'string' ? row.window_id : t('Statistics', '统计窗口');
      fact(t(`Statistics window ${id} (${range(row)}): breathing rate ${rate}${finite(row.frequency_bpm) ? ' breaths/min' : ''}; mean estimated expiratory flow ${flow}${finite(row.mean_expiratory_flow_l_min) ? ' L/min' : ''}.`, `统计窗口 ${id}（${range(row, lang)}）：呼吸频率 ${rate}${finite(row.frequency_bpm) ? ' 次/分' : ''}，平均估计呼气流量 ${flow}${finite(row.mean_expiratory_flow_l_min) ? ' L/min' : ''}。`), statisticFacts);
    }
    if (!chosen && stats.length > shown.length) details.push(t(`Showing ${shown.length} of ${stats.length} statistics windows.`, `仅列出 ${stats.length} 个统计窗口中的 ${shown.length} 个。`));
    details.push(t('Statistics describe their original intervals; they are not combined or recalculated for the selection.', '统计值属于各自原始区间，未合并，也未对选区重新计算。'));
  } else details.push(t('No saved statistics for this interval; metrics are unavailable.', '此区间没有相交的已保存统计窗口，指标不可用。'));
  return { title: t(`Saved results for ${range(selection)}`, `${range(selection, lang)} 的已保存结果`), details, highlights: [...modelFacts.slice(0, 2), ...statisticFacts.slice(0, 1)] };
}
