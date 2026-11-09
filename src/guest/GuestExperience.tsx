import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Activity, ArrowRight, BookOpen, Check, ClipboardList, FileText, LockKeyhole, MessageCircle, Upload } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { loginHref, safeReturnTo } from '../lib/auth-return';
import { guestDemo } from './demo-data';
import './guest.css';

type View = 'overview' | 'waveform' | 'explanation' | 'learn';
type Copy = { en: string; zh: string };
type Action = { target: string; title: Copy; description: Copy };
export type GuestExperienceProps = { initialLoginTarget?: string; signedIn?: boolean; initialView?: View };
const views: View[] = ['overview', 'waveform', 'explanation', 'learn'];
const labels: Record<View, Copy> = {
  overview: { en: 'Overview', zh: '产品概览' }, waveform: { en: 'Demo waveform', zh: '演示波形' },
  explanation: { en: 'Example explanation', zh: '示例 AI 解读' }, learn: { en: 'Sleep guide', zh: '睡眠知识' },
};
const actions = {
  upload: { target: '/upload', title: { en: 'Sign in to upload your recording', zh: '登录后上传你的呼吸记录' }, description: { en: 'Keep your own recordings and their analysis in your account, ready to revisit later.', zh: '将自己的记录和分析结果保存在账号中，方便之后继续回顾。' } },
  analysis: { target: '/upload', title: { en: 'Sign in to analyse your recording', zh: '登录后分析你的呼吸记录' }, description: { en: 'Upload a compatible recording and start its analysis from your personal workspace.', zh: '在个人工作区上传兼容的记录，再发起分析。' } },
  diary: { target: '/wellbeing?view=diary', title: { en: 'Sign in to keep your sleep diary', zh: '登录后记录你的睡眠日记' }, description: { en: 'Your observations and saved diary entries belong to your own account.', zh: '你的个人观察和已保存日记只保存在自己的账号中。' } },
  history: { target: '/recordings', title: { en: 'Sign in to view your saved recordings', zh: '登录后查看你的个人记录' }, description: { en: 'Open your private recording history and saved results.', zh: '打开个人记录历史与已保存的分析结果。' } },
  notes: { target: '/recordings', title: { en: 'Sign in to save recording notes', zh: '登录后保存记录备注' }, description: { en: 'Add notes to your own recording without changing this shared example.', zh: '为自己的记录补充备注，保留在个人账号中。' } },
  chat: { target: '/assistant', title: { en: 'Sign in to ask your own question', zh: '登录后提出你的问题' }, description: { en: 'Continue with the AI assistant from your own account. This preview only shows a saved example.', zh: '在自己的账号中继续与 AI 助手讨论。当前预览只展示已保存示例。' } },
} satisfies Record<string, Action>;

function actionForTarget(target: string): Action {
  const safe = safeReturnTo(target);
  const url = new URL(safe, 'https://breathmap.invalid');
  const action = url.pathname === '/upload' ? actions.upload : url.pathname === '/assistant' ? actions.chat
    : url.pathname === '/wellbeing' ? actions.diary
    : ['/analysis', '/report', '/recordings', '/trash'].includes(url.pathname) ? actions.history
    : { target: safe, title: { en: 'Sign in to open your workspace', zh: '登录后进入个人工作区' }, description: { en: 'Your personal information and saved work are available after sign-in.', zh: '登录后可查看个人资料和已保存的内容。' } };
  return { ...action, target: safe };
}

