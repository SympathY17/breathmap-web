import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, Hand, Maximize2, Minus, Plus, ScanLine } from 'lucide-react';
import { formatNumber as num, waveSegments, type Waveform } from '../lib/analysis';
import { clampRange, nearestSample, panRange, rangeContains, rangeWidth, sameRange, sampleValue, wheelRange, zoomRange, type TimeRange } from '../lib/waveform-view';
import './waveform-explorer.css';

export type { TimeRange } from '../lib/waveform-view';
export type RangeIntent = 'pan' | 'zoom' | 'select' | 'overview';
export type WaveformExplorerProps = {
  wave: Waveform | null;
  overview: Waveform | null;
  bounds: TimeRange;
  range: TimeRange;
  selection?: TimeRange | null;
  lang: 'en' | 'zh';
  loading: boolean;
  onRangeCommit: (range: TimeRange, intent?: RangeIntent) => void;
};
type Drag = { id: number; x: number; y: number; plotPixels: number; base: TimeRange; anchor: number; current: number; mode: 'pan' | 'select' | 'overview'; moved: boolean };
const TRACKS = [
  { column: 'signal_mT', en: 'Magnetic signal', zh: '磁场信号', unit: 'mT', color: '#276c68' },
  { column: 'expiratory_flow_l_min', en: 'Estimated expiratory flow', zh: '估计呼气流量', unit: 'L/min', color: '#6c9784' },
  { column: 'sig_input_uV', en: 'SIG differential voltage', zh: 'SIG 差分电压', unit: 'μV', color: '#6595ae' },
];
const LEFT = 54, RIGHT = 18, TOP = 20, BOTTOM = 142;

