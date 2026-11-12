import { useEffect, useState, type FormEvent } from 'react';
import { Activity, ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { supabase } from './lib/supabase';
import { useAuth } from './lib/user';
import { safeReturnTo } from './lib/auth-return';

function authErrorMessage(issue: unknown, t: (en: string, zh: string) => string) {
  const code = issue && typeof issue === 'object' && 'code' in issue ? issue.code : undefined;
  const message = issue instanceof Error ? issue.message : '';
  if (code === 'over_email_send_rate_limit' || message.toLowerCase().includes('email rate limit exceeded')) {
    return t('The verification email sending limit has been reached. Please wait before trying again. If this continues, contact the project owner to check the email service.', '验证邮件发送已达上限，请稍后再试。若仍然出现，请联系项目负责人检查发信服务。');
  }
  if (code === 'email_address_not_authorized') {
    return t('The current email service cannot send verification emails to this address. Contact the project owner to configure email delivery.', '当前发信服务无法向这个邮箱发送验证邮件，请联系项目负责人完成发信配置。');
  }
  return message || t('This request could not be completed. Please try again.', '暂时无法完成，请重试。');
}

export default function AuthPages({ path, notice = '' }: { path: string; notice?: string }) {
  const { user } = useAuth();
  const [lang, setLang] = useState(() => localStorage.getItem('breathmap-language') === 'en' ? 'en' : 'zh');
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  const [email, setEmail] = useState(user?.email ?? '');
  const [name, setName] = useState(user?.fullName ?? '');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [show, setShow] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(notice);
  const signup = path === '/sign-up', forgot = path === '/forgot-password', reset = path === '/reset-password', account = path === '/account';
  const returnTo = safeReturnTo(new URLSearchParams(window.location.search).get('returnTo'));
  useEffect(() => { localStorage.setItem('breathmap-language', lang); }, [lang]);
  useEffect(() => {
    if (user && path === '/login') window.location.replace(returnTo);
    if (account && !user) window.location.replace('/login');
  }, [path, user?.id, returnTo]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !supabase) return;
    setError(''); setMessage('');
    if ((signup || reset) && (password.length < 12 || password !== confirmation)) { setError(t('Use at least 12 characters and enter the same password twice.', '密码至少 12 位，两次输入需要一致。')); return; }
    if (signup && !accepted) { setError(t('Please read and accept the terms below.', '请阅读并同意下方条款。')); return; }
    setBusy(true);
    try {
      if (account) {
        const { error: issue } = await supabase.auth.updateUser({ data: { name: name.trim() } }); if (issue) throw issue;
        const { error: profileIssue } = await supabase.from('profiles').update({ name: name.trim() }).eq('id', user!.id); if (profileIssue) throw profileIssue;
        setMessage(t('Your name has been saved.', '名称已保存。'));
      } else if (signup) {
        const { data, error: issue } = await supabase.auth.signUp({ email: email.trim(), password, options: { data: { name: name.trim() }, emailRedirectTo: window.location.origin + '/' } });
        if (issue) throw issue;
        if (data.session) window.location.replace('/');
        else setMessage(t('Check your email for the confirmation link. If email delivery is unavailable, contact the project owner.', '请查收邮箱中的确认链接。如果无法收到邮件，请联系项目负责人。'));
      } else if (forgot) {
        const { error: issue } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin + '/reset-password' }); if (issue) throw issue;
        setMessage(t('If this address can receive account emails, a reset link will arrive shortly.', '如果该地址可以接收账号邮件，稍后将收到重置链接。'));
      } else if (reset) {
        if (!user) throw new Error(t('Open the password reset link from your email first.', '请先打开邮件中的密码重置链接。'));
        const { error: issue } = await supabase.auth.updateUser({ password }); if (issue) throw issue;
        setPassword(''); setConfirmation(''); setMessage(t('Your password has been updated.', '密码已更新。'));
      } else {
        const { error: issue } = await supabase.auth.signInWithPassword({ email: email.trim(), password }); if (issue) throw issue;
        window.location.replace(returnTo);
      }
    } catch (issue) { setError(authErrorMessage(issue, t)); }
    finally { setBusy(false); }
  }
  const title = account ? t('Your account', '你的账号') : signup ? t('Create your BreathMap account', '创建 BreathMap 账号') : forgot ? t('Reset your password', '重置密码') : reset ? t('Choose a new password', '设置新密码') : t('Welcome to BreathMap', '欢迎使用 BreathMap');
  return <main className="auth-shell" lang={lang === 'zh' ? 'zh-CN' : 'en'}>
    <div className="auth-top"><a className="auth-brand" href="/"><Activity /> BreathMap</a><button className="text-button" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>{lang === 'zh' ? 'English' : '中文'}</button></div>
    <section className="auth-intro"><p className="eyebrow">{t('YOUR BREATHING, IN VIEW', '看见呼吸变化')}</p><h1>{t('See how breathing changes. Understand each record.', '看见呼吸变化，理解每次记录。')}</h1><p>{t('Keep your respiratory recordings, explore their waveforms and review clear explanations alongside your own notes.', '保存呼吸记录，查看波形，并结合自己的笔记理解分析结果。')}</p><svg viewBox="0 0 560 100" role="img" aria-label={t('BreathMap waveform', 'BreathMap 呼吸波形')}><path d="M0 52H32C42 52 43 18 55 18S68 78 82 78S96 28 110 28S124 70 138 70S153 18 168 18S184 82 200 82S216 26 232 26S248 66 264 66S279 20 294 20S312 80 330 80S348 24 366 24S384 70 402 70S420 30 438 30S454 55 470 55H560" fill="none" stroke="currentColor" strokeWidth="2" /></svg></section>
    <section className="auth-card"><h2>{title}</h2><p>{account ? user?.email : t('Sign in to keep your records together.', '登录后集中管理你的记录。')}</p>
      <form onSubmit={submit}>
        {(signup || account) && <label>{t('Your name', '名称')}<input required autoComplete="name" maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>}
        {!reset && !account && <label>Email<input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label>}
        {!forgot && !account && <label>{t('Password', '密码')}<span className="password-field"><input required type={show ? 'text' : 'password'} minLength={signup || reset ? 12 : undefined} autoComplete={signup || reset ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /><button type="button" onClick={() => setShow(!show)} aria-label={t(show ? 'Hide password' : 'Show password', show ? '隐藏密码' : '显示密码')}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>}
        {(signup || reset) && <label>{t('Confirm password', '确认密码')}<input required type="password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>}
        {signup && <label className="check-label"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} /><span>{t('I agree to use BreathMap for recording review, not medical diagnosis. My files and results are stored in my account. Saving a recording automatically queues numerical analysis. DeepSeek receives the necessary structured analysis results and any question I submit only if I choose to generate an AI explanation or send a question about the recording.', '我同意将 BreathMap 用于记录查看，而非医疗诊断。文件和结果保存在我的账号中。保存记录后会自动排队进行数值分析。只有当我选择生成 AI 解读或发送有关记录的问题时，DeepSeek 才会收到所需的结构化分析结果和我提交的问题。')}</span></label>}
        {error && <p role="alert" className="auth-error">{error}</p>}{message && <p role="status" className="auth-message">{message}</p>}
        {reset && !user && <a href="/forgot-password">{t('Request a new password reset link', '重新申请密码重置链接')}</a>}
        <button className="solid-button" disabled={busy}>{busy ? t('Please wait…', '请稍候…') : account ? t('Save name', '保存名称') : signup ? t('Create account', '创建账号') : forgot ? t('Send reset link', '发送重置链接') : reset ? t('Update password', '更新密码') : t('Sign in', '登录')}</button>
      </form>
      {account ? <div className="auth-links"><a href="/">{t('Back to your overview', '返回个人首页')}</a><a href="/forgot-password">{t('Change password', '修改密码')}</a><button className="text-button" disabled={busy} onClick={async () => { if (!supabase) return; setBusy(true); const { error } = await supabase.auth.signOut(); if (error) { setError(error.message); setBusy(false); } else window.location.replace('/login'); }}>{t('Sign out', '退出登录')}</button></div> : <div className="auth-links">{!signup && !forgot && !reset && <><a href="/forgot-password">{t('Forgot password?', '忘记密码？')}</a><a href="/demo">{t('Explore as guest', '游客体验')}</a></>}{(signup || forgot || reset) && <a href="/login"><ArrowLeft size={14} /> {t('Back to sign in', '返回登录')}</a>}</div>}
      {!account && !signup && !forgot && !reset && <p>{t('Registration is temporarily unavailable. You can explore as a guest or sign in with an existing account.', '注册暂未开放。你可以先以游客身份体验，或使用已有账号登录。')}</p>}
    </section>
  </main>;
}
