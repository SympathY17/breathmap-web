import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react';
import { supabase } from './lib/supabase';
import { formatNumber as num, requestJob, resultIsCurrent, waveSegments, type Waveform } from './lib/analysis';
import { useAuth } from './lib/user';
import { PrivateFileLink } from './components/private-file-link';

const LABELS: Record<string, [string, string]> = { normal: ['Normal breathing', '正常呼吸'], cont: ['Normal breathing', '正常呼吸'], continuous: ['Normal breathing', '正常呼吸'], no_inhale: ['Inspiratory interruption', '吸气中断'], no_exhale: ['Expiratory interruption', '呼气中断'], pause: ['No breathing', '无呼吸'], invalid: ['Unavailable', '不可用'], unknown: ['Uncertain', '不确定'], '正常呼吸': ['Normal breathing', '正常呼吸'], '呼吸暂停': ['No breathing', '无呼吸'], '呼吸障碍（未吸气）': ['Inspiratory interruption', '吸气中断'], '呼吸障碍（未呼气）': ['Expiratory interruption', '呼气中断'], '无法判断': ['Uncertain', '不确定'] };
function localRecordingTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
}
function WavePlot({ wave, column, title, unit }: { wave: Waveform; column: string; title: string; unit: string }) {
  const segments = waveSegments(wave, column), all = segments.flat();
  if (!all.length) return <div><strong>{title}</strong><p className="result-note">—</p></div>;
  const values = all.map(p => p[1]), min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const a = wave.range.start_s, b = wave.range.end_s;
  const xy = ([x, y]: [number, number]) => `${40 + (x - a) / (b - a) * 1010},${135 - (y - min) / span * 110}`;
  return <div><strong>{title} <small>({unit})</small></strong><svg className="wave-plot" viewBox="0 0 1100 170" role="img" aria-label={`${title}, ${num(a)}–${num(b)} s`}>
    <path d="M40 18V140H1060" fill="none" stroke="#b8d4ca" />
    {segments.map((segment, i) => segment.length === 1 ? <circle key={i} cx={Number(xy(segment[0]).split(',')[0])} cy={Number(xy(segment[0]).split(',')[1])} r={1.5} fill="#26796d" /> : <polyline key={i} points={segment.map(xy).join(' ')} fill="none" stroke={column === 'sig_input_uV' ? '#6595ae' : column === 'expiratory_flow_l_min' ? '#6c9784' : '#276c68'} strokeWidth="1.5" />)}
    <text x="4" y="28" fontSize="10" fill="#5e7b70">{num(max)}</text><text x="4" y="137" fontSize="10" fill="#5e7b70">{num(min)}</text><text x="40" y="158" fontSize="11" fill="#5e7b70">{num(a)} s</text><text x="1020" y="158" fontSize="11" fill="#5e7b70">{num(b)} s</text>
  </svg></div>;
}
function Claims({ answer, onEvidence }: { answer: any; onEvidence: (id: string, evidence?: any) => void }) {
  const claims = answer?.claims;
  if (!Array.isArray(claims)) return <p>{typeof answer === 'string' ? answer : '—'}</p>;
  return <>{claims.map((claim: any, index: number) => <div className="message-item" key={index}><p>{claim.text}</p>
    {Array.isArray(claim.values) && claim.values.length > 0 && <p className="result-note">{claim.values.map((value: any) => `${value.field}: ${typeof value.value === 'object' ? JSON.stringify(value.value) : String(value.value)}`).join(' · ')}</p>}
    <div className="result-actions">{(claim.evidence_ids ?? []).map((id: string) => <button key={id} onClick={() => onEvidence(id, answer.evidence)}>{id}</button>)}</div>
  </div>)}</>;
}
export default function AnalysisPanel({ recordingId, detailed }: { recordingId: string; detailed: boolean }) {
  const { user } = useAuth();
  const [lang, setLang] = useState(() => localStorage.getItem('breathmap-language') === 'en' ? 'en' : 'zh');
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  const reasonText = (code: string) => ({
    flow_partial_coverage: t('Flow estimates are unavailable at some time points.', '部分时间点没有可用的流量估计。'),
    voltage_partial_coverage: t('The SIG voltage signal is unavailable at some aligned time points.', '部分对齐时间点没有可用的 SIG 电压信号。'),
    frequency_unavailable: t('Breathing rate could not be calculated for this recording.', '本次记录无法计算呼吸频率。'),
    flow_unavailable: t('Expiratory flow could not be calculated for this recording.', '本次记录无法计算呼气流量。'),
  } as Record<string, string>)[code] ?? t('Some outputs need further review.', '部分结果需要进一步复核。');
  const [record, setRecord] = useState<any>(null), [result, setResult] = useState<any>(null), [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [heartbeat, setHeartbeat] = useState<string | null>(null), [consent, setConsent] = useState(false), [question, setQuestion] = useState('');
  const [wave, setWave] = useState<Waveform | null>(null), [start, setStart] = useState('0'), [end, setEnd] = useState('30');
  const [kind, setKind] = useState<'model' | 'statistics' | 'attention'>('model'), [page, setPage] = useState(0), [selected, setSelected] = useState('');
  const [note, setNote] = useState(''), [saved, setSaved] = useState('');
  const [editingDetails, setEditingDetails] = useState(false), [savingDetails, setSavingDetails] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState({ title: '', recordedAt: '', details: '' });
  const [detailsError, setDetailsError] = useState(''), [detailsSaved, setDetailsSaved] = useState('');
  const detailsLock = useRef(false), detailsWriteVersion = useRef(0);
  const detailsDateOrigin = useRef({ stored: '', input: '' });
  const [evidenceView, setEvidenceView] = useState<{ id: string; values: any } | null>(null);
  const overviewHash = useRef(''), appliedWaveJob = useRef('');
  const alive = useRef(true), previousResult = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    if (!supabase || !user) return;
    const metadataVersion = detailsWriteVersion.current;
    const [r, a, j, h] = await Promise.all([
      supabase.from('recordings').select('id,user_id,title,notes,details,file_path,file_name,file_size,recorded_at,uploaded_at,trashed_at').eq('id', recordingId).is('trashed_at', null).maybeSingle(),
      supabase.from('analysis_results').select('*').eq('recording_id', recordingId).maybeSingle(),
      supabase.from('analysis_jobs').select('id,recording_id,operation,payload,status,result,error_code,created_at,finished_at').eq('recording_id', recordingId).order('created_at', { ascending: false }).limit(40),
      supabase.from('worker_heartbeat').select('last_seen').order('last_seen', { ascending: false }).limit(1),
    ]);
    if (!alive.current) return;
    const issue = r.error ?? a.error ?? j.error;
    if (issue) { setError(t('Your record could not be refreshed. Please try again.', '暂时无法刷新记录，请重试。')); setLoading(false); return; }
    if (metadataVersion === detailsWriteVersion.current) setRecord(r.data);
    setResult(a.data); setJobs(j.data ?? []); setHeartbeat(h.data?.[0]?.last_seen ?? null); setLoading(false);
    if (previousResult.current && a.data?.result_sha256 !== previousResult.current) { setConsent(false); setWave(null); setEvidenceView(null); setPage(0); setSelected(''); overviewHash.current = ''; appliedWaveJob.current = ''; }
    previousResult.current = a.data?.result_sha256 ?? null;
  }, [recordingId, user?.id, lang]);
  useEffect(() => { alive.current = true; void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => { alive.current = false; clearInterval(timer); }; }, [refresh]);
  useEffect(() => { setConsent(false); setWave(null); setEvidenceView(null); setPage(0); setSelected(''); overviewHash.current = ''; appliedWaveJob.current = ''; }, [recordingId]);
  useEffect(() => { if (record) setNote(record.notes ?? ''); }, [record?.id, record?.notes]);
  useEffect(() => { localStorage.setItem('breathmap-language', lang); }, [lang]);
  const hash = result?.result_sha256;
  const display = resultIsCurrent(result?.display, hash) ? result.display : null;
  useEffect(() => {
    const overview = result?.wave_manifest?.overview;
    if (!supabase || !hash || !resultIsCurrent(result?.wave_manifest, hash) || overviewHash.current === hash || !overview?.path || !user || !overview.path.startsWith(`${user.id}/${recordingId}/${hash}/`) || overview.bucket !== 'analysis-artifacts') return;
    overviewHash.current = hash; let cancelled = false;
    supabase.storage.from('analysis-artifacts').download(overview.path).then(async ({ data, error: issue }) => {
      if (issue || !data || data.size > 5 * 1024 * 1024 || cancelled) return;
      try { const next = JSON.parse(await data.text()); if (!cancelled && !appliedWaveJob.current && next?.columns && next?.points) { setWave(next); setStart(String(next.range.start_s)); setEnd(String(next.range.end_s)); } } catch { /* Keep metrics available when the cached waveform cannot be read. */ }
    });
    return () => { cancelled = true; };
  }, [hash, recordingId, user?.id, result?.wave_manifest?.overview?.path]);
  useEffect(() => {
    const job = jobs.find(j => j.operation === 'waveform' && j.status === 'completed' && j.result?.waveform && j.result.result_sha256 === hash && (j.payload?._result_sha256 ?? j.payload?.result_sha256) === hash);
    if (job && appliedWaveJob.current !== job.id) { appliedWaveJob.current = job.id; setWave(job.result.waveform); }
  }, [jobs, hash]);
  async function submit(operation: 'analyse' | 'report' | 'chat' | 'waveform', payload: Record<string, unknown> = {}) {
    if (busy) return; setBusy(true); setError(''); setSaved('');
    try { await requestJob(recordingId, operation, { ...payload, language: lang, ...(hash ? { result_sha256: hash } : {}), ...(['report', 'chat'].includes(operation) ? { ai_consent: consent } : {}) }); if (operation === 'chat') setQuestion(''); await refresh(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : t('The request could not be saved.', '请求未能保存。')); }
    finally { setBusy(false); }
  }
  const pending = jobs.filter(j => ['queued', 'running'].includes(j.status));
  const online = !!heartbeat && Date.now() - new Date(heartbeat).getTime() < 90000;
  const execution = display?.execution?.status;
  const summary = display?.summary;
  const usable = ['success', 'partial'].includes(execution);
  const report = display?.report;
  const rows = resultIsCurrent(result?.windows?.[kind], hash) ? result.windows[kind].items ?? [] : [];
  const selectedRows = rows.slice(page * 20, page * 20 + 20);
  const label = (value: string) => { const pair = LABELS[value?.toLowerCase().replace(/[ -]/g, '_')]; return pair ? t(...pair) : value ?? '—'; };
  async function saveNotes() {
    if (!supabase || !user || busy) return;
    setBusy(true); setError(''); setSaved('');
    try {
      const response = await supabase.from('recordings').update({ notes: note.trim() }).eq('id', recordingId).eq('user_id', user.id).is('trashed_at', null).select('id').single();
      if (response.error || !response.data) throw new Error('not_saved');
      setSaved(t('Notes saved.', '备注已保存。'));
    } catch { setError(t('Your notes could not be saved. Check that the recording is still available and try again.', '备注未能保存，请确认记录仍然存在后重试。')); }
    finally { setBusy(false); }
  }
  function beginDetailsEdit() {
    if (!record || detailsLock.current) return;
    const input = localRecordingTime(record.recorded_at);
    detailsDateOrigin.current = { stored: record.recorded_at, input };
    setDetailsDraft({ title: record.title ?? '', recordedAt: input, details: record.details ?? '' });
    setDetailsError(''); setDetailsSaved(''); setEditingDetails(true);
  }
  async function saveDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !user || detailsLock.current) return;
    setDetailsError(''); setDetailsSaved('');
    const title = detailsDraft.title.trim(), details = detailsDraft.details.trim();
    if (!title || title.length > 200) { setDetailsError(t('Enter a recording title of 1–200 characters.', '请填写 1–200 字的记录名称。')); return; }
    if (details.length > 10000) { setDetailsError(t('Keep collection details within 10,000 characters.', '采集情况请控制在 10,000 字以内。')); return; }
    const date = detailsDraft.recordedAt === detailsDateOrigin.current.input ? new Date(detailsDateOrigin.current.stored) : new Date(detailsDraft.recordedAt);
    if (!detailsDraft.recordedAt || !Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 60000) { setDetailsError(t('Choose a valid recording date and time that is not in the future.', '请选择有效的采集日期和时间，不能晚于当前时间。')); return; }
    const values = { title, recorded_at: date.toISOString(), details };
    detailsLock.current = true; setSavingDetails(true); detailsWriteVersion.current++;
    try {
      const response = await supabase.from('recordings').update(values).eq('id', recordingId).eq('user_id', user.id).is('trashed_at', null).select('id,title,recorded_at,details').single();
      if (response.error || !response.data || response.data.id !== recordingId) throw new Error('not_saved');
      detailsWriteVersion.current++;
      if (!alive.current) return;
      setRecord((current: any) => current?.id === recordingId ? { ...current, ...response.data } : current);
      setEditingDetails(false); setDetailsSaved(t('Recording details saved.', '记录信息已保存。'));
      try { await refresh(); }
      catch { if (alive.current) setDetailsSaved(t('Recording details saved. Refresh to reload the latest copy.', '记录信息已保存，请刷新页面读取最新内容。')); }
    } catch {
      if (alive.current) setDetailsError(t('Your changes could not be saved. Check that the recording is still available, then try again.', '修改未能保存，请确认记录仍然存在后重试。'));
    } finally { detailsLock.current = false; if (alive.current) setSavingDetails(false); }
  }
  function focusRow(row: any) { setSelected(row.window_id); setStart(String(row.start_s)); setEnd(String(row.end_s)); document.getElementById('waveforms')?.scrollIntoView({ behavior: 'smooth' }); }
  function focusEvidence(id: string, evidence?: any) {
    if (id === 'SUM') { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const [prefix, rawWindowId] = id.split(':'); const windowId = prefix === 'SEG' && rawWindowId?.startsWith('MW-') ? rawWindowId.slice(3) : rawWindowId; const nextKind = prefix === 'STAT' ? 'statistics' : 'model';
    const collection = result?.windows?.[nextKind]?.items ?? []; const index = collection.findIndex((r: any) => r.window_id === windowId);
    if (index >= 0) { setKind(nextKind); setPage(Math.floor(index / 20)); focusRow(collection[index]); return; }
    const item = Array.isArray(evidence) ? evidence.find((value: any) => value.id === id) : evidence?.[id];
    if (item?.values) { setEvidenceView({ id, values: item.values }); if (typeof item.values.start_s === 'number' && typeof item.values.end_s === 'number') { setStart(String(item.values.start_s)); setEnd(String(item.values.end_s)); document.getElementById('waveforms')?.scrollIntoView({ behavior: 'smooth' }); } }
  }
  if (loading) return <main className="app-loading" role="status">{t('Loading your record…', '正在读取记录…')}</main>;
  if (!record) return <main className="auth-shell"><section className="auth-card"><h1>{t('Record not found', '未找到记录')}</h1><p>{error || t('This record is unavailable in your account.', '当前账号无法访问这条记录。')}</p><a href="/recordings">{t('Saved recordings', '历史记录')}</a></section></main>;
  return <main className="result-shell">
    <header className="result-top"><a className="auth-brand" href="/"><Activity />BreathMap</a><nav className="result-links"><a href="/recordings"><ArrowLeft size={15} /> {t('Saved recordings', '历史记录')}</a><a href={`/wellbeing?view=diary&ctxRecord=${recordingId}`}>{t('Linked diary', '关联日记')}</a><a href="/account">{t('Account', '账号')}</a><button className="text-button" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>{lang === 'zh' ? 'English' : '中文'}</button></nav></header>
    <p className="eyebrow">{detailed ? t('DETAILED ANALYSIS', '详细分析') : t('RECORDING REPORT', '记录报告')}</p><h1>{record.title}</h1>
    <p className="result-subtitle">{new Date(record.recorded_at ?? record.uploaded_at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB')} · {t('Duration', '时长')} {num(display?.extent?.duration_s)} s</p>
    {error && <p role="alert" className="result-status error">{error}</p>}
    {pending.length > 0 && <div className="result-status" role="status">{pending.some(j => j.status === 'running') ? t('Your request is being processed.', '正在处理你的请求。') : online ? t('Your request is queued for the analysis host.', '请求已排队，等待分析主机处理。') : t('Your request has been saved. It will continue when the analysis host is available.', '请求已保存，将在分析主机可用后继续。')} {t('Saved results remain available.', '已有结果仍可查看。')}</div>}
    {execution === 'partial' && <div className="result-status warn">{t('Analysis is available with some metrics limited. Missing values remain unavailable; this does not mean zero.', '分析结果可用，部分指标受限。缺失值保留为不可用，不等于零。')}<p className="result-note">{[...new Set((display.execution.partial_reasons ?? []).map(reasonText))].join(' ')}</p></div>}
    {['error', 'unable_to_analyze'].includes(execution) && <div className="result-status error">{t('This recording could not be fully analysed. You can retry analysis using the original file.', '这条记录无法完成分析，可以使用原文件重试分析。')}</div>}
    <section className="result-grid" aria-label={t('Recording metrics', '记录指标')}>
      <div className="result-metric"><span>{t('Mean breathing rate', '平均呼吸频率')}</span><strong>{num(summary?.frequency_bpm)}</strong><small>{t('breaths/min', '次/分')}</small></div>
      <div className="result-metric"><span>{t('Mean estimated expiratory flow', '平均估计呼气流量')}</span><strong>{num(summary?.mean_expiratory_flow_l_min)}</strong><small>L/min</small></div>
      <div className="result-metric"><span>{t('Valid model windows', '有效模型窗口')}</span><strong>{num(display?.window_counts?.valid_model, 0)} / {num(display?.window_counts?.model, 0)}</strong><small>{t('Overlapping windows; not independent events', '窗口可能重叠，不等同于独立事件')}</small></div>
    </section>
    {!result && <section className="result-card"><h2>{t('Ready to analyse', '准备分析')}</h2><p>{t('Your original recording is saved. Start analysis to calculate metrics and classify breathing windows using the existing model.', '原始记录已保存。开始分析后，将计算指标并使用已有模型对呼吸窗口分类。')}</p><button className="solid-button" disabled={busy || pending.some(j => j.operation === 'analyse')} onClick={() => void submit('analyse')}>{t('Start analysis', '开始分析')}</button></section>}
    {jobs.filter(j => ['failed', 'interrupted'].includes(j.status)).slice(0, 1).map(job => <div className="result-status warn" key={job.id}>{t('A previous request needs attention.', '此前有一项请求需要处理。')} {job.error_code}<p className="result-note">{job.status === 'interrupted' ? t('The operator must review the interrupted task before it is run again.', '中断的任务需要操作员复核后再继续。') : t('You can retry the relevant action below. Saved numerical results are retained.', '可在下方重试对应操作，已有数值结果会保留。')}</p></div>)}
    {result && !usable && <div className="result-actions"><button className="solid-button" disabled={busy || pending.some(j => j.operation === 'analyse')} onClick={() => void submit('analyse')}>{t('Retry analysis', '重试分析')}</button></div>}
    {usable && <>
      {!detailed && <div className="result-actions"><a className="solid-button" href={`/analysis?recordId=${recordingId}`}>{t('Explore full waveforms and windows', '查看完整波形与窗口')} <ArrowRight size={15} /></a></div>}
      <section className="result-card" id="waveforms"><h2>{t('Synchronized waveforms', '同步波形')}</h2><p className="result-note">{t('Select an interval to inspect the saved signals. Changing the view does not recalculate your metrics.', '选择区间查看已保存信号。切换视图不会重新计算指标。')}</p>
        <form className="wave-controls" onSubmit={event => { event.preventDefault(); const a = Number(start), b = Number(end); if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a || b > (display?.extent?.analysis_end_s ?? display?.extent?.duration_s ?? 43200)) { setError(t('Choose a valid interval within this recording.', '请选择记录范围内的有效区间。')); return; } void submit('waveform', { start: a, end: b, max_points: 5000 }); }}>
          <label>{t('Start (seconds)', '起点（秒）')}<input required type="number" min="0" step="0.01" value={start} onChange={e => setStart(e.target.value)} /></label><label>{t('End (seconds)', '终点（秒）')}<input required type="number" min="0" step="0.01" value={end} onChange={e => setEnd(e.target.value)} /></label><button className="solid-button" disabled={busy || pending.some(j => j.operation === 'waveform')}>{t('Load interval', '载入区间')}</button>
        </form>
        {wave ? <div style={{ marginTop: 24 }}><WavePlot wave={wave} column="signal_mT" title={t('Magnetic signal', '磁场信号')} unit="mT" /><WavePlot wave={wave} column="expiratory_flow_l_min" title={t('Estimated expiratory flow', '估计呼气流量')} unit="L/min" /><WavePlot wave={wave} column="sig_input_uV" title={t('SIG differential voltage', 'SIG 差分电压')} unit="μV" /><p className="wave-caption">{t('Actual sampled source rows; gaps and invalid points are not joined or interpolated.', '显示实际抽取的源数据点；缺口和无效点不连线、不插值。')} {wave.sampling && `${num(wave.sampling.returned_points, 0)} / ${num(wave.sampling.source_rows_in_range, 0)} ${t('source rows', '源数据行')}`}</p></div> : <p className="result-note">{t('The saved waveform is loading, or select an interval to request it from the analysis host.', '正在读取已保存波形，也可选择区间向分析主机请求。')}</p>}
      </section>
      {detailed && <section className="result-card"><h2>{t('Analysis windows', '分析窗口')}</h2><div className="result-tabs" role="tablist">{(['model', 'statistics', 'attention'] as const).map(key => <button role="tab" aria-selected={kind === key} className="result-tab" key={key} onClick={() => { setKind(key); setPage(0); }}>{key === 'model' ? t('Model', '模型') : key === 'statistics' ? t('Statistics', '统计') : t('Attention', '关注')}</button>)}</div>
        <div className="result-table-wrap"><table className="result-table"><thead><tr><th>ID</th><th>{t('Interval (s)', '区间（秒）')}</th>{kind === 'statistics' ? <><th>{t('Rate (breaths/min)', '频率（次/分）')}</th><th>{t('Flow (L/min)', '流量（L/min）')}</th></> : <><th>{t('Pattern', '模式')}</th><th>{t('Model score', '模型分数')}</th></>}<th>{t('Waveform', '波形')}</th></tr></thead><tbody>{selectedRows.map((row: any) => <tr key={row.window_id} aria-selected={selected === row.window_id}><td>{row.window_id}</td><td>{num(row.start_s)}–{num(row.end_s)}</td>{kind === 'statistics' ? <><td>{num(row.frequency_bpm)}</td><td>{num(row.mean_expiratory_flow_l_min)}</td></> : <><td>{label(row.label)}</td><td>{num(row.top_score, 3)}</td></>}<td><button onClick={() => focusRow(row)}>{t('Select interval', '选择区间')}</button></td></tr>)}</tbody></table></div>
        {rows.length === 0 && <p>{t('No saved windows in this collection.', '此分类暂无已保存窗口。')}</p>}
        <div className="result-actions"><button disabled={page === 0} onClick={() => setPage(p => p - 1)}>{t('Previous', '上一页')}</button><span>{page + 1} / {Math.max(1, Math.ceil(rows.length / 20))} · {rows.length} {t('windows', '个窗口')}</span><button disabled={(page + 1) * 20 >= rows.length} onClick={() => setPage(p => p + 1)}>{t('Next', '下一页')}</button></div><p className="result-note">{t('Model scores are not accuracy or disease probability. Window boundaries do not identify exact event boundaries.', '模型分数不代表准确率或患病概率，窗口边界不代表精确事件边界。')}</p>
      </section>}
      <section className="result-card"><h2>{t('Your recording explained', '本次记录解读')}</h2>
        {report?.status === 'ready' ? <><span className="source-tag">{report.source === 'offline_stub' || report.source === 'simulated' ? t('Simulated AI output', '模拟 AI 输出') : report.source === 'deepseek' || report.source === 'live' ? 'DeepSeek' : t('Saved explanation — check source', '已保存解读 · 请核对来源')}</span><Claims answer={report} onEvidence={focusEvidence} /></> : <p>{t('A saved explanation is not available yet. Your numerical results remain accessible.', '尚无可用解读，已有数值结果仍可查看。')}</p>}
        <label className="result-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>{t('Allow the analysis host to send this recording’s structured analysis and my question to DeepSeek for explanation. Raw files, diary entries and account passwords are not sent.', '允许分析主机将本条记录的结构化分析与我的问题发送给 DeepSeek，以生成解读。不发送原始文件、日记或账号密码。')}</span></label>
        <div className="result-actions"><button disabled={busy || !consent || pending.some(j => j.operation === 'report')} onClick={() => void submit('report')}>{report?.status === 'ready' ? t('Review saved report / retry if needed', '查看已存报告／必要时重试') : t('Generate or retry explanation', '生成或重试解读')}</button></div>
        <h3>{t('Ask about this recording', '询问本次记录')}</h3><form onSubmit={event => { event.preventDefault(); if (question.trim()) void submit('chat', { question: question.trim() }); }}><textarea aria-label={t('Your question', '你的问题')} rows={3} maxLength={2000} placeholder={t('What does this highlighted window mean?', '这个窗口的结果代表什么？')} value={question} onChange={e => setQuestion(e.target.value)} /><div className="result-actions"><button className="solid-button" disabled={busy || !consent || !question.trim() || pending.some(j => j.operation === 'chat')}>{t('Send question', '发送问题')}</button></div></form>
        {jobs.filter(j => j.operation === 'chat' && (j.payload?._result_sha256 ?? j.payload?.result_sha256) === hash && (j.status !== 'completed' || j.result?.result_sha256 === hash)).slice().reverse().map(job => <div className="message-item" key={job.id}><strong>{t('You', '我')}</strong><p>{job.payload?.question}</p><strong>{t('Recording assistant', '记录助手')}</strong>{job.status === 'completed' ? <Claims answer={job.result?.answer} onEvidence={focusEvidence} /> : <p>{job.status === 'queued' ? t('Waiting for the analysis host…', '等待分析主机…') : job.status === 'running' ? t('Preparing an answer…', '正在生成回答…') : t('No answer was saved. You can try again.', '未能保存回答，可以重试。')}</p>}</div>)}
      </section>
    </>}
    {evidenceView && <section className="result-card" aria-live="polite"><h2>{t('Supporting evidence', '支持证据')} · {evidenceView.id}</h2><dl>{Object.entries(evidenceView.values).map(([field, value]) => <div className="message-item" key={field}><dt>{field}</dt><dd>{value === null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl></section>}
    <section className="result-card"><h2>{t('Recording information', '记录信息')}</h2>
      {editingDetails ? <form onSubmit={event => void saveDetails(event)} aria-busy={savingDetails}>
        <fieldset disabled={savingDetails} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div style={{ display: 'grid', gap: 16, maxWidth: 720 }}>
            <label>{t('Recording title', '记录名称')}<input required maxLength={200} value={detailsDraft.title} onChange={event => setDetailsDraft(current => ({ ...current, title: event.target.value }))} style={{ display: 'block', width: '100%', marginTop: 6 }} /></label>
            <label>{t('Recorded date and time', '采集日期和时间')}<input required type="datetime-local" value={detailsDraft.recordedAt} onChange={event => setDetailsDraft(current => ({ ...current, recordedAt: event.target.value }))} style={{ display: 'block', marginTop: 6 }} /></label>
            <label>{t('Collection details (optional)', '采集情况（可选）')}<textarea rows={4} maxLength={10000} value={detailsDraft.details} onChange={event => setDetailsDraft(current => ({ ...current, details: event.target.value }))} style={{ display: 'block', marginTop: 6 }} /></label>
          </div>
          <div className="result-actions"><button type="submit" className="solid-button">{savingDetails ? t('Saving…', '正在保存…') : t('Save recording details', '保存记录信息')}</button><button type="button" onClick={() => { setEditingDetails(false); setDetailsError(''); setDetailsSaved(''); }}>{t('Cancel', '取消')}</button></div>
        </fieldset>
        {detailsError && <p className="result-error" role="alert">{detailsError}</p>}
      </form> : <><p className="result-note">{t('Collection details', '采集情况')}</p><p>{record.details || t('Not provided', '未填写')}</p><div className="result-actions"><button type="button" onClick={beginDetailsEdit}>{t('Edit recording details', '编辑记录信息')}</button></div></>}
      {detailsSaved && <p className="result-note" role="status">{detailsSaved}</p>}
      <p className="result-note">{t('Original recording', '原始记录')}</p><p>{record.file_name}</p><div className="result-actions"><PrivateFileLink file={{ path: record.file_path, filename: record.file_name }} recordId={recordingId} t={t} /><a href={`/wellbeing?view=trends&ctxRecord=${recordingId}`}>{t('Compare recordings', '比较记录')}</a><a href={`/wellbeing?view=visits&ctxRecord=${recordingId}`}>{t('Prepare visit notes', '整理就诊资料')}</a></div>
    </section>
    <section className="result-card"><h2>{t('Your notes', '记录备注')}</h2><textarea aria-label={t('Recording notes', '记录备注')} rows={3} maxLength={10000} value={note} onChange={e => setNote(e.target.value)} /><div className="result-actions"><button disabled={busy} onClick={() => void saveNotes()}>{t('Save notes', '保存备注')}</button><button onClick={() => void refresh()} disabled={busy}><RefreshCw size={14} /> {t('Refresh', '刷新')}</button>{saved && <span role="status">{saved}</span>}</div></section>
    <p className="result-note">{t('BreathMap supports recording review, not medical diagnosis. No result or missing result confirms a medical condition.', 'BreathMap 用于记录查看，而非医疗诊断；分析结果及结果缺失均不能用于确诊。')}</p>
  </main>;
}
