import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronDown, FileText, MessageCircle, Plus, RefreshCw, Send, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/user';
import { formatNumber, requestJob, resultIsCurrent } from '../lib/analysis';
import { useAssistantRecord } from '../lib/use-assistant-record';
import { ASSISTANT_QUESTION_LIMIT, analysisLink, assistantServiceState, assistantUuid, confirmedAssistantContext, currentAssistantJob, evidenceSelection, validSelection } from '../lib/assistant-context';
import { useAssistant } from './AssistantProvider';

function EvidenceAnswer({ answer, result, recordingId, lang, close }: { answer: any; result: any; recordingId: string; lang: 'en' | 'zh'; close: () => void }) {
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  const claims = Array.isArray(answer?.claims) ? answer.claims : [];
  if (!claims.length) return <p>{typeof answer === 'string' ? answer : t('No explanation was saved.', '没有已保存的解读。')}</p>;
  return <>{claims.map((claim: any, index: number) => <div className="assistant-claim" key={index}>
    <p>{typeof claim.text === 'string' ? claim.text : ''}</p>
    <div className="assistant-evidence">{(claim.evidence_ids ?? []).map((id: string) => {
      const selection = evidenceSelection(result, id);
      const href = analysisLink({ recordingId, resultHash: result.result_sha256, ...(selection ? { selection } : {}) });
      return <a key={id} href={href} onClick={event => {
        const query = new URLSearchParams(window.location.search);
        if (selection && window.location.pathname === '/analysis' && query.get('recordId') === recordingId) {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent('breathmap:focus-evidence', { detail: { recordingId, resultHash: result.result_sha256, selection, evidenceId: id } }));
          if (window.innerWidth < 1280) close();
        }
      }}>{selection ? `${formatNumber(selection.start_s)}–${formatNumber(selection.end_s)} s · ${t('View waveform', '查看波形')}` : id === 'SUM' ? t('View recording metrics', '查看记录指标') : `${id} · ${t('View analysis', '查看分析')}`}<ArrowRight size={14} /></a>;
    })}</div>
  </div>)}</>;
}

