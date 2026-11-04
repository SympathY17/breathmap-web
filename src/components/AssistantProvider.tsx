import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../lib/user';
import { assistantHash, assistantTargetFromUrl, assistantUuid, validSelection, type AssistantTarget } from '../lib/assistant-context';

type Draft = { question: string; selection?: AssistantTarget['selection'] };
type AcceptedJob = { id: string; recordingId: string; resultHash?: string; operation: string; conversationId?: string };
type Workspace = { target?: AssistantTarget; conversations: Record<string, string>; drafts: Record<string, Draft>; acceptedJobs: Record<string, AcceptedJob> };
type AssistantState = Workspace & {
  open: boolean; lang: 'en' | 'zh';
  show: (target?: AssistantTarget) => void; close: () => void;
  selectRecord: (target: AssistantTarget) => void;
  clearRecord: () => void;
  setConversation: (key: string, id: string) => void;
  saveDraft: (key: string, draft: Draft) => void;
  rememberJob: (job: AcceptedJob) => void; forgetJob: (id: string) => void;
};
const blank = (): Workspace => ({ conversations: {}, drafts: {}, acceptedJobs: {} });
const readLanguage = () => { try { return localStorage.getItem('breathmap-language') === 'en' ? 'en' as const : 'zh' as const; } catch { return 'zh' as const; } };
const Context = createContext<AssistantState>({ ...blank(), open: false, lang: 'zh', show: () => {}, close: () => {}, selectRecord: () => {}, clearRecord: () => {}, setConversation: () => {}, saveDraft: () => {}, rememberJob: () => {}, forgetJob: () => {} });
const prefix = 'breathmap:assistant:v1:';

function restore(userId?: string): Workspace {
  if (!userId) return blank();
  try {
    const saved = JSON.parse(sessionStorage.getItem(prefix + userId) || 'null');
    if (!saved || saved.owner !== userId) return blank();
    const value = blank();
    if (assistantUuid(saved.target?.recordingId)) value.target = {
      recordingId: saved.target.recordingId,
      ...(assistantHash(saved.target.resultHash) ? { resultHash: saved.target.resultHash } : {}),
      ...(validSelection(saved.target.selection) ? { selection: validSelection(saved.target.selection) } : {}),
    };
    for (const [key, id] of Object.entries(saved.conversations ?? {}).slice(-30)) if (assistantUuid(id) || id === 'legacy') value.conversations[key] = id as string;
    for (const [key, raw] of Object.entries(saved.drafts ?? {}).slice(-30)) {
      const draft = raw as Draft;
      if (typeof draft?.question === 'string') value.drafts[key] = { question: draft.question.slice(0, 800), ...(validSelection(draft.selection) ? { selection: validSelection(draft.selection) } : {}) };
    }
    for (const [key, raw] of Object.entries(saved.acceptedJobs ?? {}).slice(-30)) {
      const job = raw as AcceptedJob;
      if (key === job?.id && assistantUuid(key) && assistantUuid(job.recordingId) && ['analyse', 'report', 'chat'].includes(job.operation)) value.acceptedJobs[key] = job;
    }
    return value;
  } catch { return blank(); }
}

function initialWorkspace(userId?: string): Workspace {
  const saved = restore(userId), target = assistantTargetFromUrl();
  if (!target) return saved;
  const sameResult = saved.target?.recordingId === target.recordingId && (!target.resultHash || target.resultHash === saved.target.resultHash);
  return { ...saved, target: sameResult ? { ...saved.target, ...target } : target };
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const userId = user?.id;
  const [owner, setOwner] = useState(userId);
  const [workspace, setWorkspace] = useState<Workspace>(() => initialWorkspace(userId));
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState(readLanguage);
  const ownerRef = useRef(userId);
  const currentUserRef = useRef(userId), mounted = useRef(true);
  currentUserRef.current = userId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const canWrite = () => !!userId && mounted.current && currentUserRef.current === userId && ownerRef.current === userId;
  const updateWorkspace = (change: (current: Workspace) => Workspace) => {
    if (!canWrite()) return;
    setWorkspace(current => canWrite() ? change(current) : current);
  };
  useEffect(() => {
    if (loading) return;
    if (ownerRef.current && ownerRef.current !== userId) { try { sessionStorage.removeItem(prefix + ownerRef.current); } catch { /* Session-only memory remains isolated. */ } }
    if (ownerRef.current !== userId) { ownerRef.current = userId; setOwner(userId); setWorkspace(userId ? initialWorkspace(userId) : blank()); setOpen(false); }
  }, [userId, loading]);
  useEffect(() => {
    if (userId && userId === owner) { try { sessionStorage.setItem(prefix + userId, JSON.stringify({ owner: userId, ...workspace })); } catch { /* Drafts still survive closing the panel in this page. */ } }
  }, [workspace, userId, owner]);
  useEffect(() => {
    const update = () => setLang(readLanguage());
    const observer = new MutationObserver(update);
    const root = document.getElementById('root');
    if (root) observer.observe(root, { attributes: true, attributeFilter: ['lang'], childList: true, subtree: true });
    window.addEventListener('storage', update); window.addEventListener('breathmap:language-change', update);
    return () => { observer.disconnect(); window.removeEventListener('storage', update); window.removeEventListener('breathmap:language-change', update); };
  }, []);
  const selectRecord = (target: AssistantTarget) => {
    if (!assistantUuid(target.recordingId)) return;
    updateWorkspace(current => ({ ...current, target: { recordingId: target.recordingId, ...(assistantHash(target.resultHash) ? { resultHash: target.resultHash } : {}), ...(validSelection(target.selection) ? { selection: validSelection(target.selection) } : {}) } }));
  };
  const value: AssistantState = {
    ...(owner === userId ? workspace : blank()), open: owner === userId && !!userId && open, lang,
    selectRecord,
    clearRecord: () => updateWorkspace(current => ({ ...current, target: undefined })),
    show: target => {
      if (!canWrite()) return;
      const path = window.location.pathname.replace(/\/$/, '') || '/';
      const next = target || (['/analysis', '/report', '/assistant'].includes(path) ? assistantTargetFromUrl() : undefined);
      if (next) { if (target || next.recordingId !== workspace.target?.recordingId) selectRecord(next); }
      else updateWorkspace(current => ({ ...current, target: undefined }));
      setOpen(true);
    },
    close: () => { if (canWrite()) setOpen(false); },
    setConversation: (key, id) => updateWorkspace(current => ({ ...current, conversations: { ...current.conversations, [key]: id } })),
    saveDraft: (key, draft) => updateWorkspace(current => ({ ...current, drafts: { ...current.drafts, [key]: draft } })),
    rememberJob: job => updateWorkspace(current => ({ ...current, acceptedJobs: { ...current.acceptedJobs, [job.id]: job } })),
    forgetJob: id => updateWorkspace(current => { const next = { ...current.acceptedJobs }; delete next[id]; return { ...current, acceptedJobs: next }; }),
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useAssistant = () => useContext(Context);
