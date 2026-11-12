import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  DollarSign,
  EyeOff,
  HelpCircle,
  History,
  Info,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  X,
  XCircle,
} from 'lucide-react';
import Help from './Help.jsx';
import './styles.css';

/* ================================================================== constants */
const STATUS_LABELS = { green: 'Healthy', amber: 'Watch', red: 'Action required', unknown: 'No data' };
const STATUS_MEANING = {
  green: 'All measured checks are within limits.',
  amber: 'At least one check is close to its limit — owner should review.',
  red: 'At least one check has breached its limit — owner should act now.',
  unknown: 'Not enough activity to judge. A visibility gap, not a pass.',
};
const STATUS_ORDER = ['red', 'amber', 'green', 'unknown'];
const PILLARS = ['health', 'risk', 'cost'];
const PILLAR_META = {
  health: { name: 'Health', question: 'Is it working?', icon: Activity },
  risk: { name: 'Risk', question: 'Is it behaving safely?', icon: ShieldCheck },
  cost: { name: 'Cost', question: 'Is it affordable?', icon: DollarSign },
};
const PERIODS = [
  { days: 1, label: 'Last 24 hours', short: '24 hours' },
  { days: 7, label: 'Last 7 days', short: '7 days' },
  { days: 30, label: 'Last 30 days', short: '30 days' },
  { days: 90, label: 'Last 90 days', short: '90 days' },
];
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'manage', label: 'Manage agents' },
  { id: 'library', label: 'How it’s measured' },
  { id: 'sources', label: 'Data sources' },
];
const GROUP_FIELDS = { department: 'Department', location: 'Location', platform: 'Platform', environment: 'Environment', none: 'No grouping' };
const ENVIRONMENTS = ['Production', 'Test only', 'No activity'];
const AUTO_REFRESH_MS = 5 * 60 * 1000;

export const KPI_DEFS = {
  overall: 'The worst status of any monitored agent.',
  monitored: 'Every agent that sent telemetry to Application Insights in the last 90 days (plus any added by hand), minus agents you removed.',
  active: 'Agents with at least one conversation or automatic run in the selected period.',
  runs: 'Chat conversations where a user sent a message, plus automatic (trigger-started) runs. Greeting-only sessions are excluded.',
  attention: 'Agents whose overall status is Watch or Action required.',
  compliance: 'Agents failing one or more automatic AI-policy checks (purpose & department, owners, risk tier, approval). Add details under Manage agents to fix.',
  coverage: 'Share of metrics on active agents that had enough data to rate. Grey (No data) is a visibility gap, never a pass.',
  widened: 'Agents with no activity in the selected period. Their figures show their most recent 90 days instead, so they always have data.',
};

const ERROR_HELP = {
  FlowActionTimedOut: 'An agent flow took longer than the 100-second limit',
  ConnectorRequestFailure: 'A connector call returned an error',
  ContentFiltered: 'Blocked by Responsible AI content filtering',
  DataLossPreventionViolation: 'Blocked by a data loss prevention (DLP) policy',
  SystemError: 'Platform-side error',
  ContextTokenLimitExceeded: 'Request exceeded the model’s context length',
  ContentError: 'Error in the topic content',
  AuthenticationNotConfigured: 'Authentication required but not configured',
  ConsentNotProvidedByUser: 'User declined the sign-in request',
  BingSearchFailed: 'Web knowledge search failed',
  ConversationStateTooLarge: 'Conversation state exceeded size limits',
  FlowActionBadRequest: 'Agent flow inputs did not match',
};

const AppContext = createContext({ openHelp: () => {} });
const useApp = () => useContext(AppContext);

/* ==================================================================== helpers */
const fmtDateTime = (d) =>
  d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtNum = (n) => (n === null || n === undefined ? '—' : Math.round(Number(n)).toLocaleString('en-US'));
const fmtPct = (n) => (n === null || n === undefined ? '—' : `${Math.round(n * 10) / 10}%`);
const fmtUsd = (n) =>
  n === null || n === undefined ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: n >= 100 ? 0 : 2, maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
const plural = (n, word, many = `${word}s`) => `${fmtNum(n)} ${n === 1 ? word : many}`;
const periodOf = (days) => PERIODS.find((p) => p.days === days) || { label: `Last ${days} days`, short: `${days} days` };
const worst = (list) => list.reduce((w, s) => (STATUS_ORDER.indexOf(s) < STATUS_ORDER.indexOf(w) ? s : w), 'unknown');
const countBy = (items, fn) => items.reduce((m, x) => ((m[fn(x)] = (m[fn(x)] || 0) + 1), m), {});
const sum = (items, fn) => items.reduce((s, x) => s + (Number(fn(x)) || 0), 0);
const pct = (n, d) => (d > 0 ? (100 * n) / d : null);

