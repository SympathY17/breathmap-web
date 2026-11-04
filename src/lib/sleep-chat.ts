import { requireSupabase } from './supabase';

export type SleepConversation = { id: string; title: string; created_at: string; updated_at: string };
export type SleepTurn = { id: string; conversation_id: string; question: string; answer: string | null; status: 'pending' | 'completed' | 'failed'; language: 'en' | 'zh'; error_code: string | null; created_at: string };
export type SleepChatReply = { conversation_id: string; request_id: string; status: 'completed' | 'pending' | 'failed'; answer?: string; error?: string };
export async function loadSleepConversations() {
  const result = await requireSupabase().from('sleep_chat_conversations').select('id,title,created_at,updated_at').order('updated_at', { ascending: false }).limit(50);
  if (result.error) throw result.error;
  return (result.data ?? []) as SleepConversation[];
}
export async function loadSleepTurns(conversationId: string) {
  const result = await requireSupabase().from('sleep_chat_messages').select('id,conversation_id,question,answer,status,language,error_code,created_at').eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(50);
  if (result.error) throw result.error;
  return ((result.data ?? []) as SleepTurn[]).reverse();
}
export async function sendSleepQuestion(input: { conversation_id: string; request_id: string; message: string; language: 'en' | 'zh'; ai_consent: true }, expectedUserId: string): Promise<SleepChatReply> {
  const { data, error } = await requireSupabase().auth.getSession();
  if (error || !data.session?.access_token || !expectedUserId || data.session.user?.id !== expectedUserId) return { conversation_id: input.conversation_id, request_id: input.request_id, status: 'failed', error: 'AUTH_REQUIRED' };
  const response = await fetch('/.netlify/functions/sleep-chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify(input) });
  const value = await response.json().catch(() => null);
  if (!value || !['completed', 'pending', 'failed'].includes(value.status) || value.conversation_id !== input.conversation_id || value.request_id !== input.request_id) throw new Error('UNCONFIRMED_RESPONSE');
  return value as SleepChatReply;
}
export function sleepChatError(code: string | undefined, lang: 'en' | 'zh') {
  const messages: Record<string, [string, string]> = {
    AUTH_REQUIRED: ['Please sign in again before sending a question.', '请重新登录后再发送问题。'],
    RATE_LIMITED: ['You have sent several questions recently. Wait a little before trying again.', '最近发送的问题较多，请稍后再试。'],
    CONVERSATION_BUSY: ['A reply is still being prepared in this conversation.', '这段对话还有一条回复正在生成。'],
    AI_UNAVAILABLE: ['The sleep assistant is temporarily unavailable. Your question is still here.', '睡眠助手暂时无法回复，你的问题已保留。'],
    AI_TIMEOUT: ['The reply took too long. You can choose to try again.', '本次回复超时，你可以主动重试。'],
    AI_INVALID_RESPONSE: ['The reply could not be read. You can choose to try again.', '本次回复无法读取，你可以主动重试。'],
    REQUEST_ID_CONFLICT: ['This request could not be matched. Refresh the conversation before sending again.', '本次请求无法匹配，请刷新对话后再发送。'],
    INVALID_REQUEST: ['Check that your question contains 1–800 characters and allow AI processing.', '请确认问题为 1–800 字，并同意 AI 处理本次对话。'],
    SERVICE_UNAVAILABLE: ['The sleep assistant is temporarily unavailable. Try again later.', '睡眠助手暂时不可用，请稍后再试。'],
  };
  const pair = messages[code ?? ''] ?? messages.SERVICE_UNAVAILABLE;
  return pair[lang === 'zh' ? 1 : 0];
}