export default function AssistantView({ mode = 'page' }: { mode?: 'page' | 'drawer' }) {
  const assistant = useAssistant();
  const { user } = useAuth();
  const { lang, target } = assistant;
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  const recordId = target?.recordingId;
  const [recordingChoices, setRecordingChoices] = useState<{ owner?: string; rows: any[] }>({ rows: [] }), [recordLimit, setRecordLimit] = useState(50), [pickerError, setPickerError] = useState(false);
  const recordings = recordingChoices.owner === user?.id ? recordingChoices.rows : [];
  const [jobLimit, setJobLimit] = useState(50), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'chat' | 'report'>('chat');
  const lock = useRef(false), messageEnd = useRef<HTMLDivElement>(null);
  const data = useAssistantRecord(recordId, user?.id, jobLimit);
  const result = data.result;
  const hash = result?.result_sha256;
  const display = resultIsCurrent(result?.display, hash) ? result.display : null;
  const usable = !!display && ['success', 'partial'].includes(display.execution?.status);
  const bindingKey = recordId && hash ? `${recordId}:${hash}` : '';
  const conversation = bindingKey ? assistant.conversations[bindingKey] : '';
  const draftKey = `${bindingKey}:${conversation || 'new'}`;
  const question = assistant.drafts[draftKey]?.question ?? '';
  const selection = !target?.resultHash || target.resultHash === hash ? validSelection(target?.selection, display?.extent?.duration_s) : undefined;
  const selectionKey = JSON.stringify(selection ?? null);
  const jobs = data.jobs.filter(job => recordId && currentAssistantJob(job, recordId, hash));
  const chats = jobs.filter(job => job.operation === 'chat');
  const conversationId = (job: any): string => assistantUuid(job.payload?.assistant_context?.conversation_id) ? job.payload.assistant_context.conversation_id : 'legacy';
  const sessions = [...new Set(chats.map(conversationId))];
  const thread = chats.filter(job => conversationId(job) === conversation).slice().reverse();
  const lastCompleted = thread.filter(job => job.status === 'completed').at(-1);
  const canContinue = conversation !== 'legacy' && (!lastCompleted || confirmedAssistantContext(lastCompleted));
  const previous = canContinue ? lastCompleted : undefined;
  const accepted = Object.values(assistant.acceptedJobs ?? {}).filter(job => job.recordingId === recordId && (!job.resultHash || job.resultHash === hash));
  const pending = [...data.jobs.filter(job => ['queued', 'running'].includes(job.status)), ...accepted.filter(job => !data.jobs.some(saved => saved.id === job.id)).map(job => ({ id: job.id, operation: job.operation, payload: { assistant_context: { conversation_id: job.conversationId } }, status: 'queued' }))];
  const waiting = pending.some(job => job.operation === 'chat' && conversationId(job) === conversation);
  const { online, supportsContext, ready } = assistantServiceState(data.heartbeat);
  const report = display?.report;
  const reportReady = report?.status === 'ready';
  const showSavedOnly = !online;
  useEffect(() => {
    let active = true;
    if (!supabase || !user?.id) return;
    setRecordingChoices({ owner: user.id, rows: [] });
    setPickerError(false);
    supabase.from('recordings').select('id,title,recorded_at,uploaded_at').eq('user_id', user.id).is('trashed_at', null).order('recorded_at', { ascending: false }).limit(recordLimit)
      .then(({ data: rows, error: issue }) => { if (active) { setRecordingChoices({ owner: user.id, rows: rows ?? [] }); setPickerError(!!issue); } });
    return () => { active = false; };
  }, [user?.id, recordLimit]);
  useEffect(() => {
    if (!data.loading && data.record && bindingKey && !conversation) {
      const latest = chats.find(job => assistantUuid(job.payload?.assistant_context?.conversation_id));
      assistant.setConversation(bindingKey, latest ? conversationId(latest) : crypto.randomUUID());
    }
  }, [data.loading, data.record?.id, bindingKey, conversation]);
  useEffect(() => { setError(''); setJobLimit(50); }, [recordId, hash]);
  useEffect(() => {
    for (const job of data.jobs) if (assistant.acceptedJobs?.[job.id] && !['queued', 'running'].includes(job.status)) assistant.forgetJob(job.id);
  }, [data.jobs, assistant.acceptedJobs]);
  useEffect(() => {
    if (recordId && hash && target?.resultHash && target.resultHash !== hash) assistant.selectRecord({ recordingId: recordId, resultHash: hash });
  }, [recordId, hash, target?.resultHash]);
  useEffect(() => {
    if (!bindingKey || !conversation) return;
    const saved = assistant.drafts[draftKey];
    if (JSON.stringify(saved?.selection ?? null) !== selectionKey) assistant.saveDraft(draftKey, { question: saved?.question ?? '', selection });
  }, [draftKey, selectionKey]);
  useEffect(() => { messageEnd.current?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' }); }, [thread.length, thread.at(-1)?.status]);
  const updateQuestion = (value: string) => assistant.saveDraft(draftKey, { question: value, selection });
  function chooseConversation(id: string) {
    if (!bindingKey || !recordId) return;
    assistant.setConversation(bindingKey, id);
    const saved = assistant.drafts[`${bindingKey}:${id}`];
    assistant.selectRecord({ recordingId: recordId, resultHash: hash, ...(saved?.selection ? { selection: saved.selection } : {}) });
    setActiveTab('chat'); setError('');
  }
  async function submit(operation: 'analyse' | 'report' | 'chat') {
    if (!recordId || lock.current || !data.record || data.failed) return;
    if (pending.some(job => job.operation === operation && (operation !== 'chat' || conversationId(job) === conversation))) return;
    if (operation === 'chat' && (!ready || !usable || !canContinue || !assistantUuid(conversation))) return;
    if (operation === 'report' && (!online || !usable)) return;
    if (operation === 'analyse' && !online) return;
    if (operation === 'chat' && (!question.trim() || question.trim().length > ASSISTANT_QUESTION_LIMIT || waiting)) return;
    const submittedKey = draftKey, submittedQuestion = question;
    lock.current = true; setBusy(true); setError('');
    try {
      const payload: Record<string, unknown> = { language: lang, ...(hash ? { result_sha256: hash } : {}) };
      if (operation !== 'analyse') payload.ai_consent = true;
      if (operation === 'chat') {
        payload.question = question.trim();
        payload.assistant_context = { version: 1, conversation_id: conversation,
          ...(selection ? { selection } : {}), ...(previous ? { previous_job_id: previous.id } : {}) };
      }
      const saved = await requestJob(recordId, operation, payload);
      if (assistantUuid(saved?.id)) assistant.rememberJob({ id: saved.id, recordingId: recordId, resultHash: hash, operation, ...(operation === 'chat' ? { conversationId: conversation } : {}) });
      if (operation === 'chat') assistant.saveDraft(submittedKey, { question: '', selection });
      if (operation === 'report') setActiveTab('report');
      await data.refresh();
    } catch {
      // A failed or uncertain request keeps the original draft; requestJob reuses
      // the same idempotency key on retry, including paid AI operations.
      if (operation === 'chat') assistant.saveDraft(submittedKey, { question: submittedQuestion, selection });
      setError(t('Your request could not be confirmed. Your draft is saved; try again.', '暂时无法确认请求是否保存。草稿已保留，请重试。'));
    } finally { lock.current = false; setBusy(false); }
  }
  const submitQuestion = (event: FormEvent) => { event.preventDefault(); void submit('chat'); };
  const dateLabel = (value: string) => new Date(value).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <div className={`assistant-view assistant-view--${mode}`} lang={lang === 'zh' ? 'zh-CN' : 'en'}>
    <details className="assistant-record-picker" open={mode === 'page' || !data.record}><summary>{t('Switch recording', '切换呼吸记录')}</summary><label htmlFor={`assistant-record-${mode}`}>{t('Discuss a recording', '选择要讨论的记录')}</label><div className="assistant-select-wrap"><select id={`assistant-record-${mode}`} value={recordId ?? ''} disabled={busy} onChange={event => { if (event.target.value) assistant.selectRecord({ recordingId: event.target.value }); }}>
      <option value="">{t('Choose a recording', '请选择一条呼吸记录')}</option>
      {recordId && !recordings.some(item => item.id === recordId) && <option value={recordId}>{data.record?.title || t('Selected recording', '当前记录')}</option>}
      {recordings.map(item => <option value={item.id} key={item.id}>{item.title} · {dateLabel(item.recorded_at || item.uploaded_at)}</option>)}
    </select><ChevronDown size={16} aria-hidden="true" /></div>
      {recordings.length === recordLimit && <button className="assistant-text-action" onClick={() => setRecordLimit(value => value + 50)}>{t('Load more recordings', '加载更多记录')}</button>}
      {pickerError && <p role="alert">{t('Recording choices could not be loaded. Reopen the assistant from a saved recording.', '暂时无法加载记录列表，可从已保存的记录中打开助手。')}</p>}
    </details>
    {!recordId ? <div className="assistant-empty"><span className="assistant-empty-icon"><MessageCircle size={28} /></span><h2>{t('Understand your recording, one question at a time.', '从一条记录开始，读懂呼吸变化。')}</h2><p>{t('Choose a recording to read its AI explanation, ask about a waveform, or return to an earlier conversation.', '选择呼吸记录，阅读 AI 解读、询问具体片段，或继续之前的对话。')}</p><div className="assistant-actions"><a className="assistant-primary" href="/upload">{t('Upload a recording', '上传呼吸记录')}<ArrowRight size={16} /></a><a href="/learn">{t('Explore sleep knowledge', '了解睡眠知识')}</a></div></div>
      : data.loading ? <div className="assistant-empty" role="status">{t('Opening your recording…', '正在打开记录…')}</div>
        : !data.record || data.failed ? <div className="assistant-empty"><h2>{t('This recording is unavailable.', '暂时无法打开这条记录。')}</h2><p>{t('Check your connection, or choose another saved recording.', '请检查网络，或选择其他已保存的记录。')}</p><button className="assistant-secondary" onClick={() => void data.refresh()}>{t('Try again', '重新加载')}</button></div>
          : <>
            <div className="assistant-context-bar"><div><span>{t('Current recording', '当前记录')}</span><strong>{data.record.title}</strong><small>{dateLabel(data.record.recorded_at || data.record.uploaded_at)}</small></div><a href={analysisLink({ recordingId: recordId, resultHash: hash, ...(selection ? { selection } : {}) })}>{t('Data analysis', '数据分析')}<ArrowRight size={15} /></a></div>
            {selection && <div className="assistant-selection"><span>{t('Selected interval', '正在讨论的区间')} <strong>{formatNumber(selection.start_s)}–{formatNumber(selection.end_s)} s</strong>{selection.window_id && <small>{selection.window_id}</small>}</span><button type="button" aria-label={t('Remove interval', '移除选中区间')} onClick={() => assistant.selectRecord({ recordingId: recordId, resultHash: hash })}><X size={15} /></button></div>}
            <div className="assistant-service" role="status"><span data-online={online && supportsContext ? 'true' : 'false'} />{showSavedOnly ? t('AI is unavailable right now. Saved explanations and conversations remain readable.', 'AI 服务暂不可用，仍可查看已保存的解读和对话。') : !supportsContext ? t('Saved results are available. Context-aware chat is waiting for the service update.', '已有结果可查看，区间提问与连续对话待服务更新后启用。') : t('Ready to discuss this recording.', '可以开始讨论这条记录。')}</div>
            {!usable && <div className="assistant-empty assistant-empty--compact"><h2>{t('Analyse this recording first.', '先完成这条记录的数据分析。')}</h2><p>{t('Metrics and identified patterns provide the evidence for AI explanations.', '呼吸指标和模式识别结果将作为 AI 解读的依据。')}</p><button className="assistant-primary" disabled={busy || !online || pending.some(job => job.operation === 'analyse')} onClick={() => void submit('analyse')}>{pending.some(job => job.operation === 'analyse') ? t('Analysis requested', '分析请求已保存') : t('Start data analysis', '开始数据分析')}</button></div>}
            {usable && <>
              <div className="assistant-tabs" role="tablist" aria-label={t('AI workspace', 'AI 工作区')}><button role="tab" aria-selected={activeTab === 'chat'} aria-controls={`assistant-chat-${mode}`} id={`assistant-chat-tab-${mode}`} onClick={() => setActiveTab('chat')}><MessageCircle size={16} />{t('Conversation', 'AI 对话')}</button><button role="tab" aria-selected={activeTab === 'report'} aria-controls={`assistant-report-${mode}`} id={`assistant-report-tab-${mode}`} onClick={() => setActiveTab('report')}><FileText size={16} />{t('AI explanation', 'AI 解读')}{reportReady && <Check size={14} />}</button></div>
              {activeTab === 'chat' ? <div className="assistant-conversation" id={`assistant-chat-${mode}`} role="tabpanel" aria-labelledby={`assistant-chat-tab-${mode}`}>
                <div className="assistant-thread-toolbar"><label>{t('Conversation', '对话记录')}<select aria-label={t('Choose conversation', '选择对话')} value={conversation || ''} onChange={event => chooseConversation(event.target.value)}>
                  {!sessions.includes(conversation) && <option value={conversation || ''}>{t('New conversation', '新对话')}</option>}
                  {sessions.map(id => { const first = chats.filter(job => conversationId(job) === id).at(-1); return <option key={id} value={id}>{id === 'legacy' ? t('Earlier questions', '此前问答') : first ? `${dateLabel(first.created_at)} · ${String(first.payload.question).slice(0, 24)}` : t('Conversation', '对话')}</option>; })}
                </select></label><button type="button" className="assistant-icon-action" aria-label={t('New conversation', '新建对话')} onClick={() => chooseConversation(crypto.randomUUID())}><Plus size={18} /></button></div>
                <div className="assistant-messages" role="log" aria-label={t('Conversation messages', '对话消息')} aria-relevant="additions text">
                  {!thread.length && <div className="assistant-welcome"><h2>{selection ? t('What would you like to know about this interval?', '想了解这段呼吸记录的哪些变化？') : t('What would you like to understand?', '想进一步了解这次记录吗？')}</h2><p>{t('Answers use this recording’s saved analysis. References lead back to the corresponding data.', '回答将参考当前记录的分析结果，你可以通过引用返回对应数据。')}</p><div className="assistant-suggestions">{[t('Summarise the main findings in this recording.', '概括这次记录中值得关注的内容。'), selection ? t('Why was this interval flagged?', '为什么这段记录需要关注？') : t('Which intervals should I review?', '哪些时间段需要进一步查看？'), t('Explain the breathing-rate changes.', '解释这次记录中的呼吸频率变化。')].map(text => <button key={text} onClick={() => updateQuestion(text)}>{text}<ArrowRight size={14} /></button>)}</div></div>}
                  {thread.map(job => <article className="assistant-exchange" key={job.id}><div className="assistant-user-message"><span>{t('You', '我')}</span><p>{job.payload.question}</p>{job.payload.assistant_context?.selection && <small>{formatNumber(job.payload.assistant_context.selection.start_s)}–{formatNumber(job.payload.assistant_context.selection.end_s)} s</small>}</div><div className="assistant-answer"><span className="assistant-speaker"><MessageCircle size={15} />{t('BreathMap assistant', 'BreathMap 助手')}</span>{job.status === 'completed' ? <><EvidenceAnswer answer={job.result?.answer} result={result} recordingId={recordId} lang={lang} close={assistant.close} />{job.payload.assistant_context && !confirmedAssistantContext(job) && <p className="assistant-note">{t('The saved response does not confirm use of the selected interval or conversation context.', '这条已保存回答未确认使用所选区间或对话上下文。')}</p>}{job.result?.assistant_context?.history_excerpted && <p className="assistant-note">{t('This response used excerpts from up to two previous turns. Earlier messages remain available here.', '本次回答参考了最近至多两轮对话的节选，较早消息仍可在此查阅。')}</p>}</> : <p role="status">{job.status === 'queued' ? online ? t('Your question is queued.', '问题已排队。') : t('Your question is saved and waiting for the service.', '问题已保存，等待服务恢复。') : job.status === 'running' ? t('Preparing an answer…', '正在生成回答…') : t('No answer was saved. Your earlier conversation is still available.', '本次回答未能保存，之前的对话仍可查看。')}</p>}</div></article>)}<div ref={messageEnd} />
                </div>
                {!canContinue && <p className="assistant-note">{t('This saved conversation has no confirmed shared context. Start a new conversation to ask follow-up questions.', '这段历史未确认使用统一的对话上下文。请新建对话后连续提问。')}</p>}
                <form className="assistant-composer" onSubmit={submitQuestion}>
                  <label className="assistant-input-label" htmlFor={`assistant-question-${mode}`}>{t('Ask about this recording', '询问这条记录')}</label>
                  <textarea id={`assistant-question-${mode}`} value={question} maxLength={ASSISTANT_QUESTION_LIMIT} rows={2} placeholder={selection ? t('Ask about the selected interval…', '询问当前选中的片段…') : t('Ask about the report or a breathing metric…', '询问报告内容或某项呼吸指标…')} disabled={busy || !canContinue || !conversation} onChange={event => updateQuestion(event.target.value)} />
                  <div className="assistant-compose-actions">
                    <small>{question.length} / {ASSISTANT_QUESTION_LIMIT}</small>
                    <button className="assistant-primary" type="submit" disabled={busy || waiting || !ready || !canContinue || !question.trim() || !assistantUuid(conversation)}>
                      <Send size={16} />{waiting ? t('Waiting for answer', '等待回答') : t('Send to DeepSeek', '发送给 DeepSeek')}
                    </button>
                  </div>
                </form>
              </div> : <div id={`assistant-report-${mode}`} role="tabpanel" aria-labelledby={`assistant-report-tab-${mode}`} className="assistant-report">
                <div className="assistant-report-heading"><div><h2>{t('Your recording explained', '本次记录解读')}</h2><p>{t('A readable report, grounded in the saved analysis.', '结合已保存的分析结果，理解这次呼吸记录。')}</p></div></div>
                {reportReady ? <>
                  <p className="assistant-note">{['offline_stub', 'simulated'].includes(report.source) ? t('Simulated explanation', '模拟解读') : ['deepseek', 'live'].includes(report.source) ? 'DeepSeek' : t('Saved explanation · source not verified', '已保存解读 · 来源未核实')}</p>
                  <EvidenceAnswer answer={report} result={result} recordingId={recordId} lang={lang} close={assistant.close} />
                  <details>
                    <summary>{t('Update this explanation', '更新这份解读')}</summary>
                    <p className="assistant-note">{t('Regeneration uses the current saved analysis and starts a new AI request.', '重新生成将使用当前分析结果，发起一次新的 AI 请求。')}</p>
                    <button type="button" className="assistant-secondary" disabled={busy || !online || pending.some(job => job.operation === 'report')} onClick={() => void submit('report')}>
                      {t('Regenerate with DeepSeek', '用 DeepSeek 重新生成')}
                    </button>
                  </details>
                </> : <div className="assistant-empty assistant-empty--compact">
                  <FileText size={25} />
                  <p>{t('No explanation has been saved yet. Your numerical results remain available.', '尚无已保存的解读，已有数值结果仍可查看。')}</p>
                  <button type="button" className="assistant-primary" disabled={busy || !online || pending.some(job => job.operation === 'report')} onClick={() => void submit('report')}>
                    {pending.some(job => job.operation === 'report') ? t('Explanation requested', '解读请求已保存') : t('Generate with DeepSeek', '用 DeepSeek 生成解读')}
                  </button>
                </div>}
              </div>}
            </>}
            {error && <p className="assistant-error" role="alert">{error}</p>}
            <div className="assistant-bottom-actions"><button className="assistant-text-action" onClick={() => void data.refresh()} disabled={busy}><RefreshCw size={14} />{t('Refresh', '刷新')}</button>{data.jobs.length === jobLimit && <button className="assistant-text-action" onClick={() => setJobLimit(value => value + 50)}>{t('Load earlier activity', '加载更早记录')}</button>}</div>
          </>}
  </div>;
}
