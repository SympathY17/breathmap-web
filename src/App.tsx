import { lazy, Suspense } from 'react';
import { AuthProvider, useAuth } from './lib/user';
import { isConfigured } from './lib/supabase';
import AuthPages from './AuthPages';
import AnalysisPanel from './AnalysisPanel';
import MobileNavigation from './components/MobileNavigation';
import { AssistantProvider } from './components/AssistantProvider';
import AssistantSurface from './components/AssistantSurface';
import AssistantPage from './AssistantPage';
import DesktopNavigation from './components/DesktopNavigation';
import './app.css';
import './workspace.css';

const pages = {
  '/': lazy(() => import('./pages/home')),
  '/recordings': lazy(() => import('./pages/recordings')),
  '/upload': lazy(() => import('./pages/upload')),
  '/report': lazy(() => import('./pages/report')),
  '/analysis': lazy(() => import('./pages/analysis')),
  '/trash': lazy(() => import('./pages/trash')),
  '/preferences': lazy(() => import('./pages/preferences')),
  '/security': lazy(() => import('./pages/security')),
  '/learn': lazy(() => import('./pages/learn')),
  '/wellbeing': lazy(() => import('./pages/wellbeing')),
};
function Routes() {
  const { loading, user, error } = useAuth();
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  if (!isConfigured) return <main className="auth-shell"><section className="auth-card"><p className="eyebrow">BreathMap</p><h1>Preparing your workspace</h1><p>The website is waiting for its database connection. No personal data has been loaded.</p><p>网站正在等待数据库配置，尚未载入个人数据。</p></section></main>;
  if (loading) return <main className="app-loading" role="status">Opening BreathMap…</main>;
  const native = ['/login', '/sign-up', '/forgot-password', '/reset-password', '/account'].includes(path);
  if (native || !user) return <AuthPages path={!user && !native ? '/login' : path} notice={error} />;
  if (path === '/assistant') return <AssistantPage />;
  const Page = pages[path as keyof typeof pages];
  if (!Page) return <main className="auth-shell"><section className="auth-card"><h1>Page not found</h1><a href="/">Back to your overview</a></section></main>;
  const id = new URLSearchParams(window.location.search).get('recordId') || new URLSearchParams(window.location.search).get('record');
  // The original summary-only report is replaced by the connected result workbench.
  if ((path === '/analysis' || path === '/report') && id) return <AnalysisPanel key={`${user.id}:${id}`} recordingId={id} detailed={path === '/analysis'} />;
  return <Suspense fallback={<main className="app-loading" role="status">Loading your workspace…</main>}><Page /></Suspense>;
}
export default function App() { return <AuthProvider><AssistantProvider><div className="workspace-shell"><DesktopNavigation /><div className="workspace-content"><Routes /></div></div><MobileNavigation /><AssistantSurface /></AssistantProvider></AuthProvider>; }
