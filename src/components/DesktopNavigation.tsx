import { useEffect, useState, type MouseEvent } from 'react';
import { Activity, BookOpen, CalendarDays, ChartNoAxesCombined, ClipboardList, FileHeart, House, MessagesSquare, Moon, Timer, Upload, Zap } from 'lucide-react';
import { useAuth } from '../lib/user';

const readLocation = () => window.location.pathname + window.location.search;
const readLanguage = () => { try { return localStorage.getItem('breathmap-language') === 'en' ? 'en' : 'zh'; } catch { return 'zh'; } };

/** The wellbeing page owns its save/discard guard, including navigation from this rail. */
export default function DesktopNavigation() {
  const { user, loading } = useAuth();
  const [location, setLocation] = useState(readLocation);
  const [language, setLanguage] = useState(readLanguage);
  useEffect(() => {
    const update = () => { setLocation(readLocation()); setLanguage(readLanguage()); };
    const observer = new MutationObserver(update);
    const root = document.getElementById('root');
    if (root) observer.observe(root, { attributes: true, attributeFilter: ['lang'], childList: true, subtree: true });
    window.addEventListener('breathmap:tool-route-changed', update);
    window.addEventListener('storage', update);
    window.addEventListener('popstate', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('breathmap:tool-route-changed', update);
      window.removeEventListener('storage', update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  const url = new URL(location, window.location.origin);
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (!user || loading || ['/login', '/sign-up', '/forgot-password', '/reset-password'].includes(path)) return null;
  const t = (en: string, zh: string) => language === 'zh' ? zh : en;
  const context = new URLSearchParams();
  for (const key of ['ctxDate', 'ctxRecord', 'ctxPlan']) {
    const value = url.searchParams.get(key);
    if (value) context.set(key, value);
  }
  const toolHref = (view: string) => '/wellbeing?' + new URLSearchParams({ ...Object.fromEntries(context), view });
  const assistantHref = '/assistant';
  const sections = [
    { label: t('Workspace', '工作区'), items: [
      { href: '/', page: 'home', icon: House, label: t('Daily overview', '当天概览'), active: path === '/' },
      { href: assistantHref, page: 'assistant', icon: MessagesSquare, label: t('AI assistant', 'AI 助手'), active: path === '/assistant' },
    ] },
    { label: t('Recordings', '呼吸记录'), items: [
      { href: '/recordings', page: 'recordings', icon: Activity, label: t('History', '历史记录'), active: ['/recordings', '/report', '/analysis', '/trash'].includes(path) },
      { href: '/upload', page: 'upload', icon: Upload, label: t('Upload recording', '上传记录'), active: path === '/upload' },
      { href: toolHref('monitoring'), view: 'monitoring', icon: CalendarDays, label: t('Recording plan', '采集计划') },
      { href: toolHref('trends'), view: 'trends', icon: ChartNoAxesCombined, label: t('Trends and comparisons', '趋势与对比') },
    ] },
    { label: t('Daily sleep', '日常睡眠'), items: [
      { href: toolHref('diary'), view: 'diary', icon: ClipboardList, label: t('Sleep diary', '睡眠日记') },
      { href: toolHref('reaction'), view: 'reaction', icon: Zap, label: t('Reaction check', '反应自测') },
      { href: toolHref('routine'), view: 'routine', icon: Moon, label: t('Sleep routine', '作息计划') },
      { href: toolHref('relax'), view: 'relax', icon: Timer, label: t('Wind down', '睡前放松') },
      { href: toolHref('visits'), view: 'visits', icon: FileHeart, label: t('Visit notes', '就诊资料') },
      { href: '/learn', page: 'learn', icon: BookOpen, label: t('Sleep guide', '睡眠知识'), active: path === '/learn' },
    ] },
  ];
  function navigate(event: MouseEvent<HTMLAnchorElement>, item: { page?: string; view?: string }) {
    if (path !== '/wellbeing' || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('breathmap:tool-select', { detail: item.view
      ? { view: item.view, context: { date: url.searchParams.get('ctxDate') || undefined, recordingId: url.searchParams.get('ctxRecord') || undefined } }
      : { page: item.page } }));
  }
  return <aside className="desktop-navigation" lang={language === 'zh' ? 'zh-CN' : 'en'}>
    <a className="desktop-brand" href="/" onClick={event => navigate(event, { page: 'home' })}><Activity aria-hidden="true" /><span>BreathMap</span></a>
    <nav aria-label={t('Workspace navigation', '工作区导航')}>
      {sections.map(section => <section key={section.label}><h2>{section.label}</h2>{section.items.map(item => {
        const Icon = item.icon;
        const active = 'view' in item ? path === '/wellbeing' && (url.searchParams.get('view') || 'diary') === item.view : item.active;
        return <a key={item.label} href={item.href} onClick={event => navigate(event, item)} aria-current={active ? 'page' : undefined}><Icon aria-hidden="true" /><span>{item.label}</span></a>;
      })}</section>)}
    </nav>
  </aside>;
}
