import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, FileText, Upload, UserRound, X } from 'lucide-react';
import { useAssistant } from './components/AssistantProvider';
import { useAuth } from './lib/user';
import { requireSupabase } from './lib/supabase';
import { assistantTargetFromUrl } from './lib/assistant-context';
import AssistantView from './components/AssistantView';
import GeneralSleepChat from './components/GeneralSleepChat';
import './assistant.css';

export default function AssistantPage() {
  const assistant = useAssistant();
  const { lang } = assistant;
  const { user } = useAuth();
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  const [recordMode, setRecordMode] = useState(() => !!assistantTargetFromUrl());
  const [adding, setAdding] = useState(() => new URLSearchParams(window.location.search).get('mode') === 'record');
  const [choices, setChoices] = useState<{ id: string; title: string }[]>([]), [pickerError, setPickerError] = useState(false);
  const pickerSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (!adding || !user?.id) return;
    let active = true;
    pickerSelect.current?.focus(); pickerSelect.current?.scrollIntoView?.({ block: 'nearest' });
    setChoices([]); setPickerError(false);
    requireSupabase().from('recordings').select('id,title').eq('user_id', user.id).is('trashed_at', null).order('recorded_at', { ascending: false }).limit(100).then(({ data, error }) => { if (active) { setChoices(data ?? []); setPickerError(!!error); } });
    return () => { active = false; };
  }, [adding, user?.id]);
  function ordinaryChat() {
    assistant.clearRecord(); setRecordMode(false); setAdding(false);
    window.history.replaceState(null, '', '/assistant'); window.dispatchEvent(new Event('breathmap:tool-route-changed'));
  }
  function selectRecord(id: string) {
    if (!id) return;
    assistant.selectRecord({ recordingId: id }); setRecordMode(true); setAdding(false);
    window.history.replaceState(null, '', '/assistant?recordId=' + encodeURIComponent(id)); window.dispatchEvent(new Event('breathmap:tool-route-changed'));
  }
  return <main className="assistant-page assistant-page--conversation" lang={lang === 'zh' ? 'zh-CN' : 'en'}>
    <header className="assistant-page-header"><a href="/" className="auth-brand"><Activity />BreathMap</a><div><button className="assistant-language" onClick={() => { localStorage.setItem('breathmap-language', lang === 'zh' ? 'en' : 'zh'); window.dispatchEvent(new Event('breathmap:language-change')); }}>{lang === 'zh' ? 'English' : '中文'}</button><a className="assistant-account" href="/account" aria-label={t('Account', '账号信息')}><UserRound size={20} /></a></div></header>
    <nav className="assistant-shared-navigation" aria-label={t('Workspace navigation', '工作区导航')}><a href="/">{t('Home', '个人首页')}</a><a href="/recordings">{t('Recordings', '呼吸记录')}</a><a href="/assistant" aria-current="page">{t('AI assistant', 'AI 助手')}</a><a href="/wellbeing?view=diary">{t('Diary & checks', '日记与自测')}</a><a href="/wellbeing?view=routine">{t('Routine & relaxation', '作息与放松')}</a><a href="/wellbeing?view=visits">{t('Visit notes', '就诊资料')}</a><a href="/learn">{t('Sleep guide', '睡眠知识')}</a></nav>
    <div className="assistant-page-intro"><h1>{t('AI assistant', 'AI 助手')}</h1><p>{recordMode ? t('Discuss this recording and follow its analysis back to the evidence.', '讨论这份记录，结合分析结果查看对应依据。') : t('A place to talk about sleep, routines and breathing.', '聊聊睡眠、作息和呼吸。')}</p></div>
    {recordMode && <div className="sleep-chat-mode-bar"><span><FileText size={16} />{t('Recording discussion', '记录讨论')}</span><button type="button" className="assistant-text-action" onClick={ordinaryChat}><ArrowLeft size={15} />{t('Return to sleep conversation', '返回普通睡眠讨论')}</button></div>}
    {adding && <section className="sleep-chat-record-picker" aria-label={t('Add a recording', '添加记录')}><div><h2>{t('Which recording would you like to discuss?', '想讨论哪一份记录？')}</h2><button type="button" className="assistant-icon-action" aria-label={t('Close recording options', '关闭记录选项')} onClick={() => setAdding(false)}><X size={18} /></button></div><label htmlFor="sleep-record-choice">{t('Choose an existing recording', '选择已有记录')}</label><select ref={pickerSelect} id="sleep-record-choice" value="" onChange={event => selectRecord(event.target.value)}><option value="">{t('Choose a recording…', '请选择记录……')}</option>{choices.map(record => <option key={record.id} value={record.id}>{record.title}</option>)}</select>{pickerError && <p role="alert">{t('Recordings could not be loaded. Close and reopen these options to retry.', '暂时无法读取记录，请关闭后重新打开再试。')}</p>}<a href="/upload?returnTo=assistant" className="assistant-secondary"><Upload size={16} />{t('Upload a new recording', '上传新记录')}</a><p>{t('After upload, analysis must finish before AI can explain the results.', '上传完成后，需要等待分析结果，才能让 AI 解读这份记录。')}</p></section>}
    <section className="assistant-workspace" aria-label={recordMode ? t('Recording assistant', '呼吸记录助手') : t('Sleep assistant', '睡眠助手')}>
      {recordMode ? <AssistantView /> : <GeneralSleepChat key={user?.id} onAddRecord={() => setAdding(value => !value)} />}
    </section>
  </main>;
}