export default function WaveformExplorer({ wave, overview, bounds, range, selection = null, lang, loading, onRangeCommit }: WaveformExplorerProps) {
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [view, setView] = useState(() => clampRange(range, bounds));
  const viewRef = useRef(view), boundsRef = useRef(bounds), commitRef = useRef(onRangeCommit);
  viewRef.current = view; boundsRef.current = bounds; commitRef.current = onRangeCommit;
  const [mode, setMode] = useState<'pan' | 'select'>('pan');
  const [brush, setBrush] = useState<TimeRange | null>(null);
  const [cursorTime, setCursorTime] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const helpId = useId(), clipId = useId().replace(/:/g, '');

  function cancelWheel() { if (timer.current) clearTimeout(timer.current); timer.current = null; }
  function preview(next: TimeRange) { viewRef.current = next; setView(next); }
  function commit(next: TimeRange, intent: RangeIntent) {
    cancelWheel();
    const clamped = clampRange(next, boundsRef.current);
    preview(clamped); setBrush(null); setCursorTime(null);
    commitRef.current(clamped, intent);
  }
  useEffect(() => {
    if (!drag.current && !timer.current) preview(clampRange(range, bounds));
  }, [range.start_s, range.end_s, bounds.start_s, bounds.end_s]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const resize = () => setWidth(Math.max(180, Math.round(element.getBoundingClientRect().width || 1000)));
    resize();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }
    const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target.closest('svg[data-wave-main]') as SVGSVGElement | null : null;
      if (!target || drag.current) return;
      const rect = target.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - LEFT) / (width - LEFT - RIGHT)));
      const current = viewRef.current;
      const outcome = wheelRange(current, boundsRef.current, {deltaX:event.deltaX,deltaY:event.deltaY,shiftKey:event.shiftKey,deltaMode:event.deltaMode,pixelWidth:rect.width,pixelHeight:rect.height,anchor:current.start_s+fraction*rangeWidth(current)});
      if (!outcome) return;
      event.preventDefault();
      preview(outcome.range); setCursorTime(null); cancelWheel();
      timer.current = setTimeout(() => { timer.current = null; commitRef.current(viewRef.current, outcome.intent); }, 300);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { element.removeEventListener('wheel', wheel); cancelWheel(); };
  }, [width]);
  useEffect(() => () => cancelWheel(), []);

  const data = wave && rangeContains(wave.range, view) ? wave : overview ?? wave;
  const isOverviewPreview = !!data && (data !== wave || !rangeContains(data.range, view) || !!data.sampling?.downsampled);
  const tracks = useMemo(() => TRACKS.map(track => {
    const segments = data ? waveSegments(data, track.column).map(segment => segment.filter(point => point[0] >= view.start_s && point[0] < view.end_s)).filter(segment => segment.length) : [];
    const points = segments.flat();
    let min = Infinity, max = -Infinity;
    for (const point of points) { min = Math.min(min, point[1]); max = Math.max(max, point[1]); }
    return { ...track, segments, min, max, span: max - min || 1 };
  }), [data, view.start_s, view.end_s]);
  const cursorRow = cursorTime === null ? null : nearestSample(data, cursorTime, view);
  const timeIndex = data?.columns.indexOf('time_s') ?? -1;
  const actualTime = cursorRow && typeof cursorRow[timeIndex] === 'number' ? cursorRow[timeIndex] : null;
  const plotRight = width - RIGHT, plotWidth = Math.max(1, plotRight - LEFT);
  const x = (time: number, domain = view) => LEFT + (time - domain.start_s) / rangeWidth(domain) * plotWidth;
  function timeAt(svg: SVGSVGElement, clientX: number, domain = viewRef.current) {
    const rect = svg.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, ((clientX - rect.left) / rect.width * width - LEFT) / plotWidth));
    return domain.start_s + fraction * rangeWidth(domain);
  }
  function hover(svg: SVGSVGElement, clientX: number) {
    const row = nearestSample(data, timeAt(svg, clientX), viewRef.current);
    if (row && data) setCursorTime(row[data.columns.indexOf('time_s')] as number);
  }
  function down(event: PointerEvent<SVGSVGElement>, overviewDrag = false) {
    if (event.button !== 0 || !data) return;
    cancelWheel();
    const base = viewRef.current;
    const svg = event.currentTarget;
    const anchor = timeAt(svg, event.clientX, overviewDrag ? bounds : base);
    const pixels = svg.getBoundingClientRect().width * plotWidth / width;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, plotPixels: pixels, base, anchor, current: anchor, mode: overviewDrag ? 'overview' : mode, moved: false };
    svg.setPointerCapture?.(event.pointerId);
    svg.focus();
    if (!overviewDrag) hover(svg, event.clientX);
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) { hover(event.currentTarget, event.clientX); return; }
    const dx = event.clientX - active.x, dy = event.clientY - active.y;
    if (event.pointerType === 'touch' && Math.abs(dy) > Math.abs(dx) && !active.moved) return;
    if (Math.abs(dx) >= 3) active.moved = true;
    if (!active.moved) return;
    setCursorTime(null);
    if (active.mode === 'select') {
      active.current = timeAt(event.currentTarget, event.clientX, active.base);
      setBrush({ start_s: Math.min(active.anchor, active.current), end_s: Math.max(active.anchor, active.current) });
    } else if (active.mode === 'overview') {
      const delta = dx / active.plotPixels * rangeWidth(bounds);
      preview(panRange(active.base, delta, bounds));
    } else preview(panRange(active.base, -dx / active.plotPixels * rangeWidth(active.base), bounds));
  }
  function up(event: PointerEvent<SVGSVGElement>, cancelled = false) {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) { preview(clampRange(range, bounds)); setBrush(null); return; }
    if (active.mode === 'overview' && !active.moved) {
      const half = rangeWidth(active.base) / 2;
      commit({ start_s: active.anchor - half, end_s: active.anchor + half }, 'pan');
    } else if (active.moved && active.mode === 'select') {
      const selected = { start_s: Math.min(active.anchor, active.current), end_s: Math.max(active.anchor, active.current) };
      if (rangeWidth(selected) >= .1) commit(selected, 'select');
      else setBrush(null);
    } else if (active.moved) commit(viewRef.current, 'pan');
  }
  function key(event: KeyboardEvent<SVGSVGElement>) {
    const current = viewRef.current;
    let next: TimeRange | null = null, intent: RangeIntent = 'pan';
    if (event.key === 'ArrowLeft') next = panRange(current, -rangeWidth(current) * .25, bounds);
    else if (event.key === 'ArrowRight') next = panRange(current, rangeWidth(current) * .25, bounds);
    else if (event.key === '+' || event.key === '=') { next = zoomRange(current, .5, (current.start_s + current.end_s) / 2, bounds); intent = 'zoom'; }
    else if (event.key === '-') { next = zoomRange(current, 2, (current.start_s + current.end_s) / 2, bounds); intent = 'zoom'; }
    else if (event.key === 'Home') { next = bounds; intent = 'overview'; }
    if (next) { event.preventDefault(); commit(next, intent); }
  }
  const overviewData = overview ?? wave;
  const overviewSegments = useMemo(() => overviewData ? waveSegments(overviewData, 'signal_mT') : [], [overviewData]);
  const overviewValues = overviewSegments.flat().map(point => point[1]);
  const overviewMin = overviewValues.length ? Math.min(...overviewValues) : 0;
  const overviewSpan = overviewValues.length ? Math.max(...overviewValues) - overviewMin || 1 : 1;
  const activeSelection = brush ?? selection;
  const selectionLeft = activeSelection ? Math.max(view.start_s, activeSelection.start_s) : 0;
  const selectionRight = activeSelection ? Math.min(view.end_s, activeSelection.end_s) : 0;

  return <div className="wfe" ref={root}>
    <div className="wfe-toolbar" aria-label={t('Waveform navigation', '波形导航')}>
      <div className="wfe-modes" aria-label={t('Drag mode', '拖动方式')}>
        <button type="button" aria-pressed={mode === 'pan'} onClick={() => { setMode('pan'); setBrush(null); }}><Hand size={16} />{t('Pan', '平移')}</button>
        <button type="button" aria-pressed={mode === 'select'} onClick={() => { setMode('select'); setBrush(null); }}><ScanLine size={16} />{t('Select & zoom', '框选放大')}</button>
      </div>
      <div className="wfe-navigation">
        <button type="button" aria-label={t('Previous interval', '向前移动区间')} disabled={view.start_s <= bounds.start_s} onClick={() => commit(panRange(view, -rangeWidth(view) * .8, bounds), 'pan')}><ArrowLeft size={16} /></button>
        <button type="button" aria-label={t('Zoom in', '放大波形')} disabled={rangeWidth(view) <= .10001} onClick={() => commit(zoomRange(view, .5, (view.start_s + view.end_s) / 2, bounds), 'zoom')}><Plus size={16} /></button>
        <button type="button" aria-label={t('Zoom out', '缩小波形')} disabled={sameRange(view, bounds)} onClick={() => commit(zoomRange(view, 2, (view.start_s + view.end_s) / 2, bounds), 'zoom')}><Minus size={16} /></button>
        <button type="button" aria-label={t('Next interval', '向后移动区间')} disabled={view.end_s >= bounds.end_s} onClick={() => commit(panRange(view, rangeWidth(view) * .8, bounds), 'pan')}><ArrowRight size={16} /></button>
        <button type="button" className="wfe-overview-button" onClick={() => commit(bounds, 'overview')}><Maximize2 size={16} />{t('Full recording', '整段总览')}</button>
      </div>
    </div>
    <div className="wfe-range" role="status"><strong>{num(view.start_s, 3)}–{num(view.end_s, 3)} s</strong><span>{t('Window', '跨度')} {num(rangeWidth(view), 3)} s</span>{loading && <span className="wfe-loading">{t('Loading interval details…', '正在读取区间细节…')}</span>}</div>
    <p className="wfe-help" id={helpId}>{t('Drag to pan or select. Scroll to zoom; Shift + scroll to pan. Keyboard: ← →, + −, Home. Hover or tap to inspect a source sample.', '拖动平移或框选，滚轮缩放，Shift＋滚轮平移。键盘：← →、＋ −、Home。悬停或轻点查看采样值。')}</p>
    <div className="wfe-readout" aria-label={t('Selected source sample', '当前源采样点')}>
      <div><span>{t('Sample time', '采样时间')}</span><strong>{actualTime === null ? '—' : `${num(actualTime, 3)} s`}</strong></div>
      {TRACKS.map(track => <div key={track.column}><span>{t(track.en, track.zh)}</span><strong>{data && cursorRow ? num(sampleValue(data, cursorRow, track.column), 4) : '—'} <small>{track.unit}</small></strong></div>)}
    </div>
    {tracks.map((track, index) => {
      const y = (value: number) => BOTTOM - (value - track.min) / track.span * (BOTTOM - TOP);
      return <div className="wfe-track" key={track.column}><strong>{t(track.en, track.zh)} <small>({track.unit})</small></strong>
        <svg data-wave-main data-mode={mode} className="wfe-plot" viewBox={`0 0 ${width} 180`} role="img" tabIndex={0} aria-label={`${t(track.en, track.zh)}, ${num(view.start_s)}–${num(view.end_s)} s`} aria-describedby={helpId} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={event => up(event, true)} onLostPointerCapture={event => up(event,true)} onKeyDown={key}>
          <defs><clipPath id={`${clipId}-${index}`}><rect x={LEFT} y={TOP-2} width={plotWidth} height={BOTTOM-TOP+4} /></clipPath></defs>
          <path d={`M${LEFT} ${TOP}V${BOTTOM}H${plotRight}`} fill="none" stroke="#b8d4ca" />
          <g clipPath={`url(#${clipId}-${index})`}>
            {activeSelection && selectionRight > selectionLeft && <rect className="wfe-highlight" x={x(selectionLeft)} y={TOP} width={x(selectionRight)-x(selectionLeft)} height={BOTTOM-TOP} />}
            {track.segments.map((segment, n) => segment.length === 1 ? <circle key={n} cx={x(segment[0][0])} cy={y(segment[0][1])} r={1.5} fill={track.color} /> : <polyline key={n} points={segment.map(([time, value]) => `${x(time)},${y(value)}`).join(' ')} fill="none" stroke={track.color} strokeWidth="1.5" />)}
            {actualTime !== null && <line className="wfe-cursor" x1={x(actualTime)} x2={x(actualTime)} y1={TOP} y2={BOTTOM} />}
            {actualTime !== null && data && cursorRow && sampleValue(data, cursorRow, track.column) !== null && <circle cx={x(actualTime)} cy={y(sampleValue(data, cursorRow, track.column)!)} r={3.5} fill={track.color} stroke="#fff" strokeWidth="1.5" />}
          </g>
          {track.segments.length ? <><text x="4" y={TOP+4}>{num(track.max, 4)}</text><text x="4" y={BOTTOM}>{num(track.min, 4)}</text></> : <text x={(LEFT+plotRight)/2} y="85" textAnchor="middle">{t('No available samples in this view', '此视图暂无可用采样点')}</text>}
          {(width < 420 ? [0,1] : [0,.5,1]).map(fraction => <text key={fraction} x={LEFT+fraction*plotWidth} y="164" textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}>{num(view.start_s+fraction*rangeWidth(view),3)} s</text>)}
        </svg>
      </div>;
    })}
    <div className="wfe-overview"><div><strong>{t('Recording navigator', '整段时间导航')}</strong><span>{t('Click to jump · drag the highlighted view', '点击跳转 · 拖动高亮视图')}</span></div>
      <svg className="wfe-mini" viewBox={`0 0 ${width} 72`} role="slider" tabIndex={0} aria-label={t('Recording overview navigator', '整段记录导航')} aria-valuemin={bounds.start_s} aria-valuemax={bounds.end_s} aria-valuenow={view.start_s} aria-valuetext={`${num(view.start_s,3)}–${num(view.end_s,3)} s`} aria-describedby={helpId} onPointerDown={event => down(event, true)} onPointerMove={move} onPointerUp={up} onPointerCancel={event => up(event,true)} onLostPointerCapture={event=>up(event,true)} onKeyDown={key}>
        {overviewSegments.map((segment,index) => <polyline key={index} points={segment.map(([time,value]) => `${x(time,bounds)},${44-(value-overviewMin)/overviewSpan*34}`).join(' ')} fill="none" stroke="#78a39a" strokeWidth="1" />)}
        <rect className="wfe-overview-selection" x={x(view.start_s,bounds)} y="5" width={Math.max(2,x(view.end_s,bounds)-x(view.start_s,bounds))} height="42" />
        <text x={LEFT} y="65">{num(bounds.start_s)} s</text><text x={plotRight} y="65" textAnchor="end">{num(bounds.end_s)} s</text>
      </svg>
    </div>
    <p className="wfe-caption">{loading && isOverviewPreview ? t('Showing sampled preview while interval details load. ', '区间细节读取中，当前显示抽样预览。') : isOverviewPreview ? t('Showing sampled source points. Load a shorter interval for more detail. ', '当前显示抽样源数据点；载入较短区间可查看更多细节。') : t('Showing saved source samples. ', '当前显示已保存源采样点。')}{t('Gaps remain blank; sample values are never reconstructed by zooming.', '缺口保持为空；缩放不会推算新的采样值。')}{data?.sampling && ` ${t('Loaded range', '已载范围')} ${num(data.range.start_s,3)}–${num(data.range.end_s,3)} s · ${num(data.sampling.returned_points,0)} / ${num(data.sampling.source_rows_in_range,0)} ${t('source rows', '源数据行')}`}</p>
  </div>;
}