function relTime(ts, now = Date.now()) {
  if (!ts) return 'No activity';
  const mins = Math.max(0, Math.round((now - new Date(ts).getTime()) / 60000));
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const d = Math.round(hrs / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function fieldValue(agent, field) {
  if (field === 'owner') return agent.businessOwner || 'Unassigned';
  return agent[field] || 'Unassigned';
}

function bucketLabel(t, days) {
  const d = new Date(t);
  return days === 1 ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function rateWith(library, metricId, value) {
  const t = library?.metrics?.find((m) => m.id === metricId)?.thresholds;
  if (!t || value === null || value === undefined) return 'unknown';
  if (t.higherIsBetter) return value >= t.green ? 'green' : value >= t.amber ? 'amber' : 'red';
  return value <= t.green ? 'green' : value <= t.amber ? 'amber' : 'red';
}

function aggregateSeries(agents) {
  const buckets = new Map();
  agents.forEach((a) =>
    (a.series || []).forEach((p) => {
      const b = buckets.get(p.t) || { t: p.t, conversations: 0, failed: 0, completed: 0, blocked: 0 };
      b.conversations += p.conversations;
      b.failed += p.failed;
      b.completed += p.completed;
      b.blocked += p.blocked || 0;
      buckets.set(p.t, b);
    })
  );
  return [...buckets.values()].sort((a, b) => new Date(a.t) - new Date(b.t));
}

const widenedText = (agent) => `No activity in the ${periodOf(agent.selectedDays).label.toLowerCase()} — showing the last ${agent.dataDays} days`;

function agentHeadline(agent) {
  if (agent.statuses.overall === 'unknown') {
    if (!agent.volume) return 'No activity in the last 90 days.';
    return `Only ${plural(agent.volume, 'run')} so far — too little activity to rate yet. Figures are shown below.`;
  }
  const top = agent.alerts[0];
  if (!top) return 'All measured checks are within limits.';
  const more = agent.alerts.length - 1;
  return `${top.metric} is ${top.value}${more > 0 ? ` (+${more} more issue${more === 1 ? '' : 's'})` : ''}.`;
}

function niceScale(max, ticks = 4) {
  if (!max || max <= 0) return { top: 1, step: 0.25 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { top: step * Math.ceil(max / step), step };
}

/* ================================================================= primitives */
function StatusBadge({ value, size = 'md', title }) {
  return (
    <span className={`status ${value} ${size}`} title={title || STATUS_MEANING[value]}>
      <i aria-hidden="true" />
      {STATUS_LABELS[value] || value}
    </span>
  );
}

function Tip({ text, label = 'More information' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const show = () => {
    const r = ref.current.getBoundingClientRect();
    const width = 260;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
    const above = r.top > 140;
    setPos({ left, top: above ? r.top - 8 : r.bottom + 8, above });
  };
  const hide = () => setPos(null);
  useEffect(() => {
    if (!pos) return undefined;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [pos]);
  return (
    <>
      <span ref={ref} className="tip" tabIndex={0} role="button" aria-label={`${label}: ${text}`}
        onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); show(); }}>
        <Info size={13} aria-hidden="true" />
      </span>
      {pos && createPortal(
        <span role="tooltip" className={`tip-pop ${pos.above ? 'above' : 'below'}`} style={{ left: pos.left, top: pos.top }}>{text}</span>,
        document.body
      )}
    </>
  );
}

function WidenedTag({ agent, compact = false }) {
  if (!agent.widened) return null;
  return (
    <span className="widened" title={widenedText(agent)}>
      <History size={13} aria-hidden="true" /> {compact ? `Last ${agent.dataDays} days` : widenedText(agent)}
    </span>
  );
}

function Panel({ title, subtitle, tip, right, children, className = '', helpSection }) {
  const { openHelp } = useApp();
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <div className="panel-head">
          <div>
            {title && (
              <h3>
                {title} {tip && <Tip text={tip} />}
                {helpSection && (
                  <button className="help-link" type="button" onClick={() => openHelp(helpSection)}>
                    <HelpCircle size={14} /> Explain
                  </button>
                )}
              </h3>
            )}
            {subtitle && <p className="sub">{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function Legend({ items, title = 'Legend' }) {
  return (
    <ul className="legend" aria-label={title}>
      {items.map((it) => (
        <li key={it.label}>
          <i className={`swatch ${it.cls}`} aria-hidden="true" />
          {it.label}
        </li>
      ))}
    </ul>
  );
}
const STATUS_LEGEND = STATUS_ORDER.map((s) => ({ label: STATUS_LABELS[s], cls: s }));

function Segmented({ options, value, onChange, label }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)} type="button">
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SelectField({ label, tip, value, onChange, options }) {
  return (
    <label className="field">
      <span className="field-label">
        {label} {tip && <Tip text={tip} />}
      </span>
      <span className="select-box">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown size={15} aria-hidden="true" />
      </span>
    </label>
  );
}

/** Status bar. With showLabels, a fixed 2×2 legend is shown underneath so every card lines up. */
function StatusSplit({ counts, total, label, showLabels = false }) {
  const bar = total ? (
    <div className="split" role="img" aria-label={`${label}: ${STATUS_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${STATUS_LABELS[s]}`).join(', ')}`}>
      {STATUS_ORDER.map((s) =>
        counts[s] ? (
          <span key={s} className={`seg ${s}`} style={{ flexGrow: counts[s] }} title={`${counts[s]} ${STATUS_LABELS[s]}`}>
            {counts[s]}
          </span>
        ) : null
      )}
    </div>
  ) : (
    <div className="split empty" />
  );
  if (!showLabels) return bar;
  return (
    <div className="split-wrap">
      {bar}
      <ul className="split-labels">
        {STATUS_ORDER.map((s) => (
          <li key={s} className={counts[s] ? '' : 'zero'}>
            <i className={`swatch ${s}`} aria-hidden="true" />
            <b>{counts[s] || 0}</b> {STATUS_LABELS[s]}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ===================================================================== charts */
const CHART = { W: 760, H: 300, L: 64, R: 20, T: 18, B: 58 };

function XAxisLabels({ points, x, days, y0 }) {
  const every = Math.max(1, Math.ceil(points.length / 8));
  return points.map((p, i) =>
    i % every === 0 || i === points.length - 1 ? (
      <text key={`x${i}`} className="axis" x={x(i)} y={y0 + 18} textAnchor="middle">
        {bucketLabel(p.t, days)}
      </text>
    ) : null
  );
}

function TrendChart({ points, thresholds, unit = '%', days, title, xTitle, yTitle, seriesLabel }) {
  if (!points.some((p) => p.value !== null)) return <div className="chart-empty">No activity in this period, so there is no trend to show.</div>;
  const { W, H, L, T, B } = CHART;
  const R = 110;
  const { green, amber } = thresholds;
  const maxVal = Math.max(...points.map((p) => p.value ?? 0));
  const { top, step } = niceScale(Math.max(amber * 1.6, maxVal * 1.15));
  const x = (i) => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = (v) => T + (1 - Math.min(v, top) / top) * (H - T - B);
  const valid = points.map((p, i) => ({ ...p, i })).filter((p) => p.value !== null);
  const path = valid.map((p, k) => `${k ? 'L' : 'M'}${x(p.i)},${y(p.value)}`).join(' ');
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        <rect className="band red" x={L} y={y(top)} width={W - L - R} height={y(amber) - y(top)} />
        <rect className="band amber" x={L} y={y(amber)} width={W - L - R} height={y(green) - y(amber)} />
        <rect className="band green" x={L} y={y(green)} width={W - L - R} height={y(0) - y(green)} />
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text className="axis" x={L - 8} y={y(t) + 4} textAnchor="end">
              {t}
              {unit}
            </text>
          </g>
        ))}
        {[
          ['red', 'Action required', `above ${amber}${unit}`, (y(top) + y(amber)) / 2],
          ['amber', 'Watch', `${green}–${amber}${unit}`, (y(amber) + y(green)) / 2],
          ['green', 'Healthy', `up to ${green}${unit}`, (y(green) + y(0)) / 2],
        ].map(([cls, name, range, cy]) => (
          <text key={cls} className={`band-label ${cls}`} x={W - R + 10} y={cy - 2}>
            <tspan x={W - R + 10}>{name}</tspan>
            <tspan x={W - R + 10} dy="14" className="band-range">{range}</tspan>
          </text>
        ))}
        <path d={path} className="trend-line" />
        {valid.map((p) => (
          <circle key={p.i} cx={x(p.i)} cy={y(p.value)} r={points.length > 40 ? 2.5 : 4.5} className="trend-dot">
            <title>{`${bucketLabel(p.t, days)}: ${p.value}${unit} of ${fmtNum(p.n)} runs`}</title>
          </circle>
        ))}
        <line className="axis-line" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
        <XAxisLabels points={points} x={x} days={days} y0={y(0)} />
        <text className="axis-title" x={(L + W - R) / 2} y={H - 8} textAnchor="middle">{xTitle}</text>
        <text className="axis-title" transform={`translate(16 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle">{yTitle}</text>
      </svg>
      <figcaption>
        <Legend items={[{ label: seriesLabel, cls: 'line' }, { label: 'Healthy band', cls: 'band-green' }, { label: 'Watch band', cls: 'band-amber' }, { label: 'Action band', cls: 'band-red' }]} />
        <span className="chart-note">Hover a point for the exact value.</span>
      </figcaption>
    </figure>
  );
}

const VOLUME_KEYS = [
  { key: 'completed', label: 'Resolved', cls: 'bar-ok' },
  { key: 'other', label: 'Not resolved (escalated, abandoned or unanswered)', cls: 'bar-other' },
  { key: 'failed', label: 'Had an error', cls: 'bar-fail' },
  { key: 'blocked', label: 'Blocked by safety guardrails', cls: 'bar-block' },
];

function VolumeChart({ series, days, title, compact = false }) {
  if (!series.length || !series.some((s) => s.conversations)) return <div className="chart-empty">No activity in this period.</div>;
  const { W, H, L, R, T, B } = compact ? { ...CHART, H: 260 } : CHART;
  const rows = series.map((s) => {
    const failed = s.failed || 0;
    const blocked = s.blocked || 0;
    const completed = s.completed || 0;
    return { t: s.t, total: s.conversations, completed, failed, blocked, other: Math.max(s.conversations - completed - failed - blocked, 0) };
  });
  const { top, step } = niceScale(Math.max(...rows.map((r) => r.completed + r.failed + r.blocked + r.other), 1));
  const bw = (W - L - R) / rows.length;
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const x = (i) => L + i * bw + bw / 2;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text className="axis" x={L - 8} y={y(t) + 4} textAnchor="end">{fmtNum(t)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          let acc = 0;
          return (
            <g key={r.t}>
              <title>{`${bucketLabel(r.t, days)} — ${fmtNum(r.total)} runs: ${fmtNum(r.completed)} resolved, ${fmtNum(r.other)} not resolved, ${fmtNum(r.failed)} with an error, ${fmtNum(r.blocked)} blocked`}</title>
              {VOLUME_KEYS.map((k) => {
                const v = r[k.key];
                if (!v) return null;
                const y1 = y(acc + v);
                const hgt = y(acc) - y1;
                acc += v;
                return <rect key={k.key} className={k.cls} x={L + i * bw + bw * 0.14} y={y1} width={Math.max(bw * 0.72, 1)} height={Math.max(hgt, 0.5)} />;
              })}
            </g>
          );
        })}
        <line className="axis-line" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
        <XAxisLabels points={rows} x={x} days={days} y0={y(0)} />
        <text className="axis-title" x={(L + W - R) / 2} y={H - 8} textAnchor="middle">{days === 1 ? 'Hour (your local time)' : 'Day'}</text>
        <text className="axis-title" transform={`translate(16 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle">Conversations & runs</text>
      </svg>
      <figcaption>
        <Legend items={VOLUME_KEYS} />
        <span className="chart-note">Hover a bar for the exact breakdown.</span>
      </figcaption>
    </figure>
  );
}

/* ===================================================================== header */
function Header({ payload, mode, theme, toggleTheme, refresh, refreshing, openHelp, days, setDays, autoRefresh, setAutoRefresh, stale }) {
  const win = payload?.window;
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <div className="brand-block">
          <div className="wordmark">Grant Thornton</div>
          <div className="title-block">
            <h1>AI Agent Runtime Monitoring</h1>
            <p>Are our AI agents working, safe and affordable? · Copilot Studio and Azure AI Foundry</p>
          </div>
        </div>
        <div className="masthead-actions">
          <span className={`mode-badge ${mode}`}>
            <i aria-hidden="true" />
            {mode === 'live' ? (stale ? 'Live data (refresh failed)' : 'Live data') : mode === 'demo' ? 'Demo data' : mode === 'error' ? 'No data' : 'Loading…'}
          </span>
          <button className="ghost" onClick={() => openHelp('start')} type="button" title="How this dashboard works (shortcut: ?)">
            <HelpCircle size={15} /> How it works
          </button>
          <button className="ghost icon-only" onClick={toggleTheme} type="button" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="primary" onClick={refresh} type="button" disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <div className="period-bar">
        <div className="period-inner">
          <span className="field-label inline">
            Reporting period <Tip text="Figures use this period. Agents with no activity in it show their most recent 90 days instead, clearly labelled." />
          </span>
          <Segmented label="Reporting period" options={PERIODS.map((p) => ({ value: p.days, label: p.label }))} value={days} onChange={setDays} />
          <span className="range">{win ? `${fmtDateTime(win.start)} → ${fmtDateTime(win.end)}` : ''}</span>
          <span className="asof">
            <Clock size={14} /> Data as of <b>{payload?.generatedAt ? fmtDateTime(payload.generatedAt) : '—'}</b>
          </span>
          <label className="check">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} disabled={mode === 'demo'} />
            Auto-refresh every 5 min
          </label>
        </div>
      </div>
    </header>
  );
}

/* ========================================================= executive overview */
function portfolioFigures(agents, library) {
  const raw = (k) => sum(agents, (a) => a.raw?.[k]);
  const engaged = raw('engaged');
  const resolvedPct = pct(raw('resolved'), engaged);
  const errorPct = pct(raw('healthFailed'), engaged);
  const replyPct = pct(raw('answered'), raw('userTurns'));
  const slowest = agents.filter((a) => a.raw?.p95 != null && a.raw.answered >= 10).sort((a, b) => b.raw.p95 - a.raw.p95)[0] || null;
  const spends = agents.filter((a) => a.spendUsd !== null && a.spendUsd !== undefined);
  const budgeted = agents.filter((a) => a.budgetUsd && a.spendUsd !== null && a.billing !== 'included');
  const budgetSpend = sum(budgeted, (a) => a.spendUsd);
  const budgetTotal = sum(budgeted, (a) => a.budgetUsd);
  return {
    engaged,
    resolvedPct,
    resolvedStatus: engaged >= 5 ? rateWith(library, 'task_completion', resolvedPct) : 'unknown',
    errorPct,
    errorStatus: engaged >= 5 ? rateWith(library, 'failed_execution_rate', errorPct) : 'unknown',
    replyPct,
    replyStatus: raw('userTurns') >= 10 ? rateWith(library, 'agent_availability', replyPct) : 'unknown',
    slowest,
    jailbreaks: raw('jailbreaks'),
    indirect: raw('indirect'),
    contentBlocks: raw('harmful') + raw('dlp'),
    safetyBlocks: raw('jailbreaks') + raw('indirect') + raw('harmful') + raw('dlp'),
    spend: spends.length ? sum(spends, (a) => a.spendUsd) : null,
    budgetUsedPct: budgetTotal ? pct(budgetSpend, budgetTotal) : null,
    budgetStatus: budgetTotal ? rateWith(library, 'spend', pct(budgetSpend, budgetTotal)) : 'unknown',
    budgetTotal,
    overBudget: agents.filter((a) => a.metrics.cost.some((m) => m.id === 'spend' && m.rawValue > 100)).length,
    noBudget: agents.filter((a) => !a.budgetUsd && a.billing !== 'included' && a.volume > 0).length,
    costPerRun: spends.length && engaged ? sum(spends, (a) => a.spendUsd) / engaged : null,
  };
}

/* -------------------------------------------------------------------------
 * HERO — executive Health / Risk / Cost cards
 *
 * Design rule: the headline can never contradict the badge.
 *   1. Verdict   — how many agents need attention (straight from agent statuses,
 *                  the same numbers that drive the badge).
 *   2. Why       — the checks that are failing, worst first, with the agent and
 *                  the target. Remaining rows show the portfolio figure, rated.
 *   3. Coverage  — one compact bar; "No data" is shown as a gap, never a pass.
 *   4. Who       — the agents to look at, one click away.
 * ----------------------------------------------------------------------- */
const SEVERITY_RANK = { red: 0, amber: 1, green: 2, unknown: 3 };

/** Short target text for a metric, e.g. "target ≥ 99%" or "target ≤ 10s". */
function targetText(library, id) {
  const m = library?.metrics?.find((x) => x.id === id);
  const t = m?.thresholds;
  if (!t) return '';
  const u = m.unit === '%' ? '%' : m.unit === 's' ? 's' : '';
  if (id === 'prompt_injection_attempts') return 'target: none';
  if (m.unit === 'count') return t.green === 0 ? 'target: none' : `target ≤ ${t.green}`;
  return `target ${t.higherIsBetter ? '≥' : '≤'} ${t.green}${u}`;
}

/** Short executive wording for each metric. */
const ISSUE_TEXT = {
  agent_availability: 'Messages answered',
  task_completion: 'Runs resolved',
  p95_latency: 'Response time',
  timeout_rate: 'Very slow replies',
  failed_execution_rate: 'Runs with errors',
  dependency_failure_rate: 'Tool & connector failures',
  prompt_injection_attempts: 'Jailbreak attempts',
  indirect_attacks: 'Attacks hidden in documents',
  content_safety_blocks: 'Harmful content blocked',
  dlp_violations: 'Data policy blocks',
  spend: 'Spend vs budget',
};

/** Failing checks for one pillar, grouped by metric: worst status first, then most agents affected. */
function pillarIssues(agents, pillar) {
  const byMetric = new Map();
  agents.forEach((a) =>
    (a.metrics?.[pillar] || []).forEach((m) => {
      if (m.status !== 'red' && m.status !== 'amber') return;
      const e = byMetric.get(m.id) || { id: m.id, status: 'amber', agents: [] };
      if (m.status === 'red') e.status = 'red';
      e.agents.push({ agent: a, metric: m });
      byMetric.set(m.id, e);
    })
  );
  return [...byMetric.values()]
    .map((e) => {
      // the agent to name = the worst one for this check
      e.agents.sort((x, y) => SEVERITY_RANK[x.metric.status] - SEVERITY_RANK[y.metric.status] || (y.agent.volume || 0) - (x.agent.volume || 0));
      return e;
    })
    .sort((x, y) => SEVERITY_RANK[x.status] - SEVERITY_RANK[y.status] || y.agents.length - x.agents.length);
}

/** Portfolio figures used to fill the "why" rows when fewer than three checks are failing. */
function pillarFillers(pillar, f) {
  if (pillar === 'health') {
    return [
      { id: 'agent_availability', label: 'Messages answered', value: fmtPct(f.replyPct), status: f.replyStatus },
      { id: 'task_completion', label: 'Runs resolved', value: fmtPct(f.resolvedPct), status: f.resolvedStatus },
      { id: 'failed_execution_rate', label: 'Runs with errors', value: fmtPct(f.errorPct), status: f.errorStatus },
    ];
  }
  if (pillar === 'risk') {
    const s = (n) => (n ? 'amber' : f.engaged ? 'green' : 'unknown');
    return [
      { id: 'prompt_injection_attempts', label: 'Jailbreak attempts', value: fmtNum(f.jailbreaks), status: s(f.jailbreaks) },
      { id: 'indirect_attacks', label: 'Attacks hidden in documents', value: fmtNum(f.indirect), status: s(f.indirect) },
      { id: 'content_safety_blocks', label: 'Harmful content & policy blocks', value: fmtNum(f.contentBlocks), status: s(f.contentBlocks) },
    ];
  }
  return [
    { id: 'spend_total', label: 'Estimated spend', value: f.spend !== null ? fmtUsd(f.spend) : '—', status: '' },
    { id: 'spend', label: 'Budget used', value: f.budgetUsedPct !== null ? `${fmtPct(f.budgetUsedPct)} of ${fmtUsd(f.budgetTotal)}` : 'No budgets set', status: f.budgetUsedPct !== null ? f.budgetStatus : 'unknown' },
    { id: 'cost_per_conversation', label: 'Cost per run', value: f.costPerRun !== null ? fmtUsd(f.costPerRun) : '—', status: '' },
  ];
}

/** Pillar-specific words, so Risk never says "healthy" and Cost never says "working". */
const PILLAR_WORDS = {
  health: {
    badge: { red: 'Action required', amber: 'Watch', green: 'Working well', unknown: 'Not measured' },
    legend: { red: 'failing', amber: 'degraded', green: 'working well', unknown: 'not measured' },
    problem: { one: 'has problems', many: 'have problems' },
    allOk: 'working well',
    okSentence: 'Messages are answered, runs finish and replies arrive on time.',
  },
  risk: {
    badge: { red: 'Action required', amber: 'Watch', green: 'Safe', unknown: 'Not measured' },
    legend: { red: 'unsafe activity', amber: 'to review', green: 'safe', unknown: 'not measured' },
    problem: { one: 'shows risky activity', many: 'show risky activity' },
    allOk: 'safe',
    okSentence: 'No attacks, harmful content or data-policy blocks.',
  },
  cost: {
    badge: { red: 'Action required', amber: 'Watch', green: 'Within budget', unknown: 'Not measured' },
    legend: { red: 'over budget', amber: 'near budget', green: 'within budget', unknown: 'not measured' },
    problem: { one: 'is over or near budget', many: 'are over or near budget' },
    allOk: 'within budget',
    okSentence: 'Spend is within budget.',
  },
};

function PillarHero({ pillar, agents, statusOf, figures, scopeLabel, library, goAgents, openAgent }) {
  const meta = PILLAR_META[pillar];
  const words = PILLAR_WORDS[pillar];
  const Icon = meta.icon;
  const total = agents.length;
  const counts = countBy(agents, (a) => statusOf(a, pillar));
  const red = counts.red || 0;
  const amber = counts.amber || 0;
  const green = counts.green || 0;
  const unmeasured = counts.unknown || 0;
  const attention = red + amber;
  const measured = attention + green;
  const status = red ? 'red' : amber ? 'amber' : green ? 'green' : 'unknown';

  // Only measured agents can drive the "why" rows, so the rows always agree with the count.
  const measuredAgents = useMemo(() => agents.filter((a) => statusOf(a, pillar) !== 'unknown'), [agents, pillar, statusOf]);
  const issues = useMemo(() => pillarIssues(measuredAgents, pillar), [measuredAgents, pillar]);

  // 1. Headline — always "X of <all monitored agents>"
  let bigValue;
  let bigTone;
  let bigText;
  if (attention) {
    bigValue = attention; bigTone = red ? 'red' : 'amber';
    bigText = `of ${total} agents ${attention === 1 ? words.problem.one : words.problem.many}`;
  } else if (measured) {
    bigValue = measured; bigTone = 'green';
    bigText = `of ${total} agents ${measured === 1 ? 'is' : 'are'} ${words.allOk}`;
  } else {
    bigValue = 0; bigTone = 'unknown';
    bigText = `of ${total} agents measured`;
  }

  // 2. One sentence that explains the headline
  let sentence;
  const notMeasuredNote = unmeasured
    ? ` ${plural(unmeasured, 'other agent')} had too little activity to measure.`
    : '';
  if (issues[0]) {
    const top = issues[0];
    const { agent, metric } = top.agents[0];
    const others = top.agents.length - 1;
    sentence = {
      tone: top.status,
      text: (
        <>
          Main issue: <b>{(ISSUE_TEXT[top.id] || metric.name).toLowerCase()} {metric.value}</b> on {agent.name}
          {others > 0 ? ` and ${plural(others, 'other agent')}` : ''} <span className="ph-target">({targetText(library, top.id)})</span>
        </>
      ),
    };
  } else if (measured) {
    sentence = { tone: 'green', text: `${words.okSentence}${notMeasuredNote}` };
  } else if (pillar === 'cost' && figures.spend !== null) {
    sentence = { tone: 'unknown', text: <>No budgets are set, so spend can’t be compared to a limit. Estimated spend: <b>{fmtUsd(figures.spend)}</b>.</> };
  } else {
    sentence = { tone: 'unknown', text: 'No agent had enough activity to measure. Try a longer reporting period.' };
  }

  // 3. Supporting rows: failing checks first, then portfolio figures for measured agents
  const issueRows = issues.slice(0, 3).map((i) => {
    const { agent, metric } = i.agents[0];
    return {
      key: i.id,
      label: ISSUE_TEXT[i.id] || metric.name,
      detail: i.agents.length > 1 ? `${i.agents.length} agents · worst: ${agent.name}` : agent.name,
      value: metric.value,
      status: i.status,
      target: targetText(library, i.id),
      onClick: () => openAgent(agent.id, pillar),
    };
  });
  const used = new Set(issueRows.map((r) => r.key));
  const fillDetail = `All active agents · ${scopeLabel.toLowerCase()}`;
  const fillRows = pillarFillers(pillar, figures)
    .filter((r) => !used.has(r.id))
    .map((r) => ({ key: r.id, label: r.label, detail: fillDetail, value: r.value, status: measured ? r.status : r.status && 'unknown', target: targetText(library, r.id) }));
  const rows = [...issueRows, ...fillRows].slice(0, 3);

  const legend = ['red', 'amber', 'green', 'unknown'].filter((s) => counts[s]).map((s) => `${counts[s]} ${words.legend[s]}`);
  const flagged = measuredAgents.filter((a) => ['red', 'amber'].includes(statusOf(a, pillar)))
    .sort((x, y) => SEVERITY_RANK[statusOf(x, pillar)] - SEVERITY_RANK[statusOf(y, pillar)]);

  return (
    <article className={`pillar-hero tone-${status}`} aria-label={`${meta.name}: ${words.badge[status]}`}>
      <header className="ph-head">
        <span className="ph-icon"><Icon size={20} aria-hidden="true" /></span>
        <div className="ph-title">
          <h2>{meta.name}</h2>
          <span>{meta.question}</span>
        </div>
        <span className={`status ${status} md`} title={STATUS_MEANING[status]}><i aria-hidden="true" />{words.badge[status]}</span>
      </header>

      <div className="ph-verdict">
        <div className="ph-count">
          <b className={bigTone}>{bigValue}</b>
          <span>{bigText}</span>
        </div>
        <p className={`ph-sentence ${sentence.tone}`}>{sentence.text}</p>
      </div>

      <div className="ph-why">
        <span className="ph-label">
          {issueRows.length ? 'What needs attention' : 'Key figures'}{' '}
          <Tip text={issueRows.length
            ? 'Checks outside their limits, worst first. Select a row to open that agent’s evidence.'
            : `Combined figures for agents with enough activity in the ${scopeLabel.toLowerCase()}.`} />
        </span>
        <ul className="ph-rows">
          {rows.map((r) => {
            const Tag = r.onClick ? 'button' : 'div';
            return (
              <li key={r.key}>
                <Tag className={`ph-row ${r.onClick ? 'clickable' : ''}`} type={r.onClick ? 'button' : undefined} onClick={r.onClick}
                  title={r.onClick ? 'Open the evidence for this agent' : undefined}>
                  <i className={`dot ${r.status || 'none'}`} aria-hidden="true" />
                  <span className="ph-row-copy">
                    <span className="ph-row-label">{r.label}</span>
                    <span className="ph-row-detail">{r.detail}</span>
                  </span>
                  <span className="ph-row-value">
                    <b className={r.status || ''}>{r.value}</b>
                    {r.target && <small>{r.target}</small>}
                  </span>
                </Tag>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="ph-dist">
        <StatusSplit counts={counts} total={total} label={`${meta.name}: ${legend.join(', ')}`} />
        <span className="ph-dist-text">
          <b>{total} agents:</b> {legend.join(' · ')}
        </span>
      </div>

      <footer className="ph-foot">
        <span className="ph-who">
          {flagged.length ? (
            <>
              Start with{' '}
              <button type="button" className="link-btn inline" onClick={() => openAgent(flagged[0].id, pillar)}>{flagged[0].name}</button>
              {flagged.length > 1 && <span className="muted"> +{flagged.length - 1} more</span>}
            </>
          ) : measured ? 'Nothing to act on' : 'Nothing measured yet'}
        </span>
        <button className="link-btn" type="button" onClick={() => goAgents(attention ? { pillar, status: 'attention' } : {})}>
          View agents <ArrowRight size={13} />
        </button>
      </footer>
    </article>
  );
}

/** Secondary overall summary: equal cells, each with label · value · caption on fixed lines. */
function OverallStrip({ agents, kpis, days, goAgents, goManage }) {
  const overall = worst(agents.map((a) => a.statuses.overall));
  const healthy = agents.filter((a) => a.statuses.overall === 'green').length;
  const p = periodOf(days);
  const items = [
    { label: 'Agents monitored', value: fmtNum(kpis.monitored), caption: `${kpis.active} active in the ${p.label.toLowerCase()}`, def: KPI_DEFS.monitored, onClick: goManage },
    { label: 'Runs', value: fmtNum(kpis.runs), caption: p.label, def: KPI_DEFS.runs },
    { label: 'Need attention', value: fmtNum(kpis.attention), caption: 'Watch or action required', def: KPI_DEFS.attention, tone: kpis.attention ? 'amber' : '', onClick: () => goAgents({ status: 'attention' }) },
    { label: 'Missing details', value: fmtNum(kpis.nonCompliant), caption: 'Owners, department or approval', def: KPI_DEFS.compliance, tone: kpis.nonCompliant ? 'red' : '', onClick: () => goAgents({ nonCompliantOnly: true }) },
  ];
  return (
    <section className="overall-strip" aria-label="Overall summary" style={{ '--cells': items.length + 1 }}>
      <div className="os-cell os-overall">
        <span className="os-label">Overall status <Tip text={KPI_DEFS.overall} /></span>
        <span className="os-value"><StatusBadge value={overall} size="sm" /></span>
        <span className="os-caption">{healthy} of {plural(agents.length, 'agent')} healthy</span>
      </div>
      {items.map((it) => {
        const Tag = it.onClick ? 'button' : 'div';
        return (
          <Tag key={it.label} className={`os-cell ${it.onClick ? 'clickable' : ''}`} onClick={it.onClick} type={it.onClick ? 'button' : undefined}>
            <span className="os-label">{it.label} <Tip text={it.def} /></span>
            <span className={`os-value ${it.tone || ''}`}>{it.value}</span>
            <span className="os-caption">{it.caption}</span>
          </Tag>
        );
      })}
    </section>
  );
}


function NoAgents({ removed, goManage }) {
  return (
    <section className="empty-state panel">
      <Bot size={30} aria-hidden="true" />
      <h2>No agent has sent telemetry in the last 90 days</h2>
      <p>
        Agents appear here automatically as soon as they send telemetry to Application Insights. Check that Application Insights is connected in each agent’s
        settings in Copilot Studio (Settings → Advanced → Application Insights).
        {removed ? <> {plural(removed, 'agent was', 'agents were')} removed from monitoring and can be restored under Manage agents.</> : null}
      </p>
      <button className="primary-solid" type="button" onClick={goManage}>Go to Manage agents</button>
    </section>
  );
}

function Overview({ agents, removed, days, library, kpis, goAgents, goManage, openAgent }) {
  const active = useMemo(() => agents.filter((a) => !a.widened && a.volume > 0), [agents]);
  const figAgents = active.length ? active : agents;
  const scopeLabel = active.length ? periodOf(days).label : 'Last 90 days';
  const figures = useMemo(() => portfolioFigures(figAgents, library), [figAgents, library]);
  // One rule for all three cards: an agent counts as measured only if it was active in the
  // selected period (unless nothing was active, then the 90-day fallback is used everywhere).
  const statusOf = useCallback(
    (a, pillar) => (active.length && (a.widened || !a.volume) ? 'unknown' : a.statuses[pillar] || 'unknown'),
    [active]
  );
  const series = useMemo(() => aggregateSeries(active), [active]);
  const thresholds = library?.metrics?.find((m) => m.id === 'failed_execution_rate')?.thresholds || { green: 2, amber: 5 };
  const points = series.map((s) => ({ t: s.t, n: s.conversations, value: s.conversations ? Math.round((1000 * s.failed) / s.conversations) / 10 : null }));
  if (!agents.length) return <NoAgents removed={removed.length} goManage={goManage} />;

  const departments = (() => {
    const m = {};
    agents.forEach((a) => {
      const d = (m[a.department] ||= { name: a.department, agents: [], counts: {} });
      d.agents.push(a);
      d.counts[a.statuses.overall] = (d.counts[a.statuses.overall] || 0) + 1;
    });
    return Object.values(m).sort((x, y) => (x.name === 'Unassigned') - (y.name === 'Unassigned') || y.agents.length - x.agents.length || x.name.localeCompare(y.name));
  })();

  return (
    <>
      <section className="hero-grid" aria-label="Health, risk and cost">
        {PILLARS.map((pl) => (
          <PillarHero key={pl} pillar={pl} agents={agents} statusOf={statusOf} figures={figures} scopeLabel={scopeLabel} library={library} goAgents={goAgents} openAgent={openAgent} />
        ))}
      </section>
      {!active.length && (
        <div className="banner info" role="status">
          <History size={16} /> No agent was active in the {periodOf(days).label.toLowerCase()}, so all figures show each agent’s most recent 90 days.
        </div>
      )}

      <OverallStrip agents={agents} kpis={kpis} days={days} goAgents={goAgents} goManage={goManage} />

      <div className="chart-grid">
        <Panel title="Conversations & runs over time" subtitle={`Per ${days === 1 ? 'hour' : 'day'}, all agents active in the ${periodOf(days).label.toLowerCase()}`} tip="Each bar is one hour or day. Colours show how those conversations and runs ended.">
          <VolumeChart series={series} days={days} title="Conversations and runs over time" />
        </Panel>
        <Panel title="Runs with errors" subtitle="Share of conversations and runs that hit a runtime error" helpSection="health"
          tip="Same limits as the “Runs with errors” health metric. Safety blocks are excluded and reported under Risk.">
          <TrendChart points={points} thresholds={thresholds} days={days} title="Runs with errors over time" xTitle={days === 1 ? 'Hour (your local time)' : 'Day'}
            yTitle="% of runs with an error" seriesLabel="% of runs with an error" />
        </Panel>
      </div>

      <Panel title="Status by department" subtitle="Overall status of monitored agents. Select a department to see its agents. Set departments under Manage agents." right={<Legend items={STATUS_LEGEND} title="Status colours" />}>
        <table className="table dept-table">
          <thead>
            <tr>
              <th scope="col">Department</th>
              <th scope="col" className="num">Agents</th>
              <th scope="col" className="wide">Agents by status</th>
              <th scope="col" className="num">Need attention</th>
              <th scope="col"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d.name} tabIndex={0} onClick={() => goAgents({ department: d.name })} onKeyDown={(e) => e.key === 'Enter' && goAgents({ department: d.name })}>
                <td><b>{d.name}</b></td>
                <td className="num">{d.agents.length}</td>
                <td><StatusSplit counts={d.counts} total={d.agents.length} label={`${d.name} agents by status`} /></td>
                <td className="num">{(d.counts.red || 0) + (d.counts.amber || 0)}</td>
                <td className="row-go"><ChevronRight size={16} aria-hidden="true" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="All agents" subtitle="Worst first. Select a row to see the evidence.">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Used in</th>
                <th scope="col" className="num">Runs</th>
                <th scope="col">Last activity</th>
                {PILLARS.map((pl) => <th key={pl} scope="col">{PILLAR_META[pl].name}</th>)}
                <th scope="col">Overall</th>
                <th scope="col">Main issue</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} onClick={() => openAgent(a.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && openAgent(a.id)}>
                  <td><b>{a.name}</b>{a.widened && <span className="block"><WidenedTag agent={a} compact /></span>}</td>
                  <td>{a.environment}</td>
                  <td className="num">{fmtNum(a.volume)}</td>
                  <td>{relTime(a.lastSeen)}</td>
                  {PILLARS.map((pl) => <td key={pl}><StatusBadge value={a.statuses[pl]} size="sm" /></td>)}
                  <td><StatusBadge value={a.statuses.overall} size="sm" /></td>
                  <td className="issue">{a.alerts[0] ? <><b>{a.alerts[0].metric}</b> {a.alerts[0].value}</> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

/* ================================================================ agents tab */
const EMPTY_FILTERS = { status: 'all', pillar: 'overall', environment: 'all', department: 'all', location: 'all', owner: 'all', platform: 'all', riskTier: 'all', nonCompliantOnly: false, widenedOnly: false, query: '' };

function applyFilters(agents, f) {
  const q = f.query.trim().toLowerCase();
  return agents.filter((a) => {
    const s = a.statuses[f.pillar] || a.statuses.overall;
    if (f.status === 'attention' && !['red', 'amber'].includes(s)) return false;
    if (!['all', 'attention'].includes(f.status) && s !== f.status) return false;
    if (f.environment !== 'all' && a.environment !== f.environment) return false;
    for (const field of ['department', 'location', 'owner', 'platform', 'riskTier']) {
      if (f[field] !== 'all' && fieldValue(a, field) !== f[field]) return false;
    }
    if (f.nonCompliantOnly && a.compliant) return false;
    if (f.widenedOnly && !a.widened) return false;
    if (q && !`${a.name} ${a.purpose || ''} ${a.department} ${a.businessOwner || ''} ${a.technicalOwner || ''} ${(a.telemetryNames || []).join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function AgentCard({ agent, openAgent }) {
  const open = () => openAgent(agent.id);
  return (
    <article className={`agent-card edge-${agent.statuses.overall}`} onClick={open} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()} aria-label={`${agent.name}, ${STATUS_LABELS[agent.statuses.overall]}`}>
      <div className="agent-top">
        <div className="agent-icon" aria-hidden="true"><Bot size={18} /></div>
        <div className="agent-title">
          <h4>{agent.name}</h4>
          <span>{agent.platform} · {agent.environment}</span>
        </div>
        <StatusBadge value={agent.statuses.overall} size="sm" />
      </div>
      {agent.widened && <WidenedTag agent={agent} />}
      <p className="purpose">{agent.purpose || <em>No purpose recorded — add it under Manage agents.</em>}</p>
      <p className={`headline ${agent.statuses.overall}`}>{agentHeadline(agent)}</p>
      <div className="pillar-row" role="group" aria-label="Status by area">
        {PILLARS.map((p) => {
          const Icon = PILLAR_META[p].icon;
          return (
            <button key={p} className={`pillar-chip ${agent.statuses[p]}`} type="button" onClick={(e) => { e.stopPropagation(); openAgent(agent.id, p); }} title={`Open ${PILLAR_META[p].name} evidence`}>
              <span className="pc-name"><Icon size={13} aria-hidden="true" /> {PILLAR_META[p].name}</span>
              <span className="pc-status"><i aria-hidden="true" />{STATUS_LABELS[agent.statuses[p]]}</span>
            </button>
          );
        })}
      </div>
      <dl className="agent-meta">
        <div><dt>Runs{agent.widened ? ` (${agent.dataDays} days)` : ''}</dt><dd>{fmtNum(agent.volume)}{agent.autoRuns ? <small className="muted"> · {fmtNum(agent.autoRuns)} automatic</small> : null}</dd></div>
        <div><dt>Last activity</dt><dd>{relTime(agent.lastSeen)}</dd></div>
        <div><dt>Business owner</dt><dd>{agent.businessOwner || <em>Not assigned</em>}</dd></div>
        <div><dt>Est. spend</dt><dd>{agent.billing === 'included' ? 'Included' : agent.spendUsd !== null ? fmtUsd(agent.spendUsd) : '—'}</dd></div>
      </dl>
      <footer>
        {agent.compliant ? (
          <span className="comp ok"><CheckCircle2 size={14} /> In AI policy</span>
        ) : (
          <span className="comp bad"><XCircle size={14} /> Missing details: {agent.compliance.filter((c) => !c.pass).length} check(s)</span>
        )}
        <span className="open-hint">Open <ChevronRight size={14} /></span>
      </footer>
    </article>
  );
}

function Agents({ agents, filters, setFilters, groupBy, setGroupBy, openAgent, goManage }) {
  const [collapsed, setCollapsed] = useState({});
  const [more, setMore] = useState(false);
  const opts = (field, allLabel = 'All') => [{ value: 'all', label: allLabel }, ...[...new Set(agents.map((a) => fieldValue(a, field)))].sort().map((v) => ({ value: v, label: v }))];
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const shown = useMemo(() => applyFilters(agents, filters), [agents, filters]);
  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ name: 'All agents', agents: shown }];
    const m = {};
    shown.forEach((a) => (m[fieldValue(a, groupBy)] ||= []).push(a));
    return Object.entries(m)
      .sort((x, y) => (x[0] === 'Unassigned') - (y[0] === 'Unassigned') || y[1].length - x[1].length || x[0].localeCompare(y[0]))
      .map(([name, list]) => ({ name, agents: list }));
  }, [shown, groupBy]);

  if (!agents.length) {
    return <div className="chart-empty">No agent has sent telemetry in the last 90 days. <button className="link-btn" type="button" onClick={goManage}>Go to Manage agents</button></div>;
  }

  const active = Object.entries(filters).filter(([k, v]) => v !== EMPTY_FILTERS[k] && k !== 'pillar');
  const describe = ([k, v]) => {
    if (k === 'status') return `${filters.pillar !== 'overall' ? PILLAR_META[filters.pillar].name : 'Status'}: ${v === 'attention' ? 'Need attention' : STATUS_LABELS[v]}`;
    if (k === 'nonCompliantOnly') return 'Out of AI policy only';
    if (k === 'widenedOnly') return 'Quiet agents (last 90 days)';
    if (k === 'query') return `Search: “${v}”`;
    const names = { environment: 'Used in', department: 'Department', location: 'Location', owner: 'Owner', platform: 'Platform', riskTier: 'Risk tier' };
    return `${names[k]}: ${v}`;
  };

  return (
    <>
      <section className="filters panel" aria-label="Filters">
        <div className="filter-grid">
          <label className="field search-field">
            <span className="field-label">Search agents</span>
            <span className="search">
              <Search size={15} aria-hidden="true" />
              <input value={filters.query} onChange={(e) => set({ query: e.target.value })} placeholder="Name, purpose, owner or telemetry ID" />
              {filters.query && <button type="button" className="clear" onClick={() => set({ query: '' })} aria-label="Clear search"><X size={14} /></button>}
            </span>
          </label>
          <SelectField label="Status" tip="Overall status = the worst of Health, Risk and Cost." value={filters.status} onChange={(v) => set({ status: v })}
            options={[{ value: 'all', label: 'All statuses' }, { value: 'attention', label: 'Need attention' }, ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s] }))]} />
          <SelectField label="Status of" value={filters.pillar} onChange={(v) => set({ pillar: v })} options={[{ value: 'overall', label: 'Overall' }, ...PILLARS.map((p) => ({ value: p, label: PILLAR_META[p].name }))]} />
          <SelectField label="Department" value={filters.department} onChange={(v) => set({ department: v })} options={opts('department', 'All departments')} />
          <SelectField label="Used in" tip="Production = real users. Test only = Copilot Studio test pane traffic." value={filters.environment} onChange={(v) => set({ environment: v })}
            options={[{ value: 'all', label: 'All' }, ...ENVIRONMENTS.map((e) => ({ value: e, label: e }))]} />
        </div>
        <div className="filter-actions">
          <button className="ghost-btn small" type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}>
            <SlidersHorizontal size={14} /> {more ? 'Fewer filters' : 'More filters'}
          </button>
          <label className="check">
            <input type="checkbox" checked={filters.nonCompliantOnly} onChange={(e) => set({ nonCompliantOnly: e.target.checked })} />
            Out of AI policy only
          </label>
          <SelectField label="Group by" value={groupBy} onChange={setGroupBy} options={Object.entries(GROUP_FIELDS).map(([value, label]) => ({ value, label }))} />
          <button className="ghost-btn small" type="button" onClick={() => setFilters(EMPTY_FILTERS)} disabled={!active.length}>Reset filters</button>
        </div>
        {more && (
          <div className="filter-grid more">
            <SelectField label="Location" value={filters.location} onChange={(v) => set({ location: v })} options={opts('location', 'All locations')} />
            <SelectField label="Business owner" value={filters.owner} onChange={(v) => set({ owner: v })} options={opts('owner', 'All owners')} />
            <SelectField label="Platform" value={filters.platform} onChange={(v) => set({ platform: v })} options={opts('platform', 'All platforms')} />
            <SelectField label="Risk tier" value={filters.riskTier} onChange={(v) => set({ riskTier: v })} options={opts('riskTier', 'All tiers')} />
          </div>
        )}
      </section>

      <div className="result-line" aria-live="polite">
        Showing <b>{shown.length}</b> of {plural(agents.length, 'monitored agent')}
        {groupBy !== 'none' && <> in {plural(groups.length, 'group')}</>}
        {active.length > 0 && (
          <span className="active-filters">
            {active.map((f) => (
              <button key={f[0]} type="button" className="chip on" onClick={() => set({ [f[0]]: EMPTY_FILTERS[f[0]], ...(f[0] === 'status' ? { pillar: 'overall' } : {}) })} title="Remove filter">
                {describe(f)} <X size={12} />
              </button>
            ))}
          </span>
        )}
      </div>

      {groups.map((g) => {
        const counts = countBy(g.agents, (a) => a.statuses.overall);
        const isCollapsed = collapsed[g.name];
        return (
          <section key={g.name} className="group">
            <button className="group-head" type="button" onClick={() => setCollapsed((c) => ({ ...c, [g.name]: !c[g.name] }))} aria-expanded={!isCollapsed}>
              {groupBy !== 'none' && <span className="level">{GROUP_FIELDS[groupBy]}</span>}
              <b>{g.name}</b>
              <span className="muted">{plural(g.agents.length, 'agent')}</span>
              <span className="group-counts">
                {STATUS_ORDER.map((s) => (counts[s] ? <span key={s} className={`dot-count ${s}`}><i aria-hidden="true" />{counts[s]} {STATUS_LABELS[s]}</span> : null))}
              </span>
              <ChevronDown size={16} className={`caret ${isCollapsed ? 'closed' : ''}`} aria-hidden="true" />
            </button>
            {!isCollapsed && <div className="agent-grid">{g.agents.map((a) => <AgentCard key={a.id} agent={a} openAgent={openAgent} />)}</div>}
          </section>
        );
      })}
      {!shown.length && <div className="chart-empty">No agents match these filters. <button className="link-btn" type="button" onClick={() => setFilters(EMPTY_FILTERS)}>Reset filters</button></div>}
    </>
  );
}

