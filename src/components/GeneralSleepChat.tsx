import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, MessageCircle, Plus, RefreshCw, Send } from 'lucide-react';
import { useAuth } from '../lib/user';
import { useAssistant } from './AssistantProvider';
import { loadSleepConversations, loadSleepTurns, sendSleepQuestion, sleepChatError, type SleepConversation, type SleepTurn } from '../lib/sleep-chat';

type Pending = { id: string; question: string; language: 'en' | 'zh' };
const pendingPrefix = 'breathmap:general-pending:v1:';
function readPending(userId: string | undefined, conversation: string): Pending | null {
  try { const value = JSON.parse(sessionStorage.getItem(pendingPrefix + userId) || '{}')[conversation]; return typeof value?.id === 'string' && typeof value?.question === 'string' && ['en', 'zh'].includes(value?.language) ? value : null; } catch { return null; }
}
function storePending(userId: string, conversation: string, pending: Pending | null) {
  try { const values = JSON.parse(sessionStorage.getItem(pendingPrefix + userId) || '{}'); if (pending) values[conversation] = pending; else delete values[conversation]; sessionStorage.setItem(pendingPrefix + userId, JSON.stringify(values)); } catch { /* The active request remains in memory. */ }
}
export default function GeneralSleepChat({ mode = 'page', onAddRecord }: { mode?: 'page' | 'drawer'; onAddRecord?: () => void }) {
  const { user } = useAuth();
  const assistant = useAssistant();
  const { lang } = assistant;
  const userId = user?.id;
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  const conversation = assistant.conversations.general || '';
  const draftKey = `general:${conversation}`;
  const question = assistant.drafts[draftKey]?.question ?? '';
  const [saved, setSaved] = useState<{ owner?: string; conversations: SleepConversation[]; conversation: string; turns: SleepTurn[] }>({ conversations: [], conversation: '', turns: [] });
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(false), [error, setError] = useState('');
  const [consentFor, setConsentFor] = useState(''), [busy, setBusy] = useState(false), [pendingState, setPendingState] = useState<{ owner?: string; conversation: string; request: Pending | null }>({ conversation: '', request: null }), [unknown, setUnknown] = useState(false);
  const consent = consentFor === `${userId}:${conversation}`;
  const setConsent = (value: boolean) => setConsentFor(value ? `${userId}:${conversation}` : '');
  const pending = pendingState.owner === userId && pendingState.conversation === conversation ? pendingState.request : null;
  const setPending = (request: Pending | null) => setPendingState({ owner: userId, conversation, request });
  const [refresh, setRefresh] = useState(0);
  const lock = useRef(false), current = useRef({ userId, conversation }), end = useRef<HTMLDivElement>(null), mounted = useRef(true);
  current.current = { userId, conversation };
  const conversations = saved.owner === userId ? saved.conversations : [];
  const turns = saved.owner === userId && saved.conversation === conversation ? saved.turns : [];
  const validOwner = (owner: string, id: string) => mounted.current && current.current.userId === owner && current.current.conversation === id;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (userId && !conversation) assistant.setConversation('general', crypto.randomUUID()); }, [userId, conversation]);
  useEffect(() => { setConsent(false); setError(''); setUnknown(false); setBusy(false); lock.current = false; setPending(readPending(userId, conversation)); }, [userId, conversation]);
  useEffect(() => {
    let active = true;
    if (!userId || !conversation) return;
    const owner = userId, id = conversation;
    setLoading(true); setLoadError(false);
    Promise.all([loadSleepConversations(), loadSleepTurns(id)]).then(([items, messages]) => {
      if (!active || !validOwner(owner, id)) return;
      setSaved({ owner, conversations: items, conversation: id, turns: messages }); setLoading(false);
      const waiting = readPending(owner, id);
      const completed = waiting && messages.find(turn => turn.id === waiting.id && turn.status !== 'pending');
      if (completed) {
        storePending(owner, id, null); setPending(null); setUnknown(false);
        if (completed.status === 'completed') assistant.saveDraft(`general:${id}`, { question: '' });
        else setError(sleepChatError(completed.error_code ?? undefined, lang));
      } else if (!waiting) {
        const cloudPending = messages.find(turn => turn.status === 'pending');
        if (cloudPending) {
          const restored = { id: cloudPending.id, question: cloudPending.question, language: cloudPending.language };
          storePending(owner, id, restored); setPending(restored);
        }
      }
    }).catch(() => { if (active && validOwner(owner, id)) { setLoading(false); setLoadError(true); } });
    return () => { active = false; };
  }, [userId, conversation, refresh]);
  useEffect(() => { if (!pending) return; const timer = window.setInterval(() => setRefresh(value => value + 1), 3500); return () => window.clearInterval(timer); }, [pending?.id]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' }); }, [turns.length, turns.at(-1)?.status]);
  const updateQuestion = (value: string) => assistant.saveDraft(draftKey, { question: value });
  function choose(id: string) { if (!busy && !pending) assistant.setConversation('general', id); }
  async function send(event: FormEvent, checkExisting = false) {
    event.preventDefault();
    const message = checkExisting && pending ? pending.question : question.trim();
    if (!userId || !conversation || lock.current || !consent || (!checkExisting && pending) || !message || message.length > 800) return;
    const owner = userId, id = conversation;
    const request = checkExisting && pending ? pending : { id: crypto.randomUUID(), question: question.trim(), language: lang };
    lock.current = true; setBusy(true); setError(''); setUnknown(false); setPending(request); storePending(owner, id, request);
    try {
      const response = await sendSleepQuestion({ conversation_id: id, request_id: request.id, message: request.question, language: request.language, ai_consent: true }, owner);
      if (!validOwner(owner, id)) return;
      if (response.status === 'completed') { storePending(owner, id, null); setPending(null); updateQuestion(''); }
      else if (response.status === 'failed') { storePending(owner, id, null); setPending(null); setError(sleepChatError(response.error, lang)); }
      setRefresh(value => value + 1);
    } catch {
      if (validOwner(owner, id)) { setUnknown(true); setError(t('The connection ended before the reply was confirmed. Check the same request below; it will not send a duplicate question.', '连接在确认回复前中断。可检查下方同一请求，系统不会重复发送问题。')); }
    } finally { if (validOwner(owner, id)) { lock.current = false; setBusy(false); } }
  }
  const pendingTurn = pending && !turns.some(turn => turn.id === pending.id) ? pending : null;
  return <section className={`assistant-view assistant-view--${mode} sleep-chat`} aria-label={t('Sleep conversation', '睡眠对话')}>
    <div className="sleep-chat-toolbar"><label>{t('Conversation', '对话')}<select value={conversations.some(item => item.id === conversation) ? conversation : ''} disabled={busy || !!pending} onChange={event => choose(event.target.value || crypto.randomUUID())}><option value="">{t('New conversation', '新对话')}</option>{conversations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button type="button" className="assistant-secondary" disabled={busy || !!pending} onClick={() => choose(crypto.randomUUID())}><Plus size={16} />{t('New chat', '新建对话')}</button></div>
    {loadError && <div className="sleep-chat-history-error"><p role="alert">{t('Conversation history could not be loaded. Refresh it before continuing.', '暂时无法读取对话记录，请刷新后继续。')}</p><button type="button" className="assistant-text-action" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} />{t('Refresh history', '刷新对话')}</button></div>}
    <div className="sleep-chat-messages" role="log" aria-label={t('Messages', '对话内容')} aria-live="polite" aria-busy={loading}>
      {!turns.length && !pending && <div className="sleep-chat-welcome"><MessageCircle size={25} /><h2>{t('What would you like to talk about?', '今天想聊些什么？')}</h2><p>{t('Talk about sleep, routines and breathing, or add a recording when you want to explore your results.', '可以聊聊睡眠、作息和呼吸，也可以添加记录，一起看看分析结果。')}</p><div className="assistant-suggestions">{[t('Why do I still feel tired after sleeping?', '为什么睡醒后还是很累？'), t('Help me think through my recent sleep difficulties.', '帮我梳理最近的睡眠问题。')].map(suggestion => <button key={suggestion} type="button" onClick={() => updateQuestion(suggestion)}>{suggestion}<ArrowRight size={15} /></button>)}</div></div>}
      {turns.map(turn => <article key={turn.id} className="assistant-exchange"><div className="assistant-user-message"><span>{t('You', '你')}</span><p>{turn.question}</p></div><div className="assistant-answer"><span className="assistant-speaker"><MessageCircle size={16} />BreathMap</span>{turn.status === 'completed' && turn.answer ? <p className="sleep-chat-answer">{turn.answer}</p> : <p className="assistant-note" role={turn.status === 'pending' ? 'status' : undefined}>{turn.status === 'pending' ? t('Preparing a reply…', '正在生成回复……') : sleepChatError(turn.error_code ?? undefined, lang)}</p>}</div></article>)}
      {pendingTurn && <article className="assistant-exchange"><div className="assistant-user-message"><span>{t('You', '你')}</span><p>{pendingTurn.question}</p></div><p className="assistant-note" role="status">{unknown ? t('Checking whether your reply was saved.', '正在确认回复是否已保存。') : t('Preparing a reply…', '正在生成回复……')}</p></article>}
      <div ref={end} />
    </div>
    <form className="sleep-chat-composer" onSubmit={event => void send(event)}>
      {onAddRecord && <button type="button" className="assistant-text-action sleep-chat-add-record" onClick={onAddRecord}><Plus size={16} />{t('Add a recording', '添加记录')}</button>}
      <label className="assistant-input-label" htmlFor={`sleep-question-${mode}`}>{t('Ask about sleep', '输入你的睡眠问题')}</label><textarea id={`sleep-question-${mode}`} value={pending?.question ?? question} maxLength={800} rows={3} disabled={busy || !!pending} onChange={event => updateQuestion(event.target.value)} placeholder={t('What has been on your mind about sleep?', '关于睡眠，你最近有什么困惑？')} />
      <label className="assistant-consent sleep-chat-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>{t('Allow DeepSeek to use my question and this conversation to reply. Recordings, files and diary entries are not included.', '允许 DeepSeek 使用本次问题和这段对话生成回复，不会自动读取呼吸记录、文件或日记。')}</span></label>
      {error && <p className="assistant-error" role="alert">{error}</p>}
      <div className="assistant-compose-actions"><small>{question.length} / 800</small>{pending ? <button type="button" className="assistant-secondary" disabled={busy || !consent} onClick={event => void send(event as unknown as FormEvent, true)}><RefreshCw size={16} />{t('Check reply', '检查回复')}</button> : <button type="submit" className="assistant-primary" disabled={!consent || !question.trim() || busy || loading || loadError}><Send size={16} />{t('Send', '发送')}</button>}</div>
      <p className="sleep-chat-footnote">{t('Sleep information and reflection support. AI replies can be mistaken and do not provide a diagnosis.', '用于睡眠信息交流与梳理。AI 回复可能有误，不能作为诊断。')}</p>
    </form>
  </section>;
}
