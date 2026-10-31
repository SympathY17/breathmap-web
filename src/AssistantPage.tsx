import { Activity, ArrowLeft, MessageCircle, UserRound } from 'lucide-react';
import { useAssistant } from './components/AssistantProvider';
import AssistantView from './components/AssistantView';
import './assistant.css';

export default function AssistantPage() {
  const { lang } = useAssistant();
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  return <main className="assistant-page" lang={lang === 'zh' ? 'zh-CN' : 'en'}>
    <header className="assistant-page-header"><a href="/" className="auth-brand"><Activity />BreathMap</a><nav aria-label={t('Workspace navigation', '工作区导航')}><a href="/">{t('Home', '个人首页')}</a><a href="/recordings">{t('Recordings', '呼吸记录')}</a><a href="/assistant" aria-current="page">{t('AI assistant', 'AI 助手')}</a><a href="/learn">{t('Sleep guide', '睡眠知识')}</a></nav><div><button className="assistant-language" onClick={() => { localStorage.setItem('breathmap-language', lang === 'zh' ? 'en' : 'zh'); window.dispatchEvent(new Event('breathmap:language-change')); }}>{lang === 'zh' ? 'English' : '中文'}</button><a className="assistant-account" href="/account" aria-label={t('Account', '账号信息')}><UserRound size={20} /></a></div></header>
    <div className="assistant-page-intro"><a href="/recordings"><ArrowLeft size={15} />{t('Your recordings', '我的呼吸记录')}</a><div><h1>{t('AI assistant', 'AI 助手')}</h1><p>{t('Understand the findings. Explore the details. Keep the evidence in view.', '读懂分析结果，追问具体片段，随时查看对应依据。')}</p></div></div>
    <section className="assistant-workspace" aria-label={t('Recording assistant', '呼吸记录助手')}><aside className="assistant-page-aside"><span className="assistant-aside-icon"><MessageCircle size={26} /></span><h2>{t('A clearer view of your recording.', '让每次记录，更容易理解。')}</h2><p>{t('Start with the report, or bring a question from the waveform. Your recording stays at the centre of the conversation.', '从报告开始阅读，或带着波形中的问题来讨论。每段对话都关联到明确的呼吸记录。')}</p><div><span>{t('Data analysis', '数据分析')}</span><p>{t('Metrics, patterns and intervals calculated by the analysis tools.', '分析工具计算指标、识别模式，定位需要关注的区间。')}</p></div><div><span>{t('AI explanation', 'AI 解读')}</span><p>{t('Readable explanations and questions grounded in those results.', '基于分析结果组织报告、解释变化，并回答你的问题。')}</p></div></aside><AssistantView /></section>
  </main>;
}
