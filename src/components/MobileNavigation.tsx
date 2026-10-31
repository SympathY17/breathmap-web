import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Activity, BookOpen, CalendarDays, ChartNoAxesCombined, ClipboardList, FileHeart, House, List, MessagesSquare, Moon, Settings2, ShieldCheck, Timer, Trash2, Upload, UserRound, Zap } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { useAuth } from '../lib/user';

function currentLocation() { return window.location.pathname + window.location.search; }
function readLanguage() { try { return localStorage.getItem('breathmap-language') === 'en' ? 'en' : 'zh'; } catch { return 'zh'; } }

/** Navigation only: the existing pages still own authentication, edits and analysis. */
export default function MobileNavigation() {
  const { user, loading } = useAuth();
  const [location, setLocation] = useState(currentLocation);
  const [lang, setLang] = useState(readLanguage);
  const [open, setOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  useEffect(() => {
    const update = () => { setLocation(currentLocation()); setLang(readLanguage()); };
    const observer = new MutationObserver(update);
    const root = document.getElementById('root');
    if (root) observer.observe(root, { attributes: true, attributeFilter: ['lang'], childList: true, subtree: true });
    window.addEventListener('breathmap:tool-route-changed', update);
    window.addEventListener('storage', update);
    window.addEventListener('popstate', update);
    const media = window.matchMedia('(min-width: 48rem)');
    const closeOnWideScreen = () => { if (media.matches) setOpen(false); };
    media.addEventListener('change', closeOnWideScreen);
    return () => {
      observer.disconnect();
      window.removeEventListener('breathmap:tool-route-changed', update);
      window.removeEventListener('storage', update);
      window.removeEventListener('popstate', update);
      media.removeEventListener('change', closeOnWideScreen);
    };
  }, []);
  const url = new URL(location, window.location.origin);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const view = url.searchParams.get('view') || 'diary';
  const nativeAuth = ['/login', '/sign-up', '/forgot-password', '/reset-password'].includes(path);
  if (!user || loading || nativeAuth) return null;
  const toolUrl = (next: string) => {
    const query = new URLSearchParams({ view: next });
    for (const key of ['ctxDate', 'ctxRecord', 'ctxPlan']) {
      const value = url.searchParams.get(key);
      if (value) query.set(key, value);
    }
    return '/wellbeing?' + query;
  };
  const active = path === '/' ? 'home' : path === '/learn' ? 'learn'
    : path === '/wellbeing' ? ['diary', 'reaction'].includes(view) ? 'daily' : ['monitoring', 'trends'].includes(view) ? 'recordings' : 'more'
    : ['/recordings', '/upload', '/report', '/analysis', '/trash'].includes(path) ? 'recordings' : 'more';
  const assistantQuery = new URLSearchParams();
  const assistantRecord = url.searchParams.get('recordId') || url.searchParams.get('record') || url.searchParams.get('ctxRecord');
  if (assistantRecord) assistantQuery.set('recordId', assistantRecord);
  const assistantDate = url.searchParams.get('ctxDate');
  if (assistantDate) assistantQuery.set('ctxDate', assistantDate);
  const assistantHref = '/assistant' + (assistantQuery.size ? '?' + assistantQuery : '');
  function navigateTool(event: MouseEvent<HTMLAnchorElement>, next: string) {
    setOpen(false);
    if (path === '/wellbeing' && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('breathmap:tool-select', { detail: { view: next, context: { date: url.searchParams.get('ctxDate') || undefined, recordingId: url.searchParams.get('ctxRecord') || undefined } } }));
    }
  }
  function navigatePage(event: MouseEvent<HTMLAnchorElement>, href: string) {
    setOpen(false);
    const page = ({ '/': 'home', '/recordings': 'recordings', '/upload': 'upload', '/learn': 'learn', '/assistant': 'assistant' } as Record<string, string>)[new URL(href, window.location.origin).pathname];
    if (path === '/wellbeing' && page && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('breathmap:tool-select', { detail: { page } }));
    }
  }
  const sections = [
    { title: t('Respiratory recordings', '呼吸记录'), links: [
      { href: assistantHref, icon: MessagesSquare, label: t('AI assistant', 'AI 助手') },
      { href: '/upload', icon: Upload, label: t('Upload', '上传记录') },
      { href: '/recordings', icon: Activity, label: t('History', '历史记录') },
      { view: 'monitoring', icon: CalendarDays, label: t('Recording plan', '采集计划') },
      { view: 'trends', icon: ChartNoAxesCombined, label: t('Compare records', '趋势与对比') },
    ] },
    { title: t('Your daily sleep', '日常睡眠'), links: [
      { view: 'diary', icon: ClipboardList, label: t('Sleep diary', '睡眠日记') },
      { view: 'reaction', icon: Zap, label: t('Reaction test', '反应自测') },
      { view: 'routine', icon: Moon, label: t('Sleep routine', '作息计划') },
      { view: 'relax', icon: Timer, label: t('Wind down', '睡前放松') },
      { view: 'visits', icon: FileHeart, label: t('Visit notes', '就诊资料') },
    ] },
    { title: t('Your account', '个人账号'), links: [
      { href: '/account', icon: UserRound, label: t('Account', '账号信息') },
      { href: '/security', icon: ShieldCheck, label: t('Security', '安全中心') },
      { href: '/preferences', icon: Settings2, label: t('Preferences', '设置') },
      { href: '/trash', icon: Trash2, label: t('Recycle bin', '回收站') },
    ] },
  ];
  return <>
    <nav className="mobile-navigation" aria-label={t('Mobile navigation', '移动端导航')}>
      <a href="/" onClick={event => navigatePage(event, '/')} aria-current={active === 'home' ? 'page' : undefined}><House aria-hidden="true" /><span>{t('Home', '首页')}</span></a>
      <a href="/recordings" onClick={event => navigatePage(event, '/recordings')} aria-current={active === 'recordings' ? 'page' : undefined}><Activity aria-hidden="true" /><span>{t('Records', '记录')}</span></a>
      <a href={toolUrl('diary')} onClick={event => navigateTool(event, 'diary')} aria-current={active === 'daily' ? 'page' : undefined}><ClipboardList aria-hidden="true" /><span>{t('Diary', '日记')}</span></a>
      <a href="/learn" onClick={event => navigatePage(event, '/learn')} aria-current={active === 'learn' ? 'page' : undefined}><BookOpen aria-hidden="true" /><span>{t('Learn', '知识')}</span></a>
      <button ref={moreButton} type="button" onClick={() => setOpen(true)} aria-expanded={open} aria-haspopup="dialog" aria-controls="mobile-more-menu" data-current={active === 'more' || undefined}><List aria-hidden="true" /><span>{t('More', '更多')}</span></button>
    </nav>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent id="mobile-more-menu" className="mobile-more-menu" lang={lang === 'zh' ? 'zh-CN' : 'en'} onCloseAutoFocus={event => { event.preventDefault(); moreButton.current?.focus(); }}>
        <DialogHeader><DialogTitle>{t('Explore BreathMap', '全部功能')}</DialogTitle><DialogDescription>{t('Your recordings, daily sleep and account.', '查看呼吸记录、安排日常睡眠及管理账号。')}</DialogDescription></DialogHeader>
        {sections.map(section => <section key={section.title}><h3>{section.title}</h3><div className="mobile-more-links">{section.links.map(item => {
          const next = 'view' in item ? item.view : undefined;
          const href = next ? toolUrl(next) : 'href' in item ? item.href : '/';
          const Icon = item.icon;
          return <a href={href} key={item.label} onClick={event => next ? navigateTool(event, next) : navigatePage(event, href)} aria-current={href === location || path === '/assistant' && new URL(href, window.location.origin).pathname === '/assistant' ? 'page' : undefined}><Icon aria-hidden="true" /><span>{item.label}</span></a>;
        })}</div></section>)}
      </DialogContent>
    </Dialog>
  </>;
}
