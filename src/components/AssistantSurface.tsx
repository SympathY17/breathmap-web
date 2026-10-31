import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight, MessageCircle, X } from 'lucide-react';
import { useAuth } from '../lib/user';
import { analysisLink } from '../lib/assistant-context';
import { useAssistant } from './AssistantProvider';
import AssistantView from './AssistantView';
import '../assistant.css';

export default function AssistantSurface() {
  const { user, loading } = useAuth();
  const assistant = useAssistant();
  const trigger = useRef<HTMLButtonElement>(null);
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 80rem)').matches);
  const t = (en: string, zh: string) => assistant.lang === 'zh' ? zh : en;
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const hidden = loading || !user || ['/assistant', '/login', '/sign-up', '/forgot-password', '/reset-password'].includes(path);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 80rem)');
    const change = () => setWide(query.matches);
    query.addEventListener('change', change); return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.assistantOpen = !hidden && assistant.open && wide ? 'true' : 'false';
    return () => { delete document.documentElement.dataset.assistantOpen; };
  }, [assistant.open, hidden, wide]);
  if (hidden) return null;
  const fullHref = assistant.target ? analysisLink(assistant.target).replace('/analysis?', '/assistant?').split('#')[0] : '/assistant';
  return <>
    {!assistant.open && <button ref={trigger} className="assistant-launcher" onClick={() => assistant.show()} aria-haspopup="dialog" aria-expanded={false} aria-controls="assistant-drawer"><MessageCircle size={20} /><span>{t('AI assistant', 'AI 助手')}</span></button>}
    <Dialog.Root open={assistant.open} onOpenChange={open => { if (!open) assistant.close(); }} modal={!wide}>
      <Dialog.Portal>
        {!wide && <Dialog.Overlay className="assistant-scrim" />}
        <Dialog.Content id="assistant-drawer" className="assistant-drawer" data-assistant-drawer="true" lang={assistant.lang === 'zh' ? 'zh-CN' : 'en'} onInteractOutside={event => { if (wide) event.preventDefault(); }} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
          <header className="assistant-drawer-heading"><div><Dialog.Title><MessageCircle size={19} />{t('AI assistant', 'AI 助手')}</Dialog.Title><Dialog.Description>{t('Your recording, with context.', '带着记录和区间，继续提问。')}</Dialog.Description></div><div><a href={fullHref} aria-label={t('Open full AI workspace', '打开完整 AI 工作区')}><ArrowUpRight size={19} /></a><Dialog.Close aria-label={t('Close AI assistant', '关闭 AI 助手')}><X size={20} /></Dialog.Close></div></header>
          <AssistantView mode="drawer" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
