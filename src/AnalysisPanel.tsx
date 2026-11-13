import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, MessageCircle, RefreshCw } from 'lucide-react';
import { supabase } from './lib/supabase';
import { formatNumber as num, requestJob, resultIsCurrent, type Waveform } from './lib/analysis';
import { useAuth } from './lib/user';
import { PrivateFileLink } from './components/private-file-link';
import AnalysisSummaryExport from './components/AnalysisSummaryExport';
import { useAssistant } from './components/AssistantProvider';
import { assistantTargetFromUrl, validSelection, type AssistantSelection } from './lib/assistant-context';
import WaveformExplorer, { type TimeRange } from './components/WaveformExplorer';
import { buildIntervalInsight } from './lib/recording-insights';
import './analysis-responsive.css';

const LABELS: Record<string, [string, string]> = { normal: ['Normal breathing', '正常呼吸'], cont: ['Normal breathing', '正常呼吸'], continuous: ['Normal breathing', '正常呼吸'], no_inhale: ['Inspiratory interruption', '吸气中断'], no_exhale: ['Expiratory interruption', '呼气中断'], pause: ['No breathing', '无呼吸'], invalid: ['Unavailable', '不可用'], unknown: ['Uncertain', '不确定'], '正常呼吸': ['Normal breathing', '正常呼吸'], '呼吸暂停': ['No breathing', '无呼吸'], '呼吸障碍（未吸气）': ['Inspiratory interruption', '吸气中断'], '呼吸障碍（未呼气）': ['Expiratory interruption', '呼气中断'], '无法判断': ['Uncertain', '不确定'] };
function localRecordingTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
}
const sameRange = (left: TimeRange | null, right: TimeRange | null) => !!left && !!right && left.start_s === right.start_s && left.end_s === right.end_s;
export default function AnalysisPanel({ recordingId, detailed }: { recordingId: string; detailed: boolean }) {
  const { user } = useAuth();
  const assistant = useAssistant();
  const [lang, setLang] = useState<'en' | 'zh'>(() => localStorage.getItem('breathmap-language') === 'en' ? 'en' : 'zh');
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  const [record, setRecord] = useState<any>(null), [result, setResult] = useState<any>(null), [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [heartbeat, setHeartbeat] = useState<string | null>(null);
  const [wave, setWave] = useState<Waveform | null>(null), [start, setStart] = useState('0'), [end, setEnd] = useState('30');
  const [overviewWave, setOverviewWave] = useState<Waveform | null>(null);
  const [viewRange, setViewRange] = useState<TimeRange>({ start_s: 0, end_s: 30 });
  const [intervalSelection, setIntervalSelection] = useState<AssistantSelection | null>(null);
  const [waveLoading, setWaveLoading] = useState(false), [waveIntentVersion, setWaveIntentVersion] = useState(0);
  const [kind, setKind] = useState<'model' | 'statistics' | 'attention'>('model'), [page, setPage] = useState(0), [selected, setSelected] = useState('');
  const [note, setNote] = useState(''), [saved, setSaved] = useState('');
  const savedNotesForExport = useRef('');
  const [editingDetails, setEditingDetails] = useState(false), [savingDetails, setSavingDetails] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState({ title: '', recordedAt: '', details: '' });
  const [detailsError, setDetailsError] = useState(''), [detailsSaved, setDetailsSaved] = useState('');
  const detailsLock = useRef(false), detailsWriteVersion = useRef(0);
  const detailsDateOrigin = useRef({ stored: '', input: '' });
  const overviewHash = useRef(''), appliedWaveJob = useRef(''), rangeDraftDirty = useRef(false);
  const focusedRange = useRef<AssistantSelection | null>(null), urlFocus = useRef('');
  const desiredWaveRange = useRef<TimeRange | null>(null), requestedWaveKey = useRef('');
  const waveRequestBusy = useRef(false), waveGeneration = useRef(0), initialWaveHash = useRef('');
  const alive = useRef(true), previousResult = useRef<string | null>(null), refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!supabase || !user) return;
    const sequence = ++refreshSequence.current;
    const metadataVersion = detailsWriteVersion.current;
    const [r, a, j, h] = await Promise.all([
      supabase.from('recordings').select('id,user_id,title,notes,details,file_path,file_name,file_size,recorded_at,uploaded_at,trashed_at').eq('id', recordingId).is('trashed_at', null).maybeSingle(),
      supabase.from('analysis_results').select('*').eq('recording_id', recordingId).maybeSingle(),
      supabase.from('analysis_jobs').select('id,recording_id,operation,payload,status,result,error_code,created_at,finished_at').eq('recording_id', recordingId).order('created_at', { ascending: false }).limit(40),
      supabase.from('worker_heartbeat').select('last_seen').order('last_seen', { ascending: false }).limit(1),
    ]);
    if (!alive.current || sequence !== refreshSequence.current) return;
    const issue = r.error ?? a.error ?? j.error;
    if (issue) { setError(t('Your record could not be refreshed. Please try again.', '暂时无法刷新记录，请重试。')); setLoading(false); return; }
    if (metadataVersion === detailsWriteVersion.current) {
      savedNotesForExport.current = typeof r.data?.notes === 'string' ? r.data.notes : '';
      setRecord(r.data);
    }
    setResult(a.data); setJobs(j.data ?? []); setHeartbeat(h.data?.[0]?.last_seen ?? null); setLoading(false);
    if (previousResult.current && a.data?.result_sha256 !== previousResult.current) {
      setWave(null); setOverviewWave(null); setPage(0); setSelected(''); setIntervalSelection(null); setWaveLoading(false);
      setViewRange({ start_s: 0, end_s: 30 }); setStart('0'); setEnd('30');
      overviewHash.current = ''; appliedWaveJob.current = ''; rangeDraftDirty.current = false; focusedRange.current = null; urlFocus.current = '';
      desiredWaveRange.current = null; requestedWaveKey.current = ''; initialWaveHash.current = ''; waveRequestBusy.current = false; waveGeneration.current++;
    }
    previousResult.current = a.data?.result_sha256 ?? null;
  }, [recordingId, user?.id, lang]);
  useEffect(() => { alive.current = true; void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => { alive.current = false; clearInterval(timer); }; }, [refresh]);
  useEffect(() => {
    setWave(null); setOverviewWave(null); setPage(0); setSelected(''); setIntervalSelection(null); setWaveLoading(false);
    setViewRange({ start_s: 0, end_s: 30 }); setStart('0'); setEnd('30');
    overviewHash.current = ''; appliedWaveJob.current = ''; rangeDraftDirty.current = false; focusedRange.current = null; urlFocus.current = '';
    desiredWaveRange.current = null; requestedWaveKey.current = ''; initialWaveHash.current = ''; waveRequestBusy.current = false; waveGeneration.current++;
  }, [recordingId]);
  useEffect(() => { if (record) setNote(record.notes ?? ''); }, [record?.id, record?.notes]);
  useEffect(() => { localStorage.setItem('breathmap-language', lang); }, [lang]);
  const hash = result?.result_sha256;
  const display = resultIsCurrent(result?.display, hash) ? result.display : null;
  const extentStart = Number.isFinite(display?.extent?.analysis_start_s) ? display.extent.analysis_start_s : 0;
  const extentEnd = Number.isFinite(display?.extent?.analysis_end_s) ? display.extent.analysis_end_s : Number.isFinite(display?.extent?.duration_s) ? extentStart + display.extent.duration_s : 43200;
  const bounds: TimeRange = { start_s: extentStart, end_s: Math.max(extentStart + .01, extentEnd) };
  useEffect(() => {
    const overview = result?.wave_manifest?.overview;
    if (!supabase || !hash || !resultIsCurrent(result?.wave_manifest, hash) || overviewHash.current === hash || !overview?.path || !user || !overview.path.startsWith(`${user.id}/${recordingId}/${hash}/`) || overview.bucket !== 'analysis-artifacts') return;
    overviewHash.current = hash; let cancelled = false;
    supabase.storage.from('analysis-artifacts').download(overview.path).then(async ({ data, error: issue }) => {
      if (issue || !data || data.size > 5 * 1024 * 1024 || cancelled) return;
      try {
        const next = JSON.parse(await data.text());
        if (!cancelled && next?.columns && next?.points) {
          setOverviewWave(next);
          if (!appliedWaveJob.current) {
            setWave(next);
            if (!rangeDraftDirty.current && !focusedRange.current && !desiredWaveRange.current) {
              const initial = { start_s: next.range.start_s, end_s: Math.min(next.range.end_s, next.range.start_s + 30) };
              setViewRange(initial); setStart(String(initial.start_s)); setEnd(String(initial.end_s));
            }
          }
        }
      } catch { /* Keep metrics available when the cached waveform cannot be read. */ }
    });
    return () => { cancelled = true; };
  }, [hash, recordingId, user?.id, result?.wave_manifest?.overview?.path]);
  useEffect(() => {
    if (!hash) return;
    const current = jobs.filter(j => j.operation === 'waveform' && (j.payload?._result_sha256 ?? j.payload?.result_sha256) === hash);
    if (!desiredWaveRange.current) {
      const waiting = current.find(j => ['queued', 'running'].includes(j.status));
      if (waiting && Number.isFinite(waiting.payload?.start) && Number.isFinite(waiting.payload?.end)) {
        const target = { start_s: waiting.payload.start, end_s: waiting.payload.end };
        desiredWaveRange.current = target; setViewRange(target); setWaveLoading(true);
        if (!rangeDraftDirty.current) { setStart(String(target.start_s)); setEnd(String(target.end_s)); }
      }
    }
    const job = current.find(j => j.status === 'completed' && j.result?.waveform && j.result.result_sha256 === hash && (!desiredWaveRange.current || sameRange(desiredWaveRange.current, { start_s: j.payload?.start, end_s: j.payload?.end })));
    if (job) setWaveLoading(false);
    if (job && (appliedWaveJob.current !== job.id || !sameRange(wave?.range ?? null, job.result.waveform.range))) {
      const next = job.result.waveform as Waveform;
      appliedWaveJob.current = job.id; setWave(next); setViewRange(next.range); setWaveLoading(false);
      desiredWaveRange.current = next.range;
      requestedWaveKey.current = `${hash}:${next.range.start_s}:${next.range.end_s}`;
      if (!rangeDraftDirty.current) { setStart(String(job.result.waveform.range.start_s)); setEnd(String(job.result.waveform.range.end_s)); }
    }
  }, [jobs, hash, waveIntentVersion, wave]);
  async function submit(operation: 'analyse' | 'report' | 'chat' | 'waveform', payload: Record<string, unknown> = {}) {
    if (busy) return; setBusy(true); setError(''); setSaved('');
    try { await requestJob(recordingId, operation, { ...payload, language: lang, ...(hash ? { result_sha256: hash } : {}) }); await refresh(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : t('The request could not be saved.', '请求未能保存。')); }
    finally { setBusy(false); }
  }
  const pending = jobs.filter(j => ['queued', 'running'].includes(j.status));
  const analysisPending = pending.some(job => job.operation === 'analyse');
  const latestAnalysis = jobs.find(job => job.operation === 'analyse');
  const online = !!heartbeat && Date.now() - new Date(heartbeat).getTime() < 90000;
  const execution = display?.execution?.status;
  const summary = display?.summary;
  const usable = ['success', 'partial'].includes(execution);
  const retryAnalysis = !usable && (!!result || ['failed', 'interrupted'].includes(latestAnalysis?.status));
  const breathingRate = num(summary?.frequency_bpm);
  const expiratoryFlow = num(summary?.mean_expiratory_flow_l_min);
  const validModelWindows = num(display?.window_counts?.valid_model, 0);
  const modelWindows = num(display?.window_counts?.model, 0);
  const unavailable = t('Unavailable', '暂无结果');
  const report = display?.report;
  const modelRows: any[] = resultIsCurrent(result?.windows?.model, hash) ? result.windows.model.items ?? [] : [];
  const statisticsRows: any[] = resultIsCurrent(result?.windows?.statistics, hash) ? result.windows.statistics.items ?? [] : [];
  const attentionRows: any[] = resultIsCurrent(result?.windows?.attention, hash) ? result.windows.attention.items ?? [] : [];
  const intervalInsight = buildIntervalInsight({ selection: intervalSelection ?? viewRange, model: modelRows, statistics: statisticsRows }, lang);
  const patternCounts: Record<string, number> = summary?.model_window_counts ?? {};
  const rows = resultIsCurrent(result?.windows?.[kind], hash) ? result.windows[kind].items ?? [] : [];
  const selectedRows = rows.slice(page * 20, page * 20 + 20);
  const label = (value: string) => { const pair = LABELS[value?.toLowerCase().replace(/[ -]/g, '_')]; return pair ? t(...pair) : value ?? '—'; };
  function requestWaveRange(next: TimeRange) {
    const checked = validSelection(next, bounds.end_s);
    if (!checked || checked.start_s < bounds.start_s || !hash || !usable) {
      setError(t('Choose a valid interval within this recording.', '请选择记录范围内的有效区间。')); return;
    }
    const target = { start_s: checked.start_s, end_s: checked.end_s };
    rangeDraftDirty.current = false; desiredWaveRange.current = target;
    setStart(String(target.start_s)); setEnd(String(target.end_s)); setViewRange(target); setError('');
    if (overviewWave && sameRange(target, overviewWave.range)) {
      setWave(overviewWave); setWaveLoading(false); requestedWaveKey.current = `${hash}:${target.start_s}:${target.end_s}`;
    } else { setWaveLoading(true); requestedWaveKey.current = ''; }
    setWaveIntentVersion(value => value + 1);
  }
  // Commit only the most recent gesture. While a read is pending, later drags
  // replace the desired range locally; an old reply cannot move the view back.
  useEffect(() => {
    const target = desiredWaveRange.current;
    if (!target || !hash || !usable || busy || waveRequestBusy.current) return;
    if (overviewWave && sameRange(target, overviewWave.range)) return;
    const current = jobs.filter(job => job.operation === 'waveform' && (job.payload?._result_sha256 ?? job.payload?.result_sha256) === hash);
    if (current.some(job => job.status === 'completed' && job.result?.waveform && job.result?.result_sha256 === hash && sameRange(target, { start_s: job.payload?.start, end_s: job.payload?.end }))) return;
    if (current.some(job => ['queued', 'running'].includes(job.status))) return;
    const key = `${hash}:${target.start_s}:${target.end_s}`;
    if (requestedWaveKey.current === key) {
      if (current.some(job => ['failed', 'interrupted'].includes(job.status) && sameRange(target, { start_s: job.payload?.start, end_s: job.payload?.end }))) setWaveLoading(false);
      return;
    }
    const generation = waveGeneration.current;
    requestedWaveKey.current = key; waveRequestBusy.current = true; setWaveLoading(true);
    void requestJob(recordingId, 'waveform', { start: target.start_s, end: target.end_s, max_points: 5000, language: lang, result_sha256: hash })
      .then(() => { if (alive.current && waveGeneration.current === generation) return refresh(); })
      .catch(issue => { if (alive.current && waveGeneration.current === generation && sameRange(desiredWaveRange.current,target)) { setError(issue instanceof Error ? issue.message : t('The interval could not be loaded. Try again.', '区间未能载入，请重试。')); setWaveLoading(false); } })
      .finally(() => { if (alive.current && waveGeneration.current === generation) { waveRequestBusy.current = false; setWaveIntentVersion(value => value + 1); } });
  }, [jobs, hash, usable, busy, waveIntentVersion, overviewWave, recordingId, lang, refresh]);
  useEffect(() => {
    if (!hash || !usable || !online || initialWaveHash.current === hash || rangeDraftDirty.current || focusedRange.current || desiredWaveRange.current) return;
    if (jobs.some(job => job.operation === 'waveform' && (job.payload?._result_sha256 ?? job.payload?.result_sha256) === hash)) return;
    initialWaveHash.current = hash;
    requestWaveRange({ start_s: bounds.start_s, end_s: Math.min(bounds.end_s, bounds.start_s + 30) });
  }, [hash, usable, online, jobs, bounds.start_s, bounds.end_s]);
  async function saveNotes() {
    if (!supabase || !user || busy) return;
    const nextNotes = note.trim();
    setBusy(true); setError(''); setSaved('');
    try {
      const response = await supabase.from('recordings').update({ notes: nextNotes }).eq('id', recordingId).eq('user_id', user.id).is('trashed_at', null).select('id').single();
      if (response.error || !response.data) throw new Error('not_saved');
      detailsWriteVersion.current++;
      if (!alive.current) return;
      savedNotesForExport.current = nextNotes;
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
  function focusInterval(next: AssistantSelection, load = true) {
    const selection = validSelection(next, bounds.end_s);
    if (!selection || selection.start_s < bounds.start_s || !hash) return;
    if (selection.window_id && selection.kind) {
      const collection = result?.windows?.[selection.kind];
      if (!resultIsCurrent(collection, hash)) return;
      const index = collection.items?.findIndex((row: any) => row.window_id === selection.window_id && row.start_s === selection.start_s && row.end_s === selection.end_s) ?? -1;
      if (index < 0) return;
      setKind(selection.kind); setPage(Math.floor(index / 20)); setSelected(selection.window_id);
    } else setSelected('');
    rangeDraftDirty.current = false; focusedRange.current = selection; setIntervalSelection(selection);
    setStart(String(selection.start_s)); setEnd(String(selection.end_s)); setViewRange(selection);
    document.getElementById('waveforms')?.scrollIntoView({ behavior: 'auto', block: 'start' });
    if (load) requestWaveRange(selection);
  }
  function focusRow(row: any) { focusInterval({ start_s: row.start_s, end_s: row.end_s, window_id: row.window_id, kind }); }
  function commitWaveRange(next: TimeRange, intent?: 'pan' | 'zoom' | 'select' | 'overview') {
    if (intent === 'select') {
      const selection = validSelection(next, bounds.end_s);
      if (!selection || selection.start_s < bounds.start_s) return;
      setSelected(''); setIntervalSelection(selection); focusedRange.current = selection;
    }
    requestWaveRange(next);
  }
  useEffect(() => {
    const next = assistantTargetFromUrl();
    if (!next?.selection || next.recordingId !== recordingId || !hash || !usable) return;
    if (next.resultHash && next.resultHash !== hash) { setError(t('This reference belongs to an earlier analysis. Review the current results before selecting an interval.', '这条引用对应此前的分析版本，请根据当前结果重新选择区间。')); return; }
    const key = `${recordingId}:${hash}:${JSON.stringify(next.selection)}`;
    if (urlFocus.current !== key) { urlFocus.current = key; focusInterval(next.selection); }
  }, [recordingId, hash, usable]);
  useEffect(() => {
    const focus = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.recordingId === recordingId && detail.resultHash === hash) focusInterval(detail.selection);
    };
    window.addEventListener('breathmap:focus-evidence', focus);
    return () => window.removeEventListener('breathmap:focus-evidence', focus);
  }, [recordingId, hash, busy, lang]);
  const askAssistant = (range?: AssistantSelection) => assistant.show({ recordingId, resultHash: hash, ...(range ? { selection: range } : {}) });
  if (loading) return <main className="app-loading" role="status">{t('Loading your record…', '正在读取记录…')}</main>;
  if (!record) return <main className="auth-shell"><section className="auth-card"><h1>{t('Record not found', '未找到记录')}</h1><p>{error || t('This record is unavailable in your account.', '当前账号无法访问这条记录。')}</p><a href="/recordings">{t('Saved recordings', '历史记录')}</a></section></main>;
  return <main className="result-shell" lang={lang === 'zh' ? 'zh-CN' : 'en'}>
    <header className="result-top"><a className="auth-brand" href="/"><Activity />BreathMap</a><nav className="result-links" aria-label={t('Recording navigation', '记录导航')}><a href="/recordings"><ArrowLeft size={15} /> {t('Saved recordings', '历史记录')}</a><a href={`/wellbeing?view=diary&ctxRecord=${recordingId}`}>{t('Linked diary', '关联日记')}</a><a href="/account">{t('Account', '账号')}</a><button className="text-button" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>{lang === 'zh' ? 'English' : '中文'}</button></nav></header>
    <header className="result-heading">
    <p className="eyebrow">{detailed ? t('DETAILED ANALYSIS', '详细分析') : t('RECORDING REPORT', '记录报告')}</p><h1>{record.title}</h1>
    <p className="result-subtitle">{new Date(record.recorded_at ?? record.uploaded_at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB')} · {t('Duration', '时长')} {num(display?.extent?.duration_s)} s</p>
    {usable && <AnalysisSummaryExport key={recordingId} lang={lang} readSnapshot={() => ({
      title: record.title ?? '',
      recordedAt: record.recorded_at ?? null,
      duration: num(display?.extent?.duration_s),
      breathingRate,
      expiratoryFlow,
      partial: execution === 'partial',
      partialReasons: display?.execution?.partial_reasons,
      savedNotes: savedNotesForExport.current,
    })} />}
    </header>
    <nav className="result-assistant-tabs" aria-label={t('Recording workspace', '记录工作区')}><a href={`/analysis?recordId=${recordingId}`} aria-current={detailed ? 'page' : undefined}>{t('Data analysis', '数据分析')}</a><button type="button" onClick={() => askAssistant()}><MessageCircle size={17} />{t('AI explanation & chat', 'AI 解读与对话')}</button></nav>
    {error && <p role="alert" className="result-status error">{error}</p>}
    {pending.length > 0 && <div className="result-status" role="status">{pending.some(j => j.status === 'running') ? t('Your request is being processed.', '正在处理你的请求。') : online ? t('Your request is queued for the analysis host.', '请求已排队，等待分析主机处理。') : t('Your request has been saved. It will continue when the analysis host is available.', '请求已保存，将在分析主机可用后继续。')}</div>}
    {!analysisPending && ['error', 'unable_to_analyze'].includes(execution) && <div className="result-status error">{t('This recording could not be fully analysed. You can retry analysis using the original file.', '这条记录无法完成分析，可以使用原文件重试分析。')}</div>}
    {usable && <section className="result-grid" aria-label={t('Recording metrics', '记录指标')}>
      <div className="result-metric"><span>{t('Mean breathing rate', '平均呼吸频率')}</span><strong>{breathingRate}</strong><small>{breathingRate === '—' ? unavailable : t('breaths/min', '次/分')}</small></div>
      <div className="result-metric"><span>{t('Mean estimated expiratory flow', '平均估计呼气流量')}</span><strong>{expiratoryFlow}</strong><small>{expiratoryFlow === '—' ? unavailable : 'L/min'}</small></div>
      <div className="result-metric"><span>{t('Valid model windows', '有效模型窗口')}</span><strong>{validModelWindows} / {modelWindows}</strong>{(validModelWindows === '—' || modelWindows === '—') && <small>{unavailable}</small>}</div>
    </section>}
    <nav className="result-section-links" aria-label={t('On this recording', '本次记录内容')}>{usable && <a href="#waveforms">{t('Waveforms', '波形')}</a>}{usable && detailed && <a href="#analysis-windows">{t('Analysis windows', '分析窗口')}</a>}<a href="#recording-information">{t('Recording information', '记录信息')}</a><a href="#recording-notes">{t('Your notes', '记录备注')}</a></nav>
    <div className="result-workspace">
    <div className="result-primary">
    {!result && !analysisPending && !retryAnalysis && <section className="result-card"><h2>{t('Ready to analyse', '准备分析')}</h2><p>{t('Your original recording is saved. Start analysis to calculate breathing metrics and identify patterns in short sections of the recording.', '原始记录已保存。开始分析后，将计算指标并使用已有模型对呼吸窗口分类。')}</p><button className="solid-button" disabled={busy} onClick={() => void submit('analyse')}>{t('Start analysis', '开始分析')}</button></section>}
    {!analysisPending && jobs.filter(j => ['failed', 'interrupted'].includes(j.status)).slice(0, 1).map(job => <div className="result-status warn" key={job.id}>{t('A previous request needs attention.', '此前有一项请求需要处理。')} {job.error_code}<p className="result-note">{job.status === 'interrupted' ? t('The operator must review the interrupted task before it is run again.', '中断的任务需要操作员复核后再继续。') : usable ? t('You can retry the relevant action below. Saved numerical results are retained.', '可在下方重试对应操作，已有数值结果会保留。') : t('You can retry the relevant action below.', '可在下方重试对应操作。')}</p></div>)}
    {retryAnalysis && !analysisPending && <div className="result-actions"><button className="solid-button" disabled={busy} onClick={() => void submit('analyse')}>{t('Retry analysis', '重试分析')}</button></div>}
    {usable && <>
      {!detailed && <div className="result-actions"><a className="solid-button" href={`/analysis?recordId=${recordingId}`}>{t('View detailed analysis', '查看详细分析')} <ArrowRight size={15} /></a></div>}
      <section className="result-card recording-findings" aria-label={t('Recording findings', '记录结果概览')}>
        <h2>{t('Breathing patterns identified by the model', '这次记录的模型结果')}</h2>
        <p>{t('Review the window patterns below, then inspect their highlighted waveforms.', '先查看模型标记的模式，再结合高亮波形核对具体区间。')}</p>
        <div className="pattern-counts">{Object.entries(patternCounts).filter(([,count]) => Number.isFinite(count) && count > 0).map(([pattern,count]) => {
          const first = modelRows.find(row => row.label === pattern && row.valid !== false);
          return <button type="button" key={pattern} disabled={!first} onClick={() => first && focusInterval({ start_s:first.start_s,end_s:first.end_s,window_id:first.window_id,kind:'model' })}><span>{label(pattern)}</span><strong>{num(count,0)}</strong><small>{t('windows', '个窗口')}</small></button>;
        })}</div>
        {attentionRows.length > 0 && <button type="button" className="text-button" onClick={() => focusInterval({ start_s:attentionRows[0].start_s,end_s:attentionRows[0].end_s,window_id:attentionRows[0].window_id,kind:'attention' })}>{t('Inspect the first flagged window', '查看首个关注窗口')} <ArrowRight size={15}/></button>}
        <p className="result-note">{t('The counts show how many time windows the model assigned to each pattern. Windows may overlap.', '数量表示模型归入各模式的时间窗口数，窗口之间可能重叠。')}</p>
      </section>
      <section className="result-card" id="waveforms"><h2>{t('Synchronized waveforms', '同步波形')}</h2><p className="result-note">{t('Zoom or drag to inspect saved signals. All three tracks share one time range.', '缩放或拖动查看已保存信号，三条波形始终使用同一时间范围。')}</p>
        <form className="wave-controls" onSubmit={event => { event.preventDefault(); focusInterval({ start_s: Number(start), end_s: Number(end) }); }}>
          <label>{t('Start (seconds)', '起点（秒）')}<input required type="number" min={bounds.start_s} max={bounds.end_s} step="0.01" value={start} onChange={e => { rangeDraftDirty.current = true; setStart(e.target.value); }} /></label><label>{t('End (seconds)', '终点（秒）')}<input required type="number" min={bounds.start_s} max={bounds.end_s} step="0.01" value={end} onChange={e => { rangeDraftDirty.current = true; setEnd(e.target.value); }} /></label><button className="solid-button" disabled={busy}>{t('Show waveform for this range', '载入区间')}</button><button type="button" className="assistant-secondary" disabled={!validSelection({ start_s: Number(start), end_s: Number(end) }, bounds.end_s)} onClick={() => askAssistant(!rangeDraftDirty.current && intervalSelection ? intervalSelection : { start_s: Number(start), end_s: Number(end) })}><MessageCircle size={16} />{t('Ask about this interval', '询问这段波形')}</button>
        </form>
        <section className="interval-insight" aria-label={t('Selected interval results', '所选区间结果')} aria-live="polite">
          <div className="interval-insight-heading"><h3>{intervalInsight.title}</h3>{intervalSelection && !sameRange(intervalSelection,viewRange) && <button type="button" onClick={() => requestWaveRange(intervalSelection)}>{t('Return to the selected interval', '回到所选区间')}</button>}</div>
          {intervalInsight.highlights.map(detail => <p key={detail}>{detail}</p>)}
          <details><summary>{t('Window and metric details', '窗口与指标说明')}</summary>{intervalInsight.details.map(detail => <p className="result-note" key={detail}>{detail}</p>)}</details>
        </section>
        {wave || overviewWave ? <WaveformExplorer wave={wave} overview={overviewWave} bounds={bounds} range={viewRange} selection={intervalSelection} lang={lang} loading={waveLoading} onRangeCommit={commitWaveRange}/> : <p className="result-note">{t('The saved waveform is loading, or select an interval to request it from the analysis host.', '正在读取已保存波形，也可选择区间向分析主机请求。')}</p>}
      </section>
      {detailed && <section className="result-card" id="analysis-windows"><h2>{t('Analysis windows', '分析窗口')}</h2><div className="result-tabs" role="tablist" aria-label={t('Window collections', '窗口分类')}>{(['model', 'statistics', 'attention'] as const).map(key => <button role="tab" aria-selected={kind === key} aria-controls="analysis-window-table" id={`window-tab-${key}`} className="result-tab" key={key} onClick={() => { setKind(key); setPage(0); }}>{key === 'model' ? t('Model', '模型') : key === 'statistics' ? t('Statistics', '统计') : t('Attention', '关注')}</button>)}</div>
        <div className="result-table-wrap" id="analysis-window-table" role="tabpanel" aria-labelledby={`window-tab-${kind}`}><table className="result-table" role="table" aria-label={t('Saved analysis windows', '已保存的分析窗口')}><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">ID</th><th role="columnheader" scope="col">{t('Interval (s)', '区间（秒）')}</th>{kind === 'statistics' ? <><th role="columnheader" scope="col">{t('Rate (breaths/min)', '频率（次/分）')}</th><th role="columnheader" scope="col">{t('Mean estimated expiratory flow (L/min)', '流量（L/min）')}</th></> : <><th role="columnheader" scope="col">{t('Pattern', '模式')}</th><th role="columnheader" scope="col">{t('Model score', '模型分数')}</th></>}<th role="columnheader" scope="col">{t('Waveform', '波形')}</th></tr></thead><tbody role="rowgroup">{selectedRows.map((row: any) => <tr role="row" key={row.window_id} aria-selected={selected === row.window_id}><td role="cell" data-label="ID">{row.window_id}</td><td role="cell" data-label={t('Interval (s)', '区间（秒）')}>{num(row.start_s)}–{num(row.end_s)}</td>{kind === 'statistics' ? <><td role="cell" data-label={t('Rate (breaths/min)', '频率（次/分）')}>{num(row.frequency_bpm)}</td><td role="cell" data-label={t('Mean estimated expiratory flow (L/min)', '流量（L/min）')}>{num(row.mean_expiratory_flow_l_min)}</td></> : <><td role="cell" data-label={t('Pattern', '模式')}>{label(row.label)}</td><td role="cell" data-label={t('Model score', '模型分数')}>{num(row.top_score, 3)}</td></>}<td role="cell" data-label={t('Waveform', '波形')}><button onClick={() => focusRow(row)}>{t('View waveform', '选择区间')}</button></td></tr>)}</tbody></table></div>
        {rows.length === 0 && <p>{t('No saved windows in this collection.', '此分类暂无已保存窗口。')}</p>}
        <div className="result-actions result-pagination"><button disabled={page === 0} onClick={() => setPage(p => p - 1)}>{t('Previous', '上一页')}</button><span aria-live="polite">{page + 1} / {Math.max(1, Math.ceil(rows.length / 20))} · {rows.length} {t('windows', '个窗口')}</span><button disabled={(page + 1) * 20 >= rows.length} onClick={() => setPage(p => p + 1)}>{t('Next', '下一页')}</button></div><p className="result-note">{t('Model scores are not accuracy or disease probability. Window boundaries do not identify exact event boundaries.', '模型分数不代表准确率或患病概率，窗口边界不代表精确事件边界。')}</p>
      </section>}
    </>}
    </div>
    <aside className="result-secondary" aria-label={t('Explanation and recording details', '解读与记录资料')}>
    <section className="result-ai-entry"><div><MessageCircle size={22} /><div><h2>{t('Understand this recording with AI', '与 AI 一起读懂这次记录')}</h2><p>{report?.status === 'ready' ? t('Your saved explanation is available. Open it or ask about a specific interval.', '已有解读可供阅读，也可以针对具体片段继续提问。') : t('Review an explanation, ask about a metric, and follow each reference back to the waveform.', '阅读结果解读，询问指标变化，通过引用查看对应波形。')}</p></div></div><button type="button" className="assistant-primary" onClick={() => askAssistant()}>{t('Open AI assistant', '打开 AI 助手')}<ArrowRight size={17} /></button></section>
    <section className="result-card result-information" id="recording-information"><h2>{t('Recording information', '记录信息')}</h2>
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
    <section className="result-card result-notes" id="recording-notes"><h2>{t('Your notes', '记录备注')}</h2><textarea aria-label={t('Recording notes', '记录备注')} rows={3} maxLength={10000} value={note} onChange={e => setNote(e.target.value)} /><div className="result-actions"><button disabled={busy} onClick={() => void saveNotes()}>{t('Save notes', '保存备注')}</button><button onClick={() => void refresh()} disabled={busy}><RefreshCw size={14} /> {t('Refresh', '刷新')}</button>{saved && <span role="status">{saved}</span>}</div></section>
    </aside>
    </div>
  </main>;
}
