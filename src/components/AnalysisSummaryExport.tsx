import { useEffect, useRef, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import './analysis-summary-export.css';
import summaryStyles from './analysis-summary-export.css?inline';

type Language = 'en' | 'zh';
export type AnalysisSummarySnapshot = {
  title: string;
  recordedAt: string | null;
  duration: string;
  breathingRate: string;
  expiratoryFlow: string;
  partialReasons: unknown;
  partial: boolean;
  savedNotes: string;
};

function describeLimits(summary: AnalysisSummarySnapshot, lang: Language) {
  const reasons: unknown[] = Array.isArray(summary.partialReasons) ? summary.partialReasons : [];
  const flowLimited = summary.expiratoryFlow !== '—' && reasons.includes('flow_partial_coverage');
  const rateLimited = summary.breathingRate !== '—' && reasons.includes('frequency_unavailable_in_some_windows');
  if (flowLimited && rateLimited) return lang === 'zh'
    ? '呼气流量仅根据可计算时段估计，部分分析窗口无法计算呼吸频率。'
    : 'Expiratory flow is estimated from the portions with usable data, and breathing rate could not be calculated for some analysis windows.';
  if (flowLimited) return lang === 'zh' ? '呼气流量仅根据可计算的时段估计。' : 'Expiratory flow is estimated from the portions with usable data.';
  if (rateLimited) return lang === 'zh' ? '部分分析窗口无法计算呼吸频率。' : 'Breathing rate could not be calculated for some analysis windows.';
  if (reasons.includes('invalid_samples_present') || (summary.partial && reasons.length === 0)) {
    return lang === 'zh' ? '本次分析仅有部分结果，解读时请结合完整报告。' : 'Some results are limited. Refer to the full report for context.';
  }
  return '';
}

export default function AnalysisSummaryExport({ lang, readSnapshot }: {
  lang: Language;
  readSnapshot: () => AnalysisSummarySnapshot;
}) {
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  const [snapshot, setSnapshot] = useState<AnalysisSummarySnapshot | null>(null);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [printError, setPrintError] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const printFrame = useRef<HTMLIFrameElement | null>(null);
  const printTitle = t('BreathMap analysis summary', 'BreathMap 呼吸分析摘要');

  function removePrintFrame() {
    printFrame.current?.remove();
    printFrame.current = null;
  }
  useEffect(() => removePrintFrame, []);

  function closePreview() {
    removePrintFrame();
    setSnapshot(null);
    setIncludeNotes(false);
    setPrintError(false);
  }

  function printSummary() {
    const summary = summaryRef.current;
    if (!summary) return;
    setPrintError(false);
    removePrintFrame();
    const frame = document.createElement('iframe');
    frame.className = 'analysis-summary-print-frame';
    frame.title = printTitle;
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    printFrame.current = frame;
    document.body.append(frame);
    try {
      const printDocument = frame.contentDocument;
      const printWindow = frame.contentWindow;
      if (!printDocument || !printWindow || typeof printWindow.print !== 'function') throw new Error('Print unavailable');
      printDocument.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      printDocument.title = printTitle;
      const styles = printDocument.createElement('style');
      styles.textContent = summaryStyles + `
        @page { size: A4; margin: 16mm; }
        body { margin: 0; }
        .analysis-summary-sheet { padding: 0; border: 0; }
      `;
      printDocument.head.append(styles);
      printDocument.body.replaceChildren(printDocument.importNode(summary, true));
      printWindow.print();
    } catch {
      removePrintFrame();
      setPrintError(true);
    }
  }

  const unavailable = t('Unavailable', '不可用');
  const capturedAt = snapshot?.recordedAt ? new Date(snapshot.recordedAt) : null;
  const captureLabel = capturedAt && Number.isFinite(capturedAt.getTime())
    ? capturedAt.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB') : unavailable;
  const metric = (value: string, unit: string) => value === '—' ? unavailable : `${value} ${unit}`;
  const limits = snapshot ? describeLimits(snapshot, lang) : '';
  const showNotes = includeNotes && !!snapshot?.savedNotes.trim();

  return <Dialog open={snapshot !== null} onOpenChange={open => {
    if (open) setSnapshot(readSnapshot());
    else closePreview();
  }}>
    <button ref={triggerRef} className="assistant-secondary analysis-summary-trigger" type="button" aria-haspopup="dialog" aria-expanded={snapshot !== null} onClick={() => setSnapshot(readSnapshot())}>
      <Download size={17} aria-hidden="true" />{t('Export analysis summary', '导出分析摘要')}
    </button>
    {snapshot && <DialogContent className="analysis-summary-dialog" lang={lang === 'zh' ? 'zh-CN' : 'en'} onCloseAutoFocus={event => {
      event.preventDefault();
      triggerRef.current?.focus();
    }}>
      <DialogHeader>
        <DialogTitle>{t('Analysis summary preview', '分析摘要预览')}</DialogTitle>
        <DialogDescription>{t('Review the summary before printing or saving it as a PDF.', '打印或保存为 PDF 前，请确认摘要内容。')}</DialogDescription>
      </DialogHeader>
      <label className="analysis-summary-option">
        <input type="checkbox" checked={showNotes} disabled={!snapshot.savedNotes.trim()} onChange={event => setIncludeNotes(event.target.checked)} />
        {t('Include my notes', '包含我的备注')}
        {!snapshot.savedNotes.trim() && <small>{t('No saved notes', '暂无已保存的备注')}</small>}
      </label>
      <article className="analysis-summary-sheet" ref={summaryRef}>
        <h2>{printTitle}</h2>
        <section>
          <h3>{t('Recording information', '记录信息')}</h3>
          <dl>
            <div><dt>{t('Recording name', '记录名称')}</dt><dd>{snapshot.title || unavailable}</dd></div>
            <div><dt>{t('Recorded date and time', '采集日期和时间')}</dt><dd>{captureLabel}</dd></div>
            <div><dt>{t('Recording duration', '记录时长')}</dt><dd>{metric(snapshot.duration, t('s', '秒'))}</dd></div>
          </dl>
        </section>
        <section>
          <h3>{t('Analysis results', '分析结果')}</h3>
          <dl>
            <div><dt>{t('Mean breathing rate', '平均呼吸频率')}</dt><dd>{metric(snapshot.breathingRate, t('breaths/min', '次/分'))}</dd></div>
            <div><dt>{t('Mean estimated expiratory flow', '平均估计呼气流量')}</dt><dd>{metric(snapshot.expiratoryFlow, 'L/min')}</dd></div>
          </dl>
          {limits && <p className="analysis-summary-limit">{limits}</p>}
        </section>
        {showNotes && <section className="analysis-summary-notes">
          <h3>{t('Personal notes', '个人备注')}</h3>
          <p className="analysis-summary-limit">{t('Entered by the user', '由用户自行记录')}</p>
          <p className="analysis-summary-note-text">{snapshot.savedNotes}</p>
        </section>}
      </article>
      {printError && <p role="alert">{t('The print window could not open. Try again in a browser that supports printing.', '无法打开打印窗口。请在支持打印的浏览器中重试。')}</p>}
      <div className="analysis-summary-actions">
        <button className="solid-button" type="button" onClick={printSummary}><Printer size={17} aria-hidden="true" />{t('Print or save as PDF', '打印或保存为 PDF')}</button>
      </div>
    </DialogContent>}
  </Dialog>;
}