function Waveform({ channel, label, unit, start, end, color, lang }: { channel: 'magnetic' | 'flow' | 'sig'; label: string; unit: string; start: number; end: number; color: string; lang: 'en' | 'zh' }) {
  const points = guestDemo.points.map((point, index) => ({ ...point, index })).filter(point => point.t >= start && point.t <= end);
  const breaks = new Set(guestDemo.breakBefore[channel]);
  const values = points.map(point => point[channel]).filter((value): value is number => value !== null && Number.isFinite(value));
  if (!values.length) return <figure className="guest-wave"><figcaption>{label} <span>{unit}</span></figcaption><p>{lang === 'zh' ? '此示例区间没有可显示的通道数据。' : 'No channel data is available in this example interval.'}</p></figure>;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  let path = '', continuation = false;
  for (const point of points) {
    if (breaks.has(point.index)) continuation = false;
    const value = point[channel];
    if (value === null || !Number.isFinite(value)) { continuation = false; continue; }
    const x = 16 + (point.t - start) / (end - start) * 868;
    const y = 126 - (value - min) / span * 104;
    path += `${continuation ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
    continuation = true;
  }
  return <figure className="guest-wave">
    <figcaption>{label}<span>{unit}</span></figcaption>
    <svg viewBox="0 0 900 150" role="img" aria-label={`${label}, ${start}–${end} ${lang === 'zh' ? '秒' : 'seconds'}`}>
      {[30, 75, 120].map(y => <line key={y} x1="16" x2="884" y1={y} y2={y} stroke="#dce9e4" strokeWidth="1" />)}
      <path d={path} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
    <div className="guest-wave-axis"><span>{start} s</span><span>{end} s</span></div>
  </figure>;
}

export default function GuestExperience({ initialLoginTarget, signedIn = false, initialView = 'overview' }: GuestExperienceProps) {
  const [lang, setLang] = useState<'en' | 'zh'>(() => { try { return localStorage.getItem('breathmap-language') === 'en' ? 'en' : 'zh'; } catch { return 'zh'; } });
  const [view, setView] = useState<View>(views.includes(initialView) ? initialView : 'overview');
  const first = guestDemo.intervals[0];
  const [range, setRange] = useState({ start: first?.start ?? 0, end: first?.end ?? Math.min(30, guestDemo.durationSeconds) });
  const [startDraft, setStartDraft] = useState(String(range.start));
  const [endDraft, setEndDraft] = useState(String(range.end));
  const [rangeError, setRangeError] = useState(false);
  const [action, setAction] = useState<Action | null>(() => initialLoginTarget ? actionForTarget(initialLoginTarget) : null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const protectedTrigger = useRef<HTMLButtonElement | null>(null);
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  const copy = (value: Copy) => value[lang];
  useEffect(() => { if (initialLoginTarget) setAction(actionForTarget(initialLoginTarget)); }, [initialLoginTarget]);
  useEffect(() => { setView(views.includes(initialView) ? initialView : 'overview'); }, [initialView]);
  useEffect(() => { try { localStorage.setItem('breathmap-language', lang); } catch { /* Storage is optional for a read-only preview. */ } }, [lang]);

  function selectRange(start: number, end: number) {
    setRange({ start, end }); setStartDraft(String(start)); setEndDraft(String(end)); setRangeError(false);
  }
  function openWaveform(start: number, end: number) { selectRange(start, end); setView('waveform'); }
  function loadRange() {
    const start = Number(startDraft), end = Number(endDraft);
    if (!startDraft.trim() || !endDraft.trim() || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > guestDemo.durationSeconds || end <= start) { setRangeError(true); return; }
    selectRange(start, end);
  }
  function requestAction(next: Action, event: MouseEvent<HTMLButtonElement>) {
    if (signedIn) { window.location.assign(safeReturnTo(next.target)); return; }
    protectedTrigger.current = event.currentTarget; setAction(next);
  }
  function keyboardTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % views.length;
    else if (event.key === 'ArrowLeft') next = (index + views.length - 1) % views.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = views.length - 1;
    else return;
    event.preventDefault(); setView(views[next]); tabRefs.current[next]?.focus();
  }
  const decimals = (value: number | null, digits: number) => value === null ? '—' : value.toFixed(digits);
  const metrics = [
    { label: t('Mean breathing rate', '平均呼吸频率'), value: decimals(guestDemo.summary.breathingRate, 1), unit: t('breaths/min', '次／分') },
    { label: t('Mean estimated expiratory flow', '平均估计呼气流量'), value: decimals(guestDemo.summary.expiratoryFlow, 2), unit: 'L/min' },
    { label: t('Valid model windows', '有效模型窗口'), value: `${guestDemo.summary.validModelWindows ?? '—'}/${guestDemo.summary.totalModelWindows ?? '—'}`, unit: t('overlapping windows', '重叠窗口') },
  ];

  return <main className="guest-app" lang={lang === 'zh' ? 'zh-CN' : 'en'}>
    <header className="guest-header">
      <a className="guest-brand" href="/demo"><Activity aria-hidden="true" /><span>BreathMap</span></a>
      <div className="guest-header-actions"><span className="guest-mode">{t('Guest preview', '游客体验')}</span><button type="button" className="guest-text-button" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>{lang === 'zh' ? 'English' : '中文'}</button><a className="guest-button guest-button-small" href={signedIn ? '/' : loginHref('/demo')}>{signedIn ? t('Go to workspace', '进入工作区') : t('Sign in', '登录账号')}</a></div>
    </header>
    <nav className="guest-tabs" role="tablist" aria-label={t('Preview sections', '游客体验内容')}>
      {views.map((item, index) => <button ref={element => { tabRefs.current[index] = element; }} key={item} type="button" role="tab" id={`guest-tab-${item}`} aria-selected={view === item} aria-controls="guest-panel" tabIndex={view === item ? 0 : -1} onKeyDown={event => keyboardTab(event, index)} onClick={() => setView(item)}>{copy(labels[item])}</button>)}
    </nav>
    <section className="guest-body" role="tabpanel" id="guest-panel" aria-labelledby={`guest-tab-${view}`}>
      {view === 'overview' && <>
        <section className="guest-hero">
          <div className="guest-hero-copy"><p className="guest-eyebrow">{t('A clearer view of your recordings', '看见记录，理解呼吸变化')}</p><h1>{t('Explore a recording. Follow the explanation.', '从一份记录开始，读懂呼吸变化。')}</h1><p>{t('See how BreathMap connects respiratory metrics, waveforms and AI explanations. Explore a saved example before signing in.', '看看 BreathMap 如何将呼吸指标、波形和 AI 解读联系起来。登录前，先浏览一份已保存的示例。')}</p><div className="guest-actions"><button type="button" className="guest-button" onClick={() => setView('waveform')}>{t('View demo recording', '查看演示记录')}<ArrowRight size={18} aria-hidden="true" /></button><button type="button" className="guest-link-button" onClick={event => requestAction(actions.upload, event)}>{t('Upload my recording', '上传我的记录')}</button></div></div>
          <div className="guest-hero-record"><span className="guest-data-label">{t('Synthetic demo data', '合成演示数据')}</span><h2>{copy(guestDemo.title)}</h2><p>{guestDemo.durationSeconds} {t('seconds · saved analysis', '秒 · 已保存分析')}</p><Waveform channel="magnetic" label={t('Magnetic signal', '磁场信号')} unit="mT" start={range.start} end={range.end} color="#147a72" lang={lang} /><button type="button" className="guest-link-button" onClick={() => setView('explanation')}>{t('Read the example explanation', '阅读示例解读')}<ArrowRight size={17} aria-hidden="true" /></button></div>
        </section>
        <div className="guest-metrics">{metrics.map(metric => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}<small>{metric.unit}</small></strong></div>)}</div>
        <p className="guest-limitation">{copy(guestDemo.summary.note)}</p>
        <section className="guest-next"><div><h2>{t('Your own records, in your own account', '自己的记录，保存在自己的账号')}</h2><p>{t('Explore the example freely. Sign in when you want to upload, save notes or ask a new question.', '可以自由浏览示例。需要上传、保存备注或提出新问题时，再登录账号。')}</p></div><div className="guest-feature-actions"><button type="button" onClick={event => requestAction(actions.history, event)}><FileText aria-hidden="true" />{t('My saved recordings', '我的个人记录')}<LockKeyhole size={15} aria-hidden="true" /></button><button type="button" onClick={event => requestAction(actions.diary, event)}><ClipboardList aria-hidden="true" />{t('My sleep diary', '我的睡眠日记')}<LockKeyhole size={15} aria-hidden="true" /></button></div></section>
      </>}
      {view === 'waveform' && <>
        <div className="guest-section-heading"><div><span className="guest-data-label">{t('Synthetic demo data', '合成演示数据')}</span><h1>{copy(guestDemo.title)}</h1><p>{t('Select an interval and inspect the saved signals. No personal recording is loaded in this preview.', '选择一个区间，查看已保存的信号。此预览不会载入个人记录。')}</p></div><button type="button" className="guest-button guest-button-outline" onClick={event => requestAction(actions.analysis, event)}><Upload size={17} aria-hidden="true" />{t('Analyse my recording', '分析我的记录')}<LockKeyhole size={15} aria-hidden="true" /></button></div>
        <div className="guest-metrics">{metrics.map(metric => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}<small>{metric.unit}</small></strong></div>)}</div><p className="guest-limitation">{copy(guestDemo.summary.note)}</p>
        <div className="guest-wave-workspace"><div className="guest-range-options" aria-label={t('Saved example intervals', '已保存示例区间')}>{guestDemo.intervals.map(interval => <button type="button" key={interval.id} aria-pressed={range.start === interval.start && range.end === interval.end} onClick={() => selectRange(interval.start, interval.end)}>{interval.start}–{interval.end} s <span>{copy(interval.label)}</span></button>)}</div>
          <form className="guest-range-form" onSubmit={event => { event.preventDefault(); loadRange(); }}><label>{t('Start (seconds)', '起点（秒）')}<input type="number" min="0" max={guestDemo.durationSeconds} step="any" value={startDraft} onChange={event => setStartDraft(event.target.value)} /></label><label>{t('End (seconds)', '终点（秒）')}<input type="number" min="0" max={guestDemo.durationSeconds} step="any" value={endDraft} onChange={event => setEndDraft(event.target.value)} /></label><button type="submit" className="guest-button guest-button-outline">{t('View interval', '查看区间')}</button></form>
          {rangeError && <p className="guest-error" role="alert">{t(`Choose an interval between 0 and ${guestDemo.durationSeconds} seconds, with the end after the start.`, `请选择 0 至 ${guestDemo.durationSeconds} 秒内的区间，终点需要晚于起点。`)}</p>}
          <p className="guest-current-range" role="status">{t('Showing', '当前显示')} {range.start}–{range.end} {t('seconds', '秒')}</p>
          <Waveform channel="magnetic" label={t('Magnetic signal', '磁场信号')} unit="mT" start={range.start} end={range.end} color="#147a72" lang={lang} />
          <Waveform channel="flow" label={t('Estimated expiratory flow', '估计呼气流量')} unit="L/min" start={range.start} end={range.end} color="#2d697b" lang={lang} />
          <Waveform channel="sig" label={t('SIG differential voltage', 'SIG 差分电压')} unit="µV" start={range.start} end={range.end} color="#8c7051" lang={lang} />
          <p className="guest-caption">{t('Saved synthetic signals. Gaps remain visible where a value is unavailable; the preview does not run a new analysis.', '已保存的合成信号。没有数值的位置保留为空；此预览不会重新分析数据。')}</p>
          <div className="guest-actions"><button type="button" className="guest-button" onClick={() => setView('explanation')}>{t('Read example AI explanation', '阅读示例 AI 解读')}<ArrowRight size={17} aria-hidden="true" /></button><button type="button" className="guest-link-button" onClick={event => requestAction(actions.chat, event)}>{t('Ask my own question', '提出我的问题')}<LockKeyhole size={15} aria-hidden="true" /></button><button type="button" className="guest-link-button" onClick={event => requestAction(actions.notes, event)}>{t('Save my notes', '保存我的备注')}<LockKeyhole size={15} aria-hidden="true" /></button></div>
        </div>
      </>}
      {view === 'explanation' && <>
        <div className="guest-section-heading"><div><span className="guest-data-label">{t('Saved example · synthetic data', '已保存示例 · 合成数据')}</span><h1>{t('Read an explanation. Check its evidence.', '阅读解释，也查看它的依据。')}</h1><p>{t('This is a saved explanation of the demo recording. Your visit does not send a new AI request.', '这是针对演示记录已保存的解读。浏览示例不会发送新的 AI 请求。')}</p></div></div>
        <div className="guest-explanation-grid"><section className="guest-saved-report"><div className="guest-report-heading"><FileText aria-hidden="true" /><h2>{t('Example analysis explanation', '示例分析解读')}</h2></div>{guestDemo.report.map((claim, index) => <div className="guest-saved-claim" key={index}><p>{copy(claim.text)}</p><button type="button" className="guest-citation" onClick={() => openWaveform(claim.start, claim.end)}>{claim.start}–{claim.end} s · {t('View waveform', '查看波形')}<ArrowRight size={14} aria-hidden="true" /></button></div>)}<p className="guest-caption">{copy(guestDemo.provenance.note)}</p></section>
          <section className="guest-saved-conversation"><div className="guest-report-heading"><MessageCircle aria-hidden="true" /><h2>{t('An example follow-up', '一次示例追问')}</h2></div><p className="guest-message-label">{t('Saved question', '已保存问题')}</p><p className="guest-saved-question">{copy(guestDemo.question)}</p><p className="guest-message-label">{t('Saved AI answer', '已保存 AI 回答')}</p><p>{copy(guestDemo.answer)}</p><button type="button" className="guest-citation" onClick={() => openWaveform(guestDemo.answer.start, guestDemo.answer.end)}>{guestDemo.answer.start}–{guestDemo.answer.end} s · {t('View waveform', '查看波形')}<ArrowRight size={14} aria-hidden="true" /></button><div className="guest-question-gate"><p>{t('Have a question of your own?', '想提出自己的问题？')}</p><button type="button" className="guest-button" onClick={event => requestAction(actions.chat, event)}>{t('Sign in to ask', '登录后提问')}<LockKeyhole size={15} aria-hidden="true" /></button></div></section></div>
      </>}
      {view === 'learn' && <>
        <div className="guest-section-heading"><div><p className="guest-eyebrow">{t('Sleep guide', '睡眠知识')}</p><h1>{t('Make space to understand your sleep.', '从日常观察开始，了解自己的睡眠。')}</h1><p>{t('A few starting points for reflection and conversations about sleep. Explore without an account.', '从几个简单的方向开始观察和讨论睡眠，无需登录即可阅读。')}</p></div><BookOpen size={40} aria-hidden="true" /></div>
        <div className="guest-guide-grid"><article><span className="guest-guide-symbol"><Check aria-hidden="true" /></span><h2>{t('Notice your routine', '留意自己的作息')}</h2><p>{t('Reflect on when you go to bed and wake up, and whether your routine changes from day to day.', '留意上床、起床的时间，以及不同日子里的作息变化。')}</p></article><article><span className="guest-guide-symbol"><ClipboardList aria-hidden="true" /></span><h2>{t('Record your observations', '记录个人感受')}</h2><p>{t('A diary can keep your own observations alongside device recordings. Your impressions and measured signals offer different kinds of information.', '日记可以与设备记录放在一起回顾。个人感受与测量信号提供的是不同类型的信息。')}</p><button type="button" className="guest-link-button" onClick={event => requestAction(actions.diary, event)}>{t('Keep my sleep diary', '记录我的睡眠日记')}<LockKeyhole size={15} aria-hidden="true" /></button></article><article><span className="guest-guide-symbol"><Activity aria-hidden="true" /></span><h2>{t('Read signals with context', '结合背景理解信号')}</h2><p>{t('Review a waveform together with its time interval, recording notes and analysis explanation. A single label or number does not establish a diagnosis.', '结合时间区间、记录备注和分析解读查看波形。单个标签或数值不能确立诊断。')}</p><button type="button" className="guest-link-button" onClick={() => setView('waveform')}>{t('Explore the demo waveform', '查看演示波形')}<ArrowRight size={15} aria-hidden="true" /></button></article><article><span className="guest-guide-symbol"><MessageCircle aria-hidden="true" /></span><h2>{t('Bring questions to a professional', '带着问题与专业人员沟通')}</h2><p>{t('If you are concerned about your sleep or breathing, keep relevant observations and discuss them with a healthcare professional.', '如果你对自己的睡眠或呼吸感到担忧，可以整理相关观察，与医护人员讨论。')}</p><a href="https://www.nhlbi.nih.gov/health/sleep-apnea" target="_blank" rel="noopener noreferrer">{t('Read NHLBI information about sleep apnoea', '阅读 NHLBI 的睡眠呼吸暂停介绍')}<ArrowRight size={15} aria-hidden="true" /></a></article></div>
      </>}
    </section>
    <footer className="guest-footer"><span>BreathMap</span><p>{t('The demo uses synthetic data for understanding and review. It does not replace clinical assessment.', '演示使用合成数据，帮助理解与回顾，不能代替临床评估。')}</p></footer>
    <Dialog open={action !== null} onOpenChange={open => { if (!open) setAction(null); }}><DialogContent className="guest-login-dialog" lang={lang === 'zh' ? 'zh-CN' : 'en'} onCloseAutoFocus={event => { event.preventDefault(); (protectedTrigger.current ?? tabRefs.current[views.indexOf(view)])?.focus(); }}><DialogHeader><span className="guest-login-symbol"><LockKeyhole aria-hidden="true" /></span><DialogTitle>{action ? copy(action.title) : ''}</DialogTitle><DialogDescription>{action ? copy(action.description) : ''}</DialogDescription></DialogHeader><div className="guest-login-actions"><a className="guest-button" href={loginHref(action?.target ?? '/')}>{t('Sign in', '登录账号')}<ArrowRight size={17} aria-hidden="true" /></a><button type="button" className="guest-button guest-button-outline" onClick={() => setAction(null)}>{t('Continue exploring', '继续体验')}</button></div><p className="guest-caption">{t('New registration is temporarily unavailable. You can continue exploring the demo without an account.', '注册暂未开放，你可以继续免登录浏览演示内容。')}</p></DialogContent></Dialog>
  </main>;
}