/* ================================================================= agent view */
function MetricRow({ metric }) {
  return (
    <div className={`metric-row ${metric.status}`}>
      <div className="metric-status"><StatusBadge value={metric.status} size="sm" /></div>
      <div className="metric-copy">
        <b>{metric.name}</b>
        <span className="plain">{metric.plain}</span>
        {metric.why && <small>{metric.why}</small>}
        <details>
          <summary>How is this measured?</summary>
          <p>{metric.description}</p>
          <p className="source">Source: {metric.source}</p>
        </details>
      </div>
      <div className="metric-value">
        <span className="mv-label">Value</span>
        <b>{metric.value}</b>
        <span className="mv-label">Limits</span>
        <span className="mv-limit">{metric.threshold}</span>
      </div>
    </div>
  );
}

function AgentDetail({ agent, pillar, setPillar, back, library, canEdit, onEdit, onRemove }) {
  const { openHelp } = useApp();
  const metrics = agent.metrics[pillar] || [];
  const shown = metrics.filter((m) => m.value !== 'Not available');
  const unavailable = metrics.filter((m) => m.value === 'Not available');
  const components = library?.healthComponents || {};
  const grouped =
    pillar === 'health'
      ? Object.entries(components).map(([key, label]) => ({ key, label, rows: shown.filter((m) => m.component === key) })).filter((g) => g.rows.length)
      : [{ key: 'all', label: null, rows: shown }];
  const facts = [
    ['Telemetry ID', agent.id],
    ['Department', agent.department],
    ['Used in', agent.environment],
    ['Risk tier', agent.riskTier || 'Not assigned'],
    ['Approval', agent.approvalStatus || 'None'],
    ['Business owner', agent.businessOwner || 'Not assigned'],
    ['Technical owner', agent.technicalOwner || 'Not assigned'],
    ['Last activity', relTime(agent.lastSeen)],
  ];
  const days = agent.dataDays;
  return (
    <>
      <div className="detail-actions">
        <button className="back" onClick={back} type="button"><ArrowLeft size={15} /> Back</button>
        {canEdit && (
          <span className="spacer-actions">
            <button className="back" type="button" onClick={() => onEdit(agent)}><Pencil size={14} /> Edit details</button>
            <button className="back danger" type="button" onClick={() => onRemove(agent)}><EyeOff size={14} /> Stop monitoring</button>
          </span>
        )}
      </div>
      <section className={`agent-hero edge-${agent.statuses.overall}`}>
        <div className="ah-main">
          <span className="eyebrow">{agent.platform}</span>
          <h2>{agent.name}</h2>
          <p>{agent.purpose || 'No purpose recorded yet — select Edit details to add it.'}</p>
        </div>
        <div className="ah-status">
          <span className="field-label">Overall status</span>
          <StatusBadge value={agent.statuses.overall} />
          <span className="field-label">AI policy</span>
          {agent.compliant ? <span className="comp ok pill"><CheckCircle2 size={14} /> In policy</span> : <span className="comp bad pill"><XCircle size={14} /> Missing details</span>}
        </div>
        {agent.widened && <p className="widened-hero"><History size={14} /> {widenedText(agent)}.</p>}
        <p className={`headline big ${agent.statuses.overall}`}>
          <b>{STATUS_LABELS[agent.statuses.overall]}:</b> {agentHeadline(agent)}
        </p>
        <dl className="facts">
          {facts.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      </section>

      <div className="pillar-tabs" role="tablist" aria-label="Evidence area">
        {PILLARS.map((p) => {
          const Icon = PILLAR_META[p].icon;
          const n = agent.metrics[p].filter((m) => m.measured).length;
          return (
            <button key={p} type="button" role="tab" aria-selected={pillar === p} className={pillar === p ? 'active' : ''} onClick={() => setPillar(p)}>
              <Icon size={22} aria-hidden="true" />
              <span className="pt-copy">
                <b>{PILLAR_META[p].name}</b>
                <small>{PILLAR_META[p].question} · {n} of {agent.metrics[p].length} rated</small>
              </span>
              <StatusBadge value={agent.statuses[p]} />
            </button>
          );
        })}
      </div>

      <div className="detail-grid">
        <Panel title={`${PILLAR_META[pillar].name} evidence`} subtitle={`${library?.pillars?.[pillar]?.definition || ''} Figures cover the last ${days === 1 ? '24 hours' : `${days} days`}.`}
          right={<StatusBadge value={agent.statuses[pillar]} />} helpSection={pillar}>
          {grouped.map((g) => (
            <div key={g.key} className="component">
              {g.label && (
                <div className="component-head">
                  <span>{g.label}</span>
                  <StatusBadge value={worst(g.rows.map((r) => r.status))} size="sm" />
                </div>
              )}
              {g.rows.map((m) => <MetricRow key={m.id} metric={m} />)}
            </div>
          ))}
          {!shown.length && <div className="chart-empty">No figures in this area for this agent.</div>}
          {unavailable.length > 0 && (
            <details className="unmeasured">
              <summary>Not available yet ({unavailable.length}) — why</summary>
              <ul>{unavailable.map((m) => <li key={m.id}><b>{m.name}</b> — {m.why}</li>)}</ul>
              <button className="link-btn" type="button" onClick={() => openHelp('data')}>Where does the data come from?</button>
            </details>
          )}
        </Panel>

        <div className="side">
          <Panel title="Activity" subtitle={`Per ${days === 1 ? 'hour' : 'day'} · last ${days === 1 ? '24 hours' : `${days} days`}`}>
            <VolumeChart series={agent.series} days={days} title={`${agent.name} activity over time`} compact />
            <dl className="stat-strip">
              <div><dt>Runs</dt><dd>{fmtNum(agent.volume)}</dd></div>
              <div><dt>Automatic runs</dt><dd>{fmtNum(agent.autoRuns)}</dd></div>
              <div><dt>User messages</dt><dd>{fmtNum(agent.userTurns)}</dd></div>
              <div><dt>Error events</dt><dd>{fmtNum(agent.errorEvents)}</dd></div>
              <div><dt>{agent.billing === 'tokens' ? 'Tokens' : 'Copilot Credits (est.)'}</dt><dd>{agent.billing === 'tokens' ? fmtNum(agent.tokens) : agent.billing === 'included' ? 'Included' : fmtNum(agent.credits)}</dd></div>
              <div><dt>Est. spend</dt><dd>{agent.billing === 'included' ? 'Included' : fmtUsd(agent.spendUsd)}</dd></div>
            </dl>
          </Panel>
          <Panel title="AI policy checks" helpSection="policy" tip="Automatic: telemetry compared with the agent details. Fix by selecting Edit details.">
            <ul className="checks">
              {agent.compliance.map((c) => (
                <li key={c.id} className={c.pass ? 'ok' : 'bad'}>
                  {c.pass ? <CheckCircle2 size={16} aria-label="Pass" /> : <XCircle size={16} aria-label="Fail" />}
                  <div><b>{c.name}</b><span>{c.pass ? 'Pass' : 'Fail'} · {c.detail}</span></div>
                </li>
              ))}
            </ul>
          </Panel>
          {agent.topErrorCodes?.length > 0 && (
            <Panel title="Most frequent error codes" tip="Error codes recorded by the platform in the period.">
              <table className="table compact">
                <thead><tr><th scope="col">Code</th><th scope="col">Meaning</th><th scope="col" className="num">Count</th></tr></thead>
                <tbody>
                  {agent.topErrorCodes.map((c) => (
                    <tr key={c.code}><td><code>{c.code}</code></td><td>{ERROR_HELP[c.code] || 'See the Copilot Studio error-code reference'}</td><td className="num">{fmtNum(c.count)}</td></tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
          <Panel title="Telemetry names" tip="Names this agent appears under in Application Insights. Add extra names under Edit details so they are counted as one agent.">
            <div className="codes">{(agent.telemetryNames || [agent.id]).map((n) => <code key={n}>{n}</code>)}</div>
          </Panel>
        </div>
      </div>
    </>
  );
}

/* ============================================================ manage agents */
const EMPTY_PROFILE = {
  id: '', displayName: '', aliases: [], purpose: '', department: '', location: '', businessOwner: '', technicalOwner: '',
  platform: '', riskTier: '', approvalStatus: '', productionSince: '', monthlyBudgetUsd: '', billingModel: '',
  creditsPerResponse: '', allowedConnectors: [],
};

function FormField({ label, hint, required, wide, children }) {
  return (
    <label className={`form-field ${wide ? 'wide' : ''}`}>
      <span className="field-label">{label}{required && <span className="req" aria-hidden="true"> *</span>}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function AgentForm({ initial, mode, onCancel, onSave, departments }) {
  const [v, setV] = useState(() => ({
    ...EMPTY_PROFILE,
    ...Object.fromEntries(Object.entries(initial || {}).filter(([, x]) => x !== null && x !== undefined)),
    aliases: (initial?.aliases || []).join(', '),
    allowedConnectors: (initial?.allowedConnectors || []).join(', '),
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const editing = mode === 'edit';

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(v);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-wrap" role="dialog" aria-modal="true" aria-label={editing ? 'Edit agent details' : 'Add agent'} onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="modal" onSubmit={submit}>
        <header className="modal-head">
          <div>
            <h2>{editing ? `Edit details · ${initial.displayName || initial.id}` : 'Add an agent by hand'}</h2>
            <p>
              {editing
                ? 'All fields are optional. They add context and drive the AI policy checks and the Cost rating.'
                : 'Only needed for an agent that has not sent telemetry yet. Agents that send telemetry appear automatically.'}
            </p>
          </div>
          <button type="button" className="icon" onClick={onCancel} aria-label="Close"><X size={20} /></button>
        </header>
        <div className="modal-body">
          <fieldset>
            <legend>Identity</legend>
            <div className="form-grid">
              <FormField label="Telemetry ID" required={!editing} hint="Schema name exactly as in Application Insights (e.g. sps_dailyCyberPrivacyBriefing).">
                <input value={v.id} onChange={set('id')} required readOnly={editing} />
              </FormField>
              <FormField label="Display name" hint="Name shown on the dashboard.">
                <input value={v.displayName} onChange={set('displayName')} placeholder="e.g. Daily Cyber Privacy Briefing" />
              </FormField>
              <FormField label="Other telemetry names" wide hint="Comma-separated. Other names this agent appears under, so its activity is counted as one agent.">
                <input value={v.aliases} onChange={set('aliases')} />
              </FormField>
            </div>
          </fieldset>
          <fieldset>
            <legend>Ownership and purpose</legend>
            <div className="form-grid">
              <FormField label="Purpose" wide>
                <textarea rows={2} value={v.purpose} onChange={set('purpose')} placeholder="What the agent does, in one sentence" />
              </FormField>
              <FormField label="Department">
                <input list="dept-list" value={v.department} onChange={set('department')} />
                <datalist id="dept-list">{departments.map((d) => <option key={d} value={d} />)}</datalist>
              </FormField>
              <FormField label="Location"><input value={v.location} onChange={set('location')} /></FormField>
              <FormField label="Business owner"><input value={v.businessOwner} onChange={set('businessOwner')} /></FormField>
              <FormField label="Technical owner"><input value={v.technicalOwner} onChange={set('technicalOwner')} /></FormField>
            </div>
          </fieldset>
          <fieldset>
            <legend>Governance</legend>
            <div className="form-grid">
              <FormField label="Risk tier">
                <select value={v.riskTier} onChange={set('riskTier')}><option value="">Not assigned</option><option>Low</option><option>Medium</option><option>High</option></select>
              </FormField>
              <FormField label="Approval status" hint="Production use requires “Approved” to pass the AI policy check.">
                <select value={v.approvalStatus} onChange={set('approvalStatus')}>
                  <option value="">None</option><option>Approved</option><option>In review</option><option>Rejected</option><option>Retired</option>
                </select>
              </FormField>
              <FormField label="In production since"><input type="date" value={v.productionSince} onChange={set('productionSince')} /></FormField>
              <FormField label="Platform">
                <select value={v.platform} onChange={set('platform')}>
                  <option value="">Automatic</option><option>Microsoft Copilot Studio</option><option>Azure AI Foundry</option><option>Custom / SDK</option>
                </select>
              </FormField>
              <FormField label="Allowed connectors" wide hint="Comma-separated, e.g. SharePoint, Workday."><input value={v.allowedConnectors} onChange={set('allowedConnectors')} /></FormField>
            </div>
          </fieldset>
          <fieldset>
            <legend>Cost</legend>
            <div className="form-grid">
              <FormField label="Monthly budget (USD)" hint="Needed to rate Cost. Pro-rated to the reporting period.">
                <input type="number" min={0} step="any" value={v.monthlyBudgetUsd} onChange={set('monthlyBudgetUsd')} />
              </FormField>
              <FormField label="Billing model">
                <select value={v.billingModel} onChange={set('billingModel')}>
                  <option value="">Automatic (by platform)</option>
                  <option value="copilot-credits">Copilot Credits</option>
                  <option value="m365-copilot">Included in Microsoft 365 Copilot licences</option>
                  <option value="tokens">Model tokens (Foundry / SDK)</option>
                </select>
              </FormField>
              <FormField label="Copilot Credits per response" hint="Classic answer 1 · generative answer 2 (default) · agent action 5 · tenant graph grounding 10.">
                <input type="number" min={0} step="any" value={v.creditsPerResponse} onChange={set('creditsPerResponse')} />
              </FormField>
            </div>
          </fieldset>
        </div>
        {error && <div className="form-error" role="alert"><AlertTriangle size={15} /> {error}</div>}
        <footer className="modal-foot">
          <button type="button" className="ghost-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary-solid" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save details' : 'Add agent'}</button>
        </footer>
      </form>
    </div>
  );
}

function Manage({ agents, removed, payload, mode, onAdd, onEdit, onRemove, onRestore, openAgent, busy }) {
  const storage = payload?.sources?.registry;
  const readOnly = mode !== 'live';
  const [q, setQ] = useState('');
  const shown = agents.filter((a) => !q || `${a.name} ${a.id} ${a.department}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <section className="intro">
        <h2>Manage agents</h2>
        <p>
          Every agent that sends telemetry to Application Insights is <b>monitored automatically</b> — there is nothing to connect. Use this page to add details
          (name, purpose, department, owners, risk tier, budget) or to stop monitoring an agent you don’t need, such as a test agent.
        </p>
        {readOnly && <div className="warn"><Info size={15} /> Demo data is read-only. Switch to live data to make changes.</div>}
        {storage?.warning && <div className="warn"><AlertTriangle size={15} /> {storage.warning}</div>}
      </section>

      <Panel
        title={`Monitored agents (${agents.length})`}
        subtitle="Agents seen in the last 90 days, plus any added by hand."
        right={
          <div className="manage-tools">
            <span className="search small-search">
              <Search size={14} aria-hidden="true" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter agents" aria-label="Filter agents" />
            </span>
            {!readOnly && <button className="ghost-btn" type="button" onClick={onAdd}><Plus size={15} /> Add by hand</button>}
          </div>
        }
      >
        {agents.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Telemetry ID</th>
                  <th scope="col">Department</th>
                  <th scope="col">Business owner</th>
                  <th scope="col">Last activity</th>
                  <th scope="col">Details</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const missing = a.compliance.filter((c) => !c.pass).length;
                  return (
                    <tr key={a.id}>
                      <td><button className="link-btn strong" type="button" onClick={() => openAgent(a.id)}>{a.name}</button></td>
                      <td><code>{a.id}</code></td>
                      <td>{a.department}</td>
                      <td>{a.businessOwner || <em className="missing">Not assigned</em>}</td>
                      <td>{relTime(a.lastSeen)}</td>
                      <td>{missing ? <span className="comp bad"><XCircle size={14} /> {missing} missing</span> : <span className="comp ok"><CheckCircle2 size={14} /> Complete</span>}</td>
                      <td className="row-actions">
                        {!readOnly && (
                          <>
                            <button className="ghost-btn small" type="button" onClick={() => onEdit(a)}><Pencil size={14} /> Edit details</button>
                            <button className="icon-btn danger" type="button" onClick={() => onRemove(a)} title={`Stop monitoring ${a.name}`} aria-label={`Stop monitoring ${a.name}`} disabled={busy}><EyeOff size={15} /></button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="chart-empty">No agent has sent telemetry in the last 90 days.</div>
        )}
      </Panel>

      {removed.length > 0 && (
        <Panel title={`Not monitored (${removed.length})`} subtitle="Agents you stopped monitoring. Their telemetry is kept; restore them at any time.">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th scope="col">Agent</th><th scope="col">Telemetry ID</th><th scope="col" className="num">Runs (90 days)</th><th scope="col">Last activity</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {removed.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.name}</b></td>
                    <td><code>{r.id}</code></td>
                    <td className="num">{fmtNum(r.runs)}</td>
                    <td>{relTime(r.lastSeen)}</td>
                    <td className="row-actions">{!readOnly && <button className="ghost-btn small" type="button" disabled={busy} onClick={() => onRestore(r)}><RotateCcw size={14} /> Monitor again</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}

/* =============================================================== library tab */
const AVAIL_LABEL = { live: 'Measured today', conditional: 'When source connected', 'not-available': 'Not yet available' };

function Library({ library }) {
  const [pillar, setPillar] = useState('all');
  if (!library) return <div className="chart-empty">The metric library loads with the data.</div>;
  const rows = library.metrics.filter((m) => pillar === 'all' || m.pillar === pillar);
  const counts = countBy(library.metrics, (m) => m.availability);
  return (
    <>
      <section className="intro">
        <h2>How each status is worked out</h2>
        <p>
          One shared rulebook sits behind every colour on this dashboard. Each metric is compared with fixed limits to give <b>Healthy</b>, <b>Watch</b> or <b>Action required</b>.
          Health, Risk and Cost each take the worst of their metrics; the overall status takes the worst of the three. Metrics with too little activity still show their
          figures but are marked <b>No data</b> and never counted as healthy.
        </p>
        <p className="muted">{counts.live || 0} metrics measured today · {counts.conditional || 0} when their source is connected · {counts['not-available'] || 0} defined and waiting for a data source.</p>
      </section>
      <Panel title="Metric library" helpSection="health" right={<Segmented label="Area" value={pillar} onChange={setPillar} options={[{ value: 'all', label: 'All areas' }, ...PILLARS.map((p) => ({ value: p, label: PILLAR_META[p].name }))]} />}>
        <div className="table-wrap">
          <table className="table lib">
            <thead>
              <tr>
                <th scope="col">Area</th><th scope="col">Metric</th><th scope="col">What it tells you</th><th scope="col">How it’s calculated</th><th scope="col">Limits</th><th scope="col">Why these limits</th><th scope="col">Data</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td><span className="level">{library.pillars[m.pillar].name}</span></td>
                  <td><b>{m.name}</b><small className="muted block">{library.healthComponents[m.component] || m.component}</small></td>
                  <td>{m.definition}</td>
                  <td><code className="block">{m.formula}</code><small className="muted block">{m.source}</small></td>
                  <td>{m.threshold}</td>
                  <td className="muted">{m.basis || '—'}</td>
                  <td><span className={`avail ${m.availability}`}>{AVAIL_LABEL[m.availability]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="AI policy checks" subtitle="Drive the “Out of AI policy” figure. Evaluated automatically from the agent details.">
        <table className="table">
          <thead><tr><th scope="col">Check</th><th scope="col">Rule</th></tr></thead>
          <tbody>{library.compliance.map((c) => <tr key={c.id}><td><b>{c.name}</b></td><td>{c.definition}</td></tr>)}</tbody>
        </table>
      </Panel>
    </>
  );
}

/* =============================================================== data sources */
function DataSources({ payload, agents, removed, mode }) {
  const s = payload?.sources || {};
  const rows = [
    ['Data as of', fmtDateTime(payload?.generatedAt)],
    ['Data mode', mode === 'live' ? 'Live telemetry' : mode === 'demo' ? 'Demo data (synthetic, not live)' : 'Unavailable'],
    ['Reporting period', payload?.window ? `${fmtDateTime(payload.window.start)} → ${fmtDateTime(payload.window.end)}` : '—'],
    ['Agents found from', `Telemetry in the last ${payload?.extendedDays || 90} days`],
    ['Telemetry source', s.telemetry || '—'],
    ['Agents monitored', fmtNum(agents.length)],
    ['…active in the period', fmtNum(agents.filter((a) => !a.widened && a.volume > 0).length)],
    ['…shown from last 90 days', fmtNum(agents.filter((a) => a.widened).length)],
    ['Not monitored (removed)', fmtNum(removed.length)],
    ['Agent details stored in', s.registry?.label || '—'],
    ['Agents with saved details', fmtNum(s.savedProfiles ?? 0)],
    ['AI inventory (optional)', s.inventoryLabel || '—'],
    ['Token telemetry (Foundry)', s.costTelemetry || '—'],
    ['Pricing', s.pricing || '—'],
    ['Slow-reply limit', s.slowReplySeconds ? `${s.slowReplySeconds} seconds` : '—'],
    ['Query time', payload?.queryMs ? `${(payload.queryMs / 1000).toFixed(1)} s${payload.cached ? ' (served from 1-minute cache)' : ''}` : '—'],
  ];
  return (
    <div className="checks-grid">
      <Panel title="What was loaded" subtitle="Sources and counts behind every page.">
        {s.registry?.warning && <div className="warn"><AlertTriangle size={15} /> {s.registry.warning}</div>}
        {s.inventory === 'error' && <div className="warn"><AlertTriangle size={15} /> The optional AI inventory could not be loaded ({s.inventoryLabel}).</div>}
        <dl className="kv">{rows.map(([k, v]) => (<React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>))}</dl>
        {s.aliasClashes?.length > 0 && (
          <>
            <h4 className="mini-head">Names used by more than one agent</h4>
            <div className="codes">{s.aliasClashes.map((n) => <code key={n}>{n}</code>)}</div>
          </>
        )}
      </Panel>
      <Panel title="How the figures are built" subtitle="Method notes for executive reporting." helpSection="data">
        <div className="method">
          <p><b>Which agents.</b> Every agent that sent telemetry in the last 90 days is monitored automatically. Agents you stop monitoring are listed separately and can be restored.</p>
          <p><b>Quiet agents.</b> If an agent had no activity in the selected period, its figures use its most recent 90 days instead and are labelled “Last 90 days”. Portfolio totals on the Overview only include agents active in the selected period.</p>
          <p><b>Agent identity.</b> Every conversation is assigned to exactly one agent by its topic schema name (stable across renames), else its bot name.</p>
          <p><b>Runs.</b> Chat conversations where a user sent a message, plus automatic runs started by a trigger or schedule. Greeting-only sessions are not counted.</p>
          <p><b>Statuses.</b> Each metric is rated against the limits in the metric library. Health, Risk and Cost take their worst metric; the overall status takes the worst of the three. With too little activity, figures are still shown but the status is “No data”.</p>
          <p><b>Risk.</b> Responsible AI blocks read from error sub-codes: jailbreaks, attacks in documents, harmful content and DLP blocks.</p>
          <p><b>Cost.</b> Copilot Studio: (chat replies + automatic runs) × credits per response × price per credit — an estimate; the billed figure is in the Power Platform admin center. Foundry: tokens × model price. Cost is rated only when a monthly budget is set.</p>
        </div>
      </Panel>
    </div>
  );
}

/* ======================================================================== app */
function readHash() {
  const [, tab, id, pillar] = (window.location.hash || '').split('/');
  return { tab: TABS.some((t) => t.id === tab) ? tab : 'overview', id: id ? decodeURIComponent(id) : null, pillar: PILLARS.includes(pillar) ? pillar : 'health' };
}

async function api(url, options = {}) {
  const res = await fetch(url, { cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message || `The service returned ${res.status}`);
  return body;
}

function App() {
  const initial = readHash();
  const [payload, setPayload] = useState(null);
  const [mode, setMode] = useState('loading');
  const [source, setSource] = useState('live');
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(null);
  const [days, setDays] = useState(7);
  const [tab, setTab] = useState(initial.tab);
  const [selected, setSelected] = useState(initial.id && initial.tab === 'agents' ? { id: initial.id, pillar: initial.pillar } : null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [groupBy, setGroupBy] = useState('department');
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [helpSection, setHelpSection] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('agent-theme') || 'light');
  const [form, setForm] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const reqId = useRef(0);
  const abortRef = useRef(null);
  const hasData = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('agent-theme', theme);
  }, [theme]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '?' && !/input|select|textarea/i.test(document.activeElement?.tagName || '')) setHelpSection('start');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const next = selected ? `#/agents/${encodeURIComponent(selected.id)}/${selected.pillar}` : `#/${tab}`;
    if (window.location.hash !== next) window.history.pushState(null, '', next);
  }, [tab, selected]);
  useEffect(() => {
    const onPop = () => {
      const h = readHash();
      setTab(h.tab);
      setSelected(h.id && h.tab === 'agents' ? { id: h.id, pillar: h.pillar } : null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async (d, { fresh = false } = {}) => {
    const id = ++reqId.current;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRefreshing(true);
    try {
      const body = await api(`/api/agents?days=${d}${fresh === true ? '&fresh=1' : ''}`, { signal: ctrl.signal });
      if (!body || body.mode !== 'live' || !Array.isArray(body.agents)) throw new Error(body?.message || 'Unexpected response from the data service');
      if (id !== reqId.current) return;
      setPayload(body);
      setMode('live');
      setError(null);
      setStale(null);
      hasData.current = true;
    } catch (e) {
      if (e.name === 'AbortError' || id !== reqId.current) return;
      console.error(e);
      if (hasData.current && fresh === 'auto') {
        setStale(new Date().toISOString());
      } else {
        setPayload(null);
        setMode('error');
        setError(e.message);
        hasData.current = false;
      }
    } finally {
      if (id === reqId.current) setRefreshing(false);
    }
  }, []);

  const loadDemo = useCallback(async (d) => {
    const id = ++reqId.current;
    abortRef.current?.abort();
    setRefreshing(true);
    try {
      const { buildDemoPayload } = await import('./demoData.js');
      if (id !== reqId.current) return;
      setPayload(buildDemoPayload(d));
      setMode('demo');
      setError(null);
      setStale(null);
      hasData.current = false;
    } finally {
      if (id === reqId.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (source === 'demo') loadDemo(days);
    else load(days);
  }, [days, source, load, loadDemo]);

  useEffect(() => {
    if (!autoRefresh || source !== 'live') return undefined;
    const t = setInterval(() => load(days, { fresh: 'auto' }), AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [autoRefresh, days, source, load]);

  const agents = payload?.agents || [];
  const removed = payload?.removed || [];
  const library = payload?.library;
  const canEdit = mode === 'live';

  const kpis = useMemo(() => {
    const notYet = new Set((library?.metrics || []).filter((m) => m.availability === 'not-available').map((m) => m.id));
    const activeAgents = agents.filter((a) => !a.widened && a.volume > 0);
    const applicable = activeAgents.flatMap((a) => [...a.metrics.health, ...a.metrics.risk, ...a.metrics.cost]).filter((m) => !m.informational && !notYet.has(m.id));
    return {
      monitored: agents.length,
      active: activeAgents.length,
      runs: sum(activeAgents, (a) => a.volume),
      attention: agents.filter((a) => ['red', 'amber'].includes(a.statuses.overall)).length,
      nonCompliant: agents.filter((a) => !a.compliant).length,
      widened: agents.filter((a) => a.widened).length,
      coverage: applicable.length ? Math.round((100 * applicable.filter((m) => m.status !== 'unknown').length) / applicable.length) : 0,
    };
  }, [agents, library]);

  const selectedAgent = selected ? agents.find((a) => a.id === selected.id) : null;
  const departments = useMemo(() => [...new Set(agents.map((a) => a.department).filter((d) => d && d !== 'Unassigned'))].sort(), [agents]);

  const openAgent = (id, pillar = 'health') => {
    setTab('agents');
    setSelected({ id, pillar });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const goAgents = (patch) => {
    setFilters({ ...EMPTY_FILTERS, ...patch });
    setSelected(null);
    setTab('agents');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const goManage = () => {
    setSelected(null);
    setTab('manage');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const refresh = () => (source === 'demo' ? loadDemo(days) : load(days, { fresh: true }));

  const run = async (fn, okText) => {
    setBusy(true);
    try {
      await fn();
      setToast({ kind: 'ok', text: okText });
      await load(days, { fresh: true });
    } catch (e) {
      setToast({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const saveAgent = async (values) => {
    await api('/api/registry', { method: 'POST', body: JSON.stringify({ agent: values }) });
    setForm(null);
    setToast({ kind: 'ok', text: `Saved details for ${values.displayName || values.id}.` });
    await load(days, { fresh: true });
  };
  const removeAgent = (agent) => {
    if (!window.confirm(`Stop monitoring “${agent.name}”?\n\nIt will no longer be shown or counted. Its telemetry is kept, and you can monitor it again from Manage agents.`)) return;
    if (selected?.id === agent.id) setSelected(null);
    run(() => api(`/api/registry?id=${encodeURIComponent(agent.id)}`, { method: 'DELETE' }), `${agent.name} is no longer monitored.`);
  };
  const restoreAgent = (r) => run(() => api('/api/registry', { method: 'POST', body: JSON.stringify({ restore: r.id }) }), `${r.name} is monitored again.`);
  const editAgent = (agent) => setForm({ mode: 'edit', initial: { ...agent.profile, id: agent.id, displayName: agent.profile.displayName || agent.name } });
  const addAgent = () => setForm({ mode: 'create', initial: EMPTY_PROFILE });

  return (
    <AppContext.Provider value={{ openHelp: setHelpSection }}>
      <a className="skip" href="#main">Skip to content</a>
      <Header payload={payload} mode={mode} theme={theme} toggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} refresh={refresh} refreshing={refreshing}
        openHelp={setHelpSection} days={days} setDays={setDays} autoRefresh={autoRefresh && source === 'live'} setAutoRefresh={setAutoRefresh} stale={stale} />
      <nav className="tabs" aria-label="Pages">
        <div className="tabs-inner">
          {TABS.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id && !selected ? 'page' : undefined} className={tab === t.id && !selected ? 'active' : ''}
              onClick={() => { setTab(t.id); setSelected(null); }}>
              {t.label}
            </button>
          ))}
        </div>
      </nav>
      <main className="shell" id="main">
        {mode === 'error' && (
          <div className="banner error" role="alert">
            <AlertTriangle size={18} />
            <span><b>Live telemetry could not be retrieved.</b> No figures are shown rather than old or sample data. {error && <span className="muted">({error})</span>}</span>
            <button className="ghost-btn small" type="button" onClick={() => load(days, { fresh: true })}>Try again</button>
            <button className="ghost-btn small" type="button" onClick={() => setSource('demo')}>Show demo data</button>
          </div>
        )}
        {stale && mode === 'live' && (
          <div className="banner warn" role="status">
            <AlertTriangle size={16} /> The automatic refresh at {fmtDateTime(stale)} failed. Figures shown are from {fmtDateTime(payload?.generatedAt)}.
            <button className="ghost-btn small" type="button" onClick={() => load(days, { fresh: true })}>Try again</button>
          </div>
        )}
        {mode === 'demo' && (
          <div className="banner demo" role="status">
            <Info size={16} /> <span><b>Demo data</b> — a synthetic portfolio for presentations. Not live telemetry.</span>
            <button className="ghost-btn small" type="button" onClick={() => setSource('live')}>Switch to live data</button>
          </div>
        )}
        {mode === 'loading' && !payload && <div className="chart-empty">Loading telemetry…</div>}
        {payload && selected && !selectedAgent && (
          <Panel title="Agent not found">
            <p className="muted">“{selected.id}” is not monitored. It may have been removed, or it has not sent telemetry in the last 90 days.</p>
            <button className="ghost-btn small" type="button" onClick={() => setSelected(null)}><ArrowLeft size={14} /> Back</button>
          </Panel>
        )}
        {payload &&
          (selectedAgent ? (
            <AgentDetail agent={selectedAgent} pillar={selected.pillar} setPillar={(p) => setSelected((s) => ({ ...s, pillar: p }))} back={() => setSelected(null)} library={library}
              canEdit={canEdit} onEdit={editAgent} onRemove={removeAgent} />
          ) : selected ? null : tab === 'overview' ? (
            <Overview agents={agents} removed={removed} days={days} library={library} kpis={kpis} goAgents={goAgents} goManage={goManage} openAgent={openAgent} />
          ) : tab === 'agents' ? (
            <Agents agents={agents} filters={filters} setFilters={setFilters} groupBy={groupBy} setGroupBy={setGroupBy} openAgent={openAgent} goManage={goManage} />
          ) : tab === 'manage' ? (
            <Manage agents={agents} removed={removed} payload={payload} mode={mode} onAdd={addAgent} onEdit={editAgent} onRemove={removeAgent} onRestore={restoreAgent} openAgent={openAgent} busy={busy} />
          ) : tab === 'library' ? (
            <Library library={library} />
          ) : (
            <DataSources payload={payload} agents={agents} removed={removed} mode={mode} />
          ))}
      </main>
      {form && <AgentForm initial={form.initial} mode={form.mode} onCancel={() => setForm(null)} onSave={saveAgent} departments={departments} />}
      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.kind === 'ok' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />} {toast.text}
          <button type="button" className="icon" onClick={() => setToast(null)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}
      {helpSection && <Help close={() => setHelpSection(null)} library={library} initialSection={helpSection} sources={payload?.sources} mode={mode} />}
    </AppContext.Provider>
  );
}

const rootEl = typeof document !== 'undefined' ? document.getElementById('root') : null;
if (rootEl) createRoot(rootEl).render(<App />);

export { App, Overview, Agents, AgentDetail, Library, DataSources, Manage, AgentForm };
