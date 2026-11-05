import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
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
  HelpCircle,
  Info,
  LogIn,
  Moon,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
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
  unknown: 'Not enough data to judge. A visibility gap, not a pass.',
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
  connected: 'Agents in the connected-agents list (Manage agents). Only these are monitored and counted.',
  active: 'Connected agents that had at least one conversation in the reporting period.',
  conversations: 'Conversations where a user sent at least one message (greeting-only sessions are excluded).',
  attention: 'Connected agents whose overall status is Watch or Action required.',
  compliance: 'Connected agents failing one or more automatic AI-policy checks (purpose & department, owners, risk tier, approval).',
  coverage: 'Share of metrics that could be measured with enough data. Grey (No data) is a visibility gap, never a pass.',
  discovered: 'Agents sending telemetry in this period that are not connected. They are not counted until connected.',
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
  if (!ts) return 'Never';
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

/** Rates a portfolio-level value with the same limits as the agent metric. */
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

function agentHeadline(agent) {
  if (agent.statuses.overall === 'unknown') return agent.volume ? 'Too little activity in this period to rate.' : 'No activity in this period.';
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
  return (
    <span className="tip" tabIndex={0} role="note" aria-label={`${label}: ${text}`}>
      <Info size={13} aria-hidden="true" />
      <span className="tip-body">{text}</span>
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

/** Horizontal bar split by status, with the count AND label written on each segment. */
function StatusSplit({ counts, total, label, showLabels = false }) {
  if (!total) return <div className="split-empty">No agents</div>;
  return (
    <div className="split-wrap">
      <div className="split" role="img" aria-label={`${label}: ${STATUS_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${STATUS_LABELS[s]}`).join(', ')}`}>
        {STATUS_ORDER.map((s) =>
          counts[s] ? (
            <span key={s} className={`seg ${s}`} style={{ flexGrow: counts[s] }} title={`${counts[s]} ${STATUS_LABELS[s]}`}>
              {counts[s]}
            </span>
          ) : null
        )}
      </div>
      {showLabels && (
        <ul className="split-labels">
          {STATUS_ORDER.map((s) => (
            <li key={s} className={counts[s] ? '' : 'zero'}>
              <i className={`swatch ${s}`} aria-hidden="true" />
              <b>{counts[s] || 0}</b> {STATUS_LABELS[s]}
            </li>
          ))}
        </ul>
      )}
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
  if (!points.some((p) => p.value !== null)) return <div className="chart-empty">No conversations in this period, so there is no trend to show.</div>;
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
            <tspan x={W - R + 10} dy="14" className="band-range">
              {range}
            </tspan>
          </text>
        ))}
        <path d={path} className="trend-line" />
        {valid.map((p) => (
          <circle key={p.i} cx={x(p.i)} cy={y(p.value)} r={points.length > 40 ? 2.5 : 4.5} className="trend-dot">
            <title>{`${bucketLabel(p.t, days)}: ${p.value}${unit} of ${fmtNum(p.n)} conversations`}</title>
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
  if (!series.length || !series.some((s) => s.conversations)) return <div className="chart-empty">No conversations in this period.</div>;
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
              <title>{`${bucketLabel(r.t, days)} — ${fmtNum(r.total)} conversations: ${fmtNum(r.completed)} resolved, ${fmtNum(r.other)} not resolved, ${fmtNum(r.failed)} with an error, ${fmtNum(r.blocked)} blocked`}</title>
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
        <text className="axis-title" transform={`translate(16 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle">Conversations</text>
      </svg>
      <figcaption>
        <Legend items={VOLUME_KEYS} />
        <span className="chart-note">Hover a bar for the exact breakdown.</span>
      </figcaption>
    </figure>
  );
}

/* ===================================================================== header */
function Header({ payload, mode, theme, toggleTheme, refresh, refreshing, openHelp, days, setDays, autoRefresh, setAutoRefresh, stale, user, authEnabled }) {
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
          {authEnabled && (user ? <span className="user-chip" title="Signed in">{user}</span> : <a className="ghost" href={`/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(window.location.pathname + window.location.hash)}`}><LogIn size={15} /> Sign in</a>)}
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
            Reporting period <Tip text="Every number, status and chart on every page uses this period." />
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
    harmful: raw('harmful'),
    dlp: raw('dlp'),
    safetyBlocks: raw('jailbreaks') + raw('indirect') + raw('harmful') + raw('dlp'),
    spend: spends.length ? sum(spends, (a) => a.spendUsd) : null,
    budgetUsedPct: budgetTotal ? pct(budgetSpend, budgetTotal) : null,
    budgetStatus: budgetTotal ? rateWith(library, 'spend', pct(budgetSpend, budgetTotal)) : 'unknown',
    budgetTotal,
    overBudget: agents.filter((a) => a.metrics.cost.some((m) => m.id === 'spend' && m.rawValue > 100)).length,
    noBudget: agents.filter((a) => !a.budgetUsd && a.billing !== 'included' && a.volume > 0).length,
    included: agents.filter((a) => a.billing === 'included').length,
    costPerConv: spends.length && engaged ? sum(spends, (a) => a.spendUsd) / engaged : null,
  };
}

function HeroStat({ label, value, status, tip }) {
  return (
    <div className="hero-stat">
      <dt>
        {label} {tip && <Tip text={tip} />}
      </dt>
      <dd className={status || ''}>{value}</dd>
    </div>
  );
}

function PillarHero({ pillar, agents, figures, days, goAgents, openAgent }) {
  const meta = PILLAR_META[pillar];
  const Icon = meta.icon;
  const counts = countBy(agents, (a) => a.statuses[pillar]);
  const status = worst(agents.map((a) => a.statuses[pillar]));
  const attention = agents
    .filter((a) => ['red', 'amber'].includes(a.statuses[pillar]))
    .sort((a, b) => STATUS_ORDER.indexOf(a.statuses[pillar]) - STATUS_ORDER.indexOf(b.statuses[pillar]) || b.volume - a.volume);
  const p = periodOf(days);
  const f = figures;

  let big;
  let stats;
  if (pillar === 'health') {
    big = { value: fmtPct(f.resolvedPct), label: 'of conversations resolved', status: f.resolvedStatus, tip: 'Engaged conversations the agent answered without an error, escalation or fallback, across all connected agents.' };
    stats = [
      { label: 'Conversations with errors', value: fmtPct(f.errorPct), status: f.errorStatus },
      { label: 'User messages answered', value: fmtPct(f.replyPct), status: f.replyStatus },
      { label: 'Slowest agent (95th pct.)', value: f.slowest ? `${Math.round(f.slowest.raw.p95 * 10) / 10}s` : '—', tip: f.slowest ? f.slowest.name : 'Needs at least 10 answered messages' },
    ];
  } else if (pillar === 'risk') {
    big = { value: fmtNum(f.safetyBlocks), label: `safety blocks · ${p.short}`, status: f.safetyBlocks ? 'amber' : f.engaged ? 'green' : 'unknown',
      tip: 'Requests or answers stopped by the platform guardrails: jailbreaks, attacks hidden in documents, harmful content and data-policy blocks.' };
    stats = [
      { label: 'Jailbreak attempts', value: fmtNum(f.jailbreaks) },
      { label: 'Attacks hidden in documents', value: fmtNum(f.indirect) },
      { label: 'Harmful content (conversations)', value: fmtNum(f.harmful) },
      { label: 'Data policy (DLP) blocks', value: fmtNum(f.dlp) },
    ];
  } else {
    big = { value: f.spend !== null ? fmtUsd(f.spend) : '—', label: `estimated spend · ${p.short}`, status: f.overBudget ? 'red' : f.budgetStatus,
      tip: 'Copilot Studio: answered messages × credits per response × price per credit. Foundry: tokens × model price. An estimate for steering, not an invoice.' };
    stats = [
      { label: 'Budget used', value: f.budgetUsedPct !== null ? `${fmtPct(f.budgetUsedPct)} of ${fmtUsd(f.budgetTotal)}` : 'No budgets set', status: f.budgetStatus },
      { label: 'Agents over budget', value: fmtNum(f.overBudget), status: f.overBudget ? 'red' : f.budgetTotal ? 'green' : '' },
      { label: 'Active agents without a budget', value: fmtNum(f.noBudget), status: f.noBudget ? 'amber' : '' },
      { label: 'Cost per conversation', value: f.costPerConv !== null ? fmtUsd(f.costPerConv) : '—' },
    ];
  }

  return (
    <article className={`pillar-hero edge-top-${status}`}>
      <header className="ph-head">
        <span className="ph-icon"><Icon size={22} aria-hidden="true" /></span>
        <div className="ph-title">
          <h2>{meta.name}</h2>
          <span>{meta.question}</span>
        </div>
        <StatusBadge value={status} />
      </header>

      <div className="ph-big">
        <b className={big.status}>{big.value}</b>
        <span>
          {big.label} <Tip text={big.tip} />
        </span>
      </div>

      <dl className="hero-stats">
        {stats.map((s) => <HeroStat key={s.label} {...s} />)}
      </dl>

      <div className="ph-section">
        <span className="ph-label">Agents by {meta.name.toLowerCase()} status</span>
        <StatusSplit counts={counts} total={agents.length} label={`${meta.name} status of agents`} showLabels />
      </div>

      <div className="ph-section">
        <span className="ph-label">Needs attention</span>
        {attention.length ? (
          <ul className="ph-issues">
            {attention.slice(0, 3).map((a) => {
              const issue = a.alerts.find((x) => x.pillar === pillar);
              return (
                <li key={a.id}>
                  <button type="button" onClick={() => openAgent(a.id, pillar)}>
                    <i className={`dot ${a.statuses[pillar]}`} aria-label={STATUS_LABELS[a.statuses[pillar]]} />
                    <span className="ph-agent">{a.name}</span>
                    <span className="ph-why">{issue ? `${issue.metric}: ${issue.value}` : STATUS_LABELS[a.statuses[pillar]]}</span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="ph-none">{agents.some((a) => a.statuses[pillar] !== 'unknown') ? 'No agent needs attention.' : 'Not enough activity to rate yet.'}</p>
        )}
      </div>

      <button className="link-btn ph-more" type="button" onClick={() => goAgents({ pillar, status: 'attention' })} disabled={!attention.length}>
        {attention.length > 3 ? `See all ${attention.length} agents` : `See ${meta.name.toLowerCase()} details`} <ArrowRight size={13} />
      </button>
    </article>
  );
}

function buildKeyPoints({ agents, kpis, figures, days }) {
  const pts = [];
  const counts = countBy(agents, (a) => a.statuses.overall);
  pts.push(
    <>
      <b>{fmtNum(counts.green || 0)}</b> of {plural(agents.length, 'connected agent')} are healthy; <b>{fmtNum(kpis.attention)}</b> need attention
      {counts.unknown ? <> and {fmtNum(counts.unknown)} could not be rated (no or too little activity)</> : null}.
    </>
  );
  const red = agents.filter((a) => a.statuses.overall === 'red');
  if (red.length) {
    pts.push(
      <>
        <b>Action required:</b> {red.slice(0, 4).map((a) => `${a.name}${a.environment !== 'Production' ? ` (${a.environment.toLowerCase()})` : ''}`).join(', ')}
        {red.length > 4 ? ` and ${red.length - 4} more` : ''}.
      </>
    );
  }
  if (kpis.nonCompliant) {
    const fails = {};
    agents.forEach((a) => a.compliance.filter((c) => !c.pass).forEach((c) => (fails[c.name] = (fails[c.name] || 0) + 1)));
    const topFail = Object.entries(fails).sort((x, y) => y[1] - x[1])[0];
    pts.push(<><b>{plural(kpis.nonCompliant, 'agent is', 'agents are')}</b> out of AI policy{topFail ? <>, most often missing “{topFail[0]}”</> : null}.</>);
  }
  if (figures.spend !== null) {
    pts.push(
      <>
        Estimated spend over the {periodOf(days).short}: <b>{fmtUsd(figures.spend)}</b>
        {figures.overBudget ? <>; <b>{plural(figures.overBudget, 'agent is', 'agents are')} over budget</b></> : figures.budgetTotal ? <>; no agent is over budget</> : <>; no budgets are set, so spend cannot be judged</>}.
      </>
    );
  }
  if (kpis.discovered) pts.push(<><b>{plural(kpis.discovered, 'agent')}</b> sent telemetry but {kpis.discovered === 1 ? 'is' : 'are'} not connected, so {kpis.discovered === 1 ? 'it is' : 'they are'} not counted.</>);
  return pts;
}

function OverallStrip({ agents, kpis, days, goAgents, goManage }) {
  const overall = worst(agents.map((a) => a.statuses.overall));
  const healthy = agents.filter((a) => a.statuses.overall === 'green').length;
  const items = [
    { label: 'Connected agents', value: fmtNum(kpis.connected), def: KPI_DEFS.connected, onClick: goManage },
    { label: 'Active in period', value: fmtNum(kpis.active), def: KPI_DEFS.active },
    { label: 'Conversations', value: fmtNum(kpis.conversations), def: KPI_DEFS.conversations },
    { label: 'Need attention', value: fmtNum(kpis.attention), def: KPI_DEFS.attention, tone: kpis.attention ? 'amber' : '', onClick: () => goAgents({ status: 'attention' }) },
    { label: 'Out of AI policy', value: fmtNum(kpis.nonCompliant), def: KPI_DEFS.compliance, tone: kpis.nonCompliant ? 'red' : '', onClick: () => goAgents({ nonCompliantOnly: true }) },
    { label: 'Data coverage', value: `${kpis.coverage}%`, def: KPI_DEFS.coverage },
  ];
  if (kpis.discovered) items.push({ label: 'Not connected', value: fmtNum(kpis.discovered), def: KPI_DEFS.discovered, tone: 'muted', onClick: goManage });
  return (
    <section className="overall-strip" aria-label="Overall status">
      <div className="os-status">
        <span className="os-label">Overall status · {periodOf(days).label.toLowerCase()} <Tip text="The worst status of any connected agent." /></span>
        <div className="os-line">
          <StatusBadge value={overall} size="sm" />
          <span><b>{healthy}</b> of {plural(agents.length, 'agent')} healthy</span>
        </div>
      </div>
      <dl className="os-items">
        {items.map((it) => {
          const Tag = it.onClick ? 'button' : 'div';
          return (
            <Tag key={it.label} className={`os-item ${it.onClick ? 'clickable' : ''}`} onClick={it.onClick} type={it.onClick ? 'button' : undefined}>
              <dt>{it.label} <Tip text={it.def} /></dt>
              <dd className={it.tone || ''}>{it.value}</dd>
            </Tag>
          );
        })}
      </dl>
    </section>
  );
}

function EmptyConnected({ discovered, goManage, mode }) {
  return (
    <section className="empty-state panel">
      <Plug size={30} aria-hidden="true" />
      <h2>No agents connected yet</h2>
      <p>
        The dashboard only monitors agents you connect, so the counts are always right.
        {discovered ? <> <b>{plural(discovered, 'agent')}</b> sent telemetry in this period and can be connected now.</> : <> No agent has sent telemetry in this period either — check that Application Insights is connected in each agent’s settings, or try a longer period.</>}
      </p>
      {mode === 'live' && (
        <button className="primary-solid" type="button" onClick={goManage}>
          <Plug size={15} /> Connect agents
        </button>
      )}
    </section>
  );
}

function Overview({ agents, discovered, days, library, kpis, goAgents, goManage, openAgent, mode }) {
  const figures = useMemo(() => portfolioFigures(agents, library), [agents, library]);
  const series = useMemo(() => aggregateSeries(agents), [agents]);
  const thresholds = library?.metrics?.find((m) => m.id === 'failed_execution_rate')?.thresholds || { green: 2, amber: 5 };
  const points = series.map((s) => ({ t: s.t, n: s.conversations, value: s.conversations ? Math.round((1000 * s.failed) / s.conversations) / 10 : null }));
  const p = periodOf(days);
  if (!agents.length) return <EmptyConnected discovered={discovered.length} goManage={goManage} mode={mode} />;

  const departments = (() => {
    const m = {};
    agents.forEach((a) => {
      const d = (m[a.department] ||= { name: a.department, agents: [], counts: {} });
      d.agents.push(a);
      d.counts[a.statuses.overall] = (d.counts[a.statuses.overall] || 0) + 1;
    });
    return Object.values(m).sort((x, y) => (x.name === 'Unassigned') - (y.name === 'Unassigned') || y.agents.length - x.agents.length || x.name.localeCompare(y.name));
  })();
  const needAction = agents.filter((a) => ['red', 'amber'].includes(a.statuses.overall));
  const keyPoints = buildKeyPoints({ agents, kpis, figures, days });

  return (
    <>
      <section className="hero-grid" aria-label="Health, risk and cost">
        {PILLARS.map((pl) => (
          <PillarHero key={pl} pillar={pl} agents={agents} figures={figures} days={days} goAgents={goAgents} openAgent={openAgent} />
        ))}
      </section>

      <OverallStrip agents={agents} kpis={kpis} days={days} goAgents={goAgents} goManage={goManage} />

      <Panel title="What leadership should know" subtitle={`Plain-English summary · ${p.label.toLowerCase()}`}>
        <ul className="key-points">
          {keyPoints.map((pt, i) => (
            <li key={i}>{pt}</li>
          ))}
        </ul>
      </Panel>

      <div className="chart-grid">
        <Panel title="Conversations over time" subtitle={`Engaged conversations per ${days === 1 ? 'hour' : 'day'}, all connected agents`} tip="Each bar is one hour or day. Colours show how those conversations ended.">
          <VolumeChart series={series} days={days} title="Conversations over time" />
        </Panel>
        <Panel title="Conversations with errors" subtitle="Share of conversations that hit a runtime error, all connected agents" helpSection="health"
          tip="Same limits as the “Conversations with errors” health metric. Safety blocks are excluded and reported under Risk.">
          <TrendChart points={points} thresholds={thresholds} days={days} title="Conversations with errors over time" xTitle={days === 1 ? 'Hour (your local time)' : 'Day'}
            yTitle="% of conversations with an error" seriesLabel="% of conversations with an error" />
        </Panel>
      </div>

      <Panel title="Status by department" subtitle="Overall status of connected agents. Select a department to see its agents." right={<Legend items={STATUS_LEGEND} title="Status colours" />}>
        <table className="table dept-table">
          <thead>
            <tr>
              <th scope="col">Department</th>
              <th scope="col">Agents</th>
              <th scope="col" className="wide">Agents by status</th>
              <th scope="col">Need attention</th>
              <th scope="col"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d.name} tabIndex={0} onClick={() => goAgents({ department: d.name })} onKeyDown={(e) => e.key === 'Enter' && goAgents({ department: d.name })}>
                <td><b>{d.name}</b></td>
                <td>{d.agents.length}</td>
                <td><StatusSplit counts={d.counts} total={d.agents.length} label={`${d.name} agents by status`} /></td>
                <td>{(d.counts.red || 0) + (d.counts.amber || 0)}</td>
                <td className="row-go"><ChevronRight size={16} aria-hidden="true" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Agents needing action" subtitle="Worst first. Select a row to see the evidence.">
        {needAction.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Department</th>
                  <th scope="col">Used in</th>
                  {PILLARS.map((pl) => <th key={pl} scope="col">{PILLAR_META[pl].name}</th>)}
                  <th scope="col">Overall</th>
                  <th scope="col">Main issue</th>
                </tr>
              </thead>
              <tbody>
                {needAction.map((a) => (
                  <tr key={a.id} onClick={() => openAgent(a.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && openAgent(a.id)}>
                    <td><b>{a.name}</b></td>
                    <td>{a.department}</td>
                    <td>{a.environment}</td>
                    {PILLARS.map((pl) => <td key={pl}><StatusBadge value={a.statuses[pl]} size="sm" /></td>)}
                    <td><StatusBadge value={a.statuses.overall} size="sm" /></td>
                    <td className="issue">{a.alerts[0] ? <><b>{a.alerts[0].metric}</b> {a.alerts[0].value}</> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="chart-empty">No connected agent currently needs action.</div>
        )}
      </Panel>
    </>
  );
}

/* ================================================================ agents tab */
const EMPTY_FILTERS = { status: 'all', pillar: 'overall', environment: 'all', department: 'all', location: 'all', owner: 'all', platform: 'all', riskTier: 'all', nonCompliantOnly: false, query: '' };

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
        <div><dt>Business owner</dt><dd>{agent.businessOwner || <em>Not assigned</em>}</dd></div>
        <div><dt>Conversations</dt><dd>{fmtNum(agent.volume)}</dd></div>
        <div><dt>Last activity</dt><dd>{relTime(agent.lastSeen)}</dd></div>
        <div><dt>Est. spend</dt><dd>{agent.billing === 'included' ? 'Included' : agent.spendUsd !== null ? fmtUsd(agent.spendUsd) : '—'}</dd></div>
      </dl>
      <footer>
        {agent.compliant ? (
          <span className="comp ok"><CheckCircle2 size={14} /> In AI policy</span>
        ) : (
          <span className="comp bad"><XCircle size={14} /> Out of AI policy: {agent.compliance.filter((c) => !c.pass).length} check(s) failed</span>
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
    return (
      <div className="chart-empty">
        No agents are connected. <button className="link-btn" type="button" onClick={goManage}>Go to Manage agents</button>
      </div>
    );
  }

  const active = Object.entries(filters).filter(([k, v]) => v !== EMPTY_FILTERS[k] && k !== 'pillar');
  const describe = ([k, v]) => {
    if (k === 'status') return `${filters.pillar !== 'overall' ? PILLAR_META[filters.pillar].name : 'Status'}: ${v === 'attention' ? 'Need attention' : STATUS_LABELS[v]}`;
    if (k === 'nonCompliantOnly') return 'Out of AI policy only';
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
              <input value={filters.query} onChange={(e) => set({ query: e.target.value })} placeholder="Name, purpose, owner or ID" />
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
          <button className="ghost small" type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}>
            <SlidersHorizontal size={14} /> {more ? 'Fewer filters' : 'More filters'}
          </button>
          <label className="check">
            <input type="checkbox" checked={filters.nonCompliantOnly} onChange={(e) => set({ nonCompliantOnly: e.target.checked })} />
            Out of AI policy only
          </label>
          <SelectField label="Group by" value={groupBy} onChange={setGroupBy} options={Object.entries(GROUP_FIELDS).map(([value, label]) => ({ value, label }))} />
          <button className="ghost small" type="button" onClick={() => setFilters(EMPTY_FILTERS)} disabled={!active.length}>Reset filters</button>
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
        Showing <b>{shown.length}</b> of {plural(agents.length, 'connected agent')}
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

function AgentDetail({ agent, pillar, setPillar, back, days, library, canEdit, onEdit, onDisconnect }) {
  const { openHelp } = useApp();
  const metrics = agent.metrics[pillar] || [];
  const measured = metrics.filter((m) => m.measured !== false && m.value !== 'Not available');
  const unmeasured = metrics.filter((m) => !measured.includes(m));
  const components = library?.healthComponents || {};
  const grouped =
    pillar === 'health'
      ? Object.entries(components).map(([key, label]) => ({ key, label, rows: measured.filter((m) => m.component === key) })).filter((g) => g.rows.length)
      : [{ key: 'all', label: null, rows: measured }];
  const facts = [
    ['Department', agent.department],
    ['Location', agent.location],
    ['Used in', agent.environment],
    ['Risk tier', agent.riskTier || 'Not assigned'],
    ['Approval', agent.approvalStatus || 'None'],
    ['Business owner', agent.businessOwner || 'Not assigned'],
    ['Technical owner', agent.technicalOwner || 'Not assigned'],
    ['Live since', agent.productionDays !== null ? `${agent.productionDays} days` : '—'],
    ['Last activity', relTime(agent.lastSeen)],
  ];
  return (
    <>
      <div className="detail-actions">
        <button className="back" onClick={back} type="button"><ArrowLeft size={15} /> Back</button>
        {canEdit && (
          <span className="spacer-actions">
            <button className="back" type="button" onClick={() => onEdit(agent)}><Pencil size={14} /> Edit profile</button>
            <button className="back danger" type="button" onClick={() => onDisconnect(agent)}><Trash2 size={14} /> Disconnect</button>
          </span>
        )}
      </div>
      <section className={`agent-hero edge-${agent.statuses.overall}`}>
        <div className="ah-main">
          <span className="eyebrow">{agent.platform}</span>
          <h2>{agent.name}</h2>
          <p>{agent.purpose || 'No purpose recorded.'}</p>
        </div>
        <div className="ah-status">
          <span className="field-label">Overall status</span>
          <StatusBadge value={agent.statuses.overall} />
          <span className="field-label">AI policy</span>
          {agent.compliant ? <span className="comp ok pill"><CheckCircle2 size={14} /> In policy</span> : <span className="comp bad pill"><XCircle size={14} /> Out of policy</span>}
        </div>
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
          const n = agent.metrics[p].filter((m) => m.measured !== false && m.value !== 'Not available').length;
          return (
            <button key={p} type="button" role="tab" aria-selected={pillar === p} className={pillar === p ? 'active' : ''} onClick={() => setPillar(p)}>
              <Icon size={22} aria-hidden="true" />
              <span className="pt-copy">
                <b>{PILLAR_META[p].name}</b>
                <small>{PILLAR_META[p].question} · {n} of {agent.metrics[p].length} measured</small>
              </span>
              <StatusBadge value={agent.statuses[p]} />
            </button>
          );
        })}
      </div>

      <div className="detail-grid">
        <Panel title={`${PILLAR_META[pillar].name} evidence`} subtitle={library?.pillars?.[pillar]?.definition} right={<StatusBadge value={agent.statuses[pillar]} />} helpSection={pillar}>
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
          {!measured.length && <div className="chart-empty">Nothing in this area could be measured in the selected period.</div>}
          {unmeasured.length > 0 && (
            <details className="unmeasured">
              <summary>Not measured ({unmeasured.length}) — why these show “No data”</summary>
              <ul>{unmeasured.map((m) => <li key={m.id}><b>{m.name}</b> — {m.why}</li>)}</ul>
              <button className="link-btn" type="button" onClick={() => openHelp('data')}>Where does the data come from?</button>
            </details>
          )}
        </Panel>

        <div className="side">
          <Panel title="Activity" subtitle={`Conversations per ${days === 1 ? 'hour' : 'day'} · ${periodOf(days).label.toLowerCase()}`}>
            <VolumeChart series={agent.series} days={days} title={`${agent.name} conversations over time`} compact />
            <dl className="stat-strip">
              <div><dt>Conversations</dt><dd>{fmtNum(agent.volume)}</dd></div>
              <div><dt>User messages</dt><dd>{fmtNum(agent.userTurns)}</dd></div>
              <div><dt>Error events</dt><dd>{fmtNum(agent.errorEvents)}</dd></div>
              <div><dt>{agent.billing === 'tokens' ? 'Tokens' : 'Copilot Credits (est.)'}</dt><dd>{agent.billing === 'tokens' ? fmtNum(agent.tokens) : agent.billing === 'included' ? 'Included' : fmtNum(agent.credits)}</dd></div>
              <div><dt>Est. spend</dt><dd>{agent.billing === 'included' ? 'Included' : fmtUsd(agent.spendUsd)}</dd></div>
              <div><dt>Budget for period</dt><dd>{agent.budgetUsd ? fmtUsd(agent.budgetUsd) : 'Not set'}</dd></div>
            </dl>
          </Panel>
          <Panel title="AI policy checks" helpSection="policy" tip="Automatic: telemetry compared with the agent profile.">
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
                <thead><tr><th scope="col">Code</th><th scope="col">Meaning</th><th scope="col">Count</th></tr></thead>
                <tbody>
                  {agent.topErrorCodes.map((c) => (
                    <tr key={c.code}><td><code>{c.code}</code></td><td>{ERROR_HELP[c.code] || 'See the Copilot Studio error-code reference'}</td><td>{fmtNum(c.count)}</td></tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
          <Panel title="Telemetry names" tip="Names under which this agent appears in telemetry. Edit the profile to add aliases.">
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
  platform: 'Microsoft Copilot Studio', riskTier: '', approvalStatus: '', productionSince: '', monthlyBudgetUsd: '', billingModel: '',
  creditsPerResponse: '', allowedConnectors: [], notes: '',
};

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
  const editingId = mode === 'edit';

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...v, aliases: v.aliases, allowedConnectors: v.allowedConnectors });
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

  const F = ({ k, label, hint, type = 'text', required, wide, children, readOnly }) => (
    <label className={`form-field ${wide ? 'wide' : ''}`}>
      <span className="field-label">{label}{required && <span className="req" aria-hidden="true"> *</span>}</span>
      {children || <input type={type} value={v[k]} onChange={set(k)} required={required} readOnly={readOnly} min={type === 'number' ? 0 : undefined} step={type === 'number' ? 'any' : undefined} />}
      {hint && <small>{hint}</small>}
    </label>
  );

  return (
    <div className="modal-wrap" role="dialog" aria-modal="true" aria-label={editingId ? 'Edit agent' : 'Connect agent'} onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="modal" onSubmit={submit}>
        <header className="modal-head">
          <div>
            <h2>{editingId ? `Edit ${initial.displayName || initial.id}` : 'Connect an agent'}</h2>
            <p>{editingId ? 'Changes apply to the dashboard straight away.' : 'Once connected, the agent is monitored and counted. Only the telemetry ID is required; the rest powers the AI policy checks.'}</p>
          </div>
          <button type="button" className="icon" onClick={onCancel} aria-label="Close"><X size={20} /></button>
        </header>
        <div className="modal-body">
          <fieldset>
            <legend>Identity</legend>
            <div className="form-grid">
              {F({ k: 'id', label: 'Telemetry ID', required: true, readOnly: editingId || initial?.fromDiscovery,
                hint: 'Schema name (e.g. cr4f2_contractBot) or bot name exactly as in Application Insights. Cannot be changed later.' })}
              {F({ k: 'displayName', label: 'Display name', hint: 'Name shown on the dashboard.' })}
              {F({ k: 'aliases', label: 'Other telemetry names', wide: true, hint: 'Comma-separated. Any other names this agent appears under, so its conversations are not split.' })}
            </div>
          </fieldset>
          <fieldset>
            <legend>Ownership and purpose</legend>
            <div className="form-grid">
              {F({ k: 'purpose', label: 'Purpose', wide: true, children: <textarea rows={2} value={v.purpose} onChange={set('purpose')} placeholder="What the agent does, in one sentence" /> })}
              {F({ k: 'department', label: 'Department', children: (
                <>
                  <input list="dept-list" value={v.department} onChange={set('department')} />
                  <datalist id="dept-list">{departments.map((d) => <option key={d} value={d} />)}</datalist>
                </>
              ) })}
              {F({ k: 'location', label: 'Location' })}
              {F({ k: 'businessOwner', label: 'Business owner' })}
              {F({ k: 'technicalOwner', label: 'Technical owner' })}
            </div>
          </fieldset>
          <fieldset>
            <legend>Governance</legend>
            <div className="form-grid">
              {F({ k: 'riskTier', label: 'Risk tier', children: (
                <select value={v.riskTier} onChange={set('riskTier')}><option value="">Not assigned</option><option>Low</option><option>Medium</option><option>High</option></select>
              ) })}
              {F({ k: 'approvalStatus', label: 'Approval status', children: (
                <select value={v.approvalStatus} onChange={set('approvalStatus')}>
                  <option value="">None</option><option>Approved</option><option>In review</option><option>Rejected</option><option>Retired</option>
                </select>
              ), hint: 'Production use requires “Approved” to pass the AI policy check.' })}
              {F({ k: 'productionSince', label: 'In production since', type: 'date' })}
              {F({ k: 'platform', label: 'Platform', children: (
                <select value={v.platform} onChange={set('platform')}><option>Microsoft Copilot Studio</option><option>Azure AI Foundry</option><option>Custom / SDK</option></select>
              ) })}
              {F({ k: 'allowedConnectors', label: 'Allowed connectors', wide: true, hint: 'Comma-separated, e.g. SharePoint, Workday.' })}
            </div>
          </fieldset>
          <fieldset>
            <legend>Cost</legend>
            <div className="form-grid">
              {F({ k: 'monthlyBudgetUsd', label: 'Monthly budget (USD)', type: 'number', hint: 'Needed to rate Cost. Pro-rated to the reporting period.' })}
              {F({ k: 'billingModel', label: 'Billing model', children: (
                <select value={v.billingModel} onChange={set('billingModel')}>
                  <option value="">Automatic (by platform)</option>
                  <option value="copilot-credits">Copilot Credits</option>
                  <option value="m365-copilot">Included in Microsoft 365 Copilot licences</option>
                  <option value="tokens">Model tokens (Foundry / SDK)</option>
                </select>
              ) })}
              {F({ k: 'creditsPerResponse', label: 'Copilot Credits per response', type: 'number', hint: 'Classic answer 1 · generative answer 2 (default) · agent action 5 · tenant graph grounding 10.' })}
            </div>
          </fieldset>
        </div>
        {error && <div className="form-error" role="alert"><AlertTriangle size={15} /> {error}</div>}
        <footer className="modal-foot">
          <button type="button" className="ghost-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary-solid" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Connect agent'}</button>
        </footer>
      </form>
    </div>
  );
}

function Manage({ agents, discovered, payload, mode, canEdit, signInNeeded, onConnect, onConnectMany, onEdit, onDisconnect, openAgent, busy, days }) {
  const storage = payload?.sources?.registry;
  const readOnly = mode !== 'live';
  const [q, setQ] = useState('');
  const shown = agents.filter((a) => !q || `${a.name} ${a.id} ${a.department}`.toLowerCase().includes(q.toLowerCase()));
  const sorted = [...shown].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <section className="intro">
        <h2>Manage connected agents</h2>
        <p>
          Only <b>connected</b> agents are monitored and counted on this dashboard. Connect an agent once it sends telemetry to Application Insights, and disconnect it when it is retired.
          Disconnecting never deletes telemetry; it only stops the agent being monitored.
        </p>
        {readOnly && <div className="warn"><Info size={15} /> Demo data is read-only. Switch to live data to connect or remove agents.</div>}
        {!readOnly && signInNeeded && (
          <div className="warn"><LogIn size={15} /> <span>Sign in to connect, edit or remove agents. <a href={`/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent('/#/manage')}`}>Sign in</a></span></div>
        )}
        {storage?.warning && <div className="warn"><AlertTriangle size={15} /> {storage.warning}</div>}
      </section>

      <Panel
        title={`Connected agents (${agents.length})`}
        subtitle={storage ? `Stored in: ${storage.label}` : undefined}
        right={
          <div className="manage-tools">
            <span className="search small-search">
              <Search size={14} aria-hidden="true" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter connected agents" aria-label="Filter connected agents" />
            </span>
            {canEdit && <button className="primary-solid" type="button" onClick={() => onConnect(null)}><Plus size={15} /> Connect manually</button>}
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
                  <th scope="col">AI policy</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((a) => (
                  <tr key={a.id}>
                    <td><button className="link-btn strong" type="button" onClick={() => openAgent(a.id)}>{a.name}</button></td>
                    <td><code>{a.id}</code></td>
                    <td>{a.department}</td>
                    <td>{a.businessOwner || <em className="missing">Not assigned</em>}</td>
                    <td>{relTime(a.lastSeen)}</td>
                    <td>{a.compliant ? <span className="comp ok"><CheckCircle2 size={14} /> In policy</span> : <span className="comp bad"><XCircle size={14} /> {a.compliance.filter((c) => !c.pass).length} failed</span>}</td>
                    <td className="row-actions">
                      {canEdit && (
                        <>
                          <button className="icon-btn" type="button" onClick={() => onEdit(a)} title={`Edit ${a.name}`} aria-label={`Edit ${a.name}`}><Pencil size={15} /></button>
                          <button className="icon-btn danger" type="button" onClick={() => onDisconnect(a)} title={`Disconnect ${a.name}`} aria-label={`Disconnect ${a.name}`} disabled={busy}><Trash2 size={15} /></button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="chart-empty">No agents connected yet. Connect them from the list below.</div>
        )}
      </Panel>

      <Panel
        title={`Sending telemetry but not connected (${discovered.length})`}
        subtitle={`Agents seen in Application Insights in the ${periodOf(days).label.toLowerCase()} that are not monitored. Choose a longer period to find agents that are used less often.`}
        tip={KPI_DEFS.discovered}
        right={canEdit && discovered.length > 1 ? <button className="ghost-btn" type="button" disabled={busy} onClick={() => onConnectMany(discovered)}><Plug size={15} /> Connect all {discovered.length}</button> : null}
      >
        {discovered.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name in telemetry</th>
                  <th scope="col">Telemetry ID</th>
                  <th scope="col">Conversations</th>
                  <th scope="col">Used in</th>
                  <th scope="col">Last activity</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {discovered.map((d) => (
                  <tr key={d.id}>
                    <td><b>{d.name}</b>{(() => { const other = d.names.filter((n) => n !== d.name && n !== d.id); return other.length ? <small className="muted block">Also seen as: {other.join(', ')}</small> : null; })()}</td>
                    <td><code>{d.id}</code></td>
                    <td>{fmtNum(d.conversations)}</td>
                    <td>{d.environment}</td>
                    <td>{relTime(d.lastSeen)}</td>
                    <td className="row-actions">
                      {canEdit && <button className="primary-solid small" type="button" onClick={() => onConnect({ ...d.suggestion, id: d.id, fromDiscovery: true })}><Plug size={14} /> Connect</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="chart-empty">Every agent that sent telemetry in this period is connected.</div>
        )}
      </Panel>
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
          Health, Risk and Cost each take the worst of their metrics; the overall status takes the worst of the three. Metrics without enough data show <b>No data</b> and are never counted as healthy.
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
      <Panel title="AI policy checks" subtitle="Drive the “Out of AI policy” figure. Evaluated automatically from the agent profile.">
        <table className="table">
          <thead><tr><th scope="col">Check</th><th scope="col">Rule</th></tr></thead>
          <tbody>{library.compliance.map((c) => <tr key={c.id}><td><b>{c.name}</b></td><td>{c.definition}</td></tr>)}</tbody>
        </table>
      </Panel>
    </>
  );
}

/* =============================================================== data sources */
function DataSources({ payload, agents, discovered, mode }) {
  const s = payload?.sources || {};
  const rows = [
    ['Data as of', fmtDateTime(payload?.generatedAt)],
    ['Data mode', mode === 'live' ? 'Live telemetry' : mode === 'demo' ? 'Demo data (synthetic, not live)' : 'Unavailable'],
    ['Reporting period', payload?.window ? `${fmtDateTime(payload.window.start)} → ${fmtDateTime(payload.window.end)}` : '—'],
    ['Telemetry source', s.telemetry || '—'],
    ['Connected-agents list', s.registry?.label || '—'],
    ['Connected agents', fmtNum(agents.length)],
    ['…with activity in period', fmtNum(agents.filter((a) => a.allConversations > 0).length)],
    ['Sending telemetry, not connected', fmtNum(discovered.length)],
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
        {s.inventory === 'error' && <div className="warn"><AlertTriangle size={15} /> The optional AI inventory could not be loaded ({s.inventoryLabel}). Profiles come from the connected-agents list only.</div>}
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
          <p><b>Which agents.</b> Only agents on the connected-agents list (Manage agents) are monitored and counted. Agents that send telemetry but are not connected are listed separately and never mixed into the figures.</p>
          <p><b>Agent identity.</b> Every conversation is assigned to exactly one agent: the topic schema name (stable across renames), else the bot name. All names of a connected agent (ID, display name, aliases) map to that one agent.</p>
          <p><b>Conversations.</b> Only engaged conversations count — a user sent at least one message. Channel events such as “conversation started” are not counted as user messages.</p>
          <p><b>Statuses.</b> Each metric is rated against the limits in the metric library. Health, Risk and Cost take their worst metric; the overall status takes the worst of the three. Metrics without enough data are “No data” and never count as healthy.</p>
          <p><b>Risk.</b> Responsible AI blocks read from error sub-codes: jailbreaks, attacks in documents, harmful content and DLP blocks. They are excluded from Health errors so nothing is counted twice.</p>
          <p><b>Cost.</b> Copilot Studio: answered messages × credits per response × price per credit (an estimate; the billed figure is in the Power Platform admin center). Foundry: tokens × model price. Cost is only rated when a monthly budget is set.</p>
          <p><b>Freshness.</b> Application Insights usually lags a few minutes. All queries use the same fixed time window.</p>
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
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || `The service returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
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
  const [form, setForm] = useState(null); // { mode: 'create'|'edit', initial }
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  const reqId = useRef(0);
  const abortRef = useRef(null);
  const hasData = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('agent-theme', theme);
  }, [theme]);

  // Static Web Apps sign-in state (silently ignored when not hosted on SWA).
  useEffect(() => {
    fetch('/.auth/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!b || !('clientPrincipal' in b)) return;
        setAuthEnabled(true);
        setUser(b.clientPrincipal?.userDetails || null);
      })
      .catch(() => {});
  }, []);

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

  /** Only the newest request may update the screen; older ones are aborted or ignored. */
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
  const discovered = payload?.discovered || [];
  const library = payload?.library;
  const signInNeeded = mode === 'live' && payload?.changesRequireSignIn !== false && !user;
  const canEdit = mode === 'live' && !signInNeeded;

  const kpis = useMemo(() => {
    const notYet = new Set((library?.metrics || []).filter((m) => m.availability === 'not-available').map((m) => m.id));
    const applicable = agents
      .filter((a) => a.allConversations > 0)
      .flatMap((a) => [...a.metrics.health, ...a.metrics.risk, ...a.metrics.cost])
      .filter((m) => !m.informational && !notYet.has(m.id));
    return {
      connected: agents.length,
      active: agents.filter((a) => a.allConversations > 0).length,
      conversations: sum(agents, (a) => a.volume),
      attention: agents.filter((a) => ['red', 'amber'].includes(a.statuses.overall)).length,
      nonCompliant: agents.filter((a) => !a.compliant).length,
      discovered: discovered.length,
      coverage: applicable.length ? Math.round((100 * applicable.filter((m) => m.status !== 'unknown').length) / applicable.length) : 0,
    };
  }, [agents, discovered, library]);

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

  // ------------------------------------------------------------- registry actions
  const handleAuthError = (e) => {
    if (e.status === 401) setUser(null);
    throw e;
  };
  const saveAgent = async (values) => {
    const update = form?.mode === 'edit';
    await api('/api/registry', { method: 'POST', body: JSON.stringify({ agent: values, update }) }).catch(handleAuthError);
    setForm(null);
    setToast({ kind: 'ok', text: update ? `Saved changes to ${values.displayName || values.id}.` : `${values.displayName || values.id} is now connected.` });
    await load(days, { fresh: true });
  };
  const connectMany = async (list) => {
    if (!window.confirm(`Connect all ${list.length} agents? You can add their owners, department and budget afterwards.`)) return;
    setBusy(true);
    try {
      await api('/api/registry', { method: 'POST', body: JSON.stringify({ agents: list.map((d) => ({ ...d.suggestion, id: d.id })) }) }).catch(handleAuthError);
      setToast({ kind: 'ok', text: `${list.length} agents connected.` });
      await load(days, { fresh: true });
    } catch (e) {
      setToast({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const disconnectAgent = async (agent) => {
    if (!window.confirm(`Disconnect “${agent.name}”?\n\nIt will no longer be monitored or counted. Its telemetry is not deleted, and you can connect it again at any time.`)) return;
    setBusy(true);
    try {
      await api(`/api/registry?id=${encodeURIComponent(agent.id)}`, { method: 'DELETE' }).catch(handleAuthError);
      setToast({ kind: 'ok', text: `${agent.name} was disconnected.` });
      if (selected?.id === agent.id) setSelected(null);
      await load(days, { fresh: true });
    } catch (e) {
      setToast({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const editAgent = (agent) => setForm({ mode: 'edit', initial: { ...agent.profile, id: agent.id } });
  const connectAgent = (initialValues) => setForm({ mode: 'create', initial: initialValues || EMPTY_PROFILE });

  return (
    <AppContext.Provider value={{ openHelp: setHelpSection }}>
      <a className="skip" href="#main">Skip to content</a>
      <Header payload={payload} mode={mode} theme={theme} toggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} refresh={refresh} refreshing={refreshing}
        openHelp={setHelpSection} days={days} setDays={setDays} autoRefresh={autoRefresh && source === 'live'} setAutoRefresh={setAutoRefresh} stale={stale} user={user} authEnabled={authEnabled} />
      <nav className="tabs" aria-label="Pages">
        <div className="tabs-inner">
          {TABS.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id && !selected ? 'page' : undefined} className={tab === t.id && !selected ? 'active' : ''}
              onClick={() => { setTab(t.id); setSelected(null); }}>
              {t.label}
              {t.id === 'manage' && discovered.length > 0 && mode === 'live' && <span className="tab-count" title={`${discovered.length} not connected`}>{discovered.length}</span>}
            </button>
          ))}
        </div>
      </nav>
      <main className="shell" id="main">
        {mode === 'error' && (
          <div className="banner error" role="alert">
            <AlertTriangle size={18} />
            <span><b>Live telemetry could not be retrieved.</b> No figures are shown rather than old or sample data. {error && <span className="muted">({error})</span>}</span>
            <button className="ghost small" type="button" onClick={() => load(days, { fresh: true })}>Try again</button>
            <button className="ghost small" type="button" onClick={() => setSource('demo')}>Show demo data</button>
          </div>
        )}
        {stale && mode === 'live' && (
          <div className="banner warn" role="status">
            <AlertTriangle size={16} /> The automatic refresh at {fmtDateTime(stale)} failed. Figures shown are from {fmtDateTime(payload?.generatedAt)}.
            <button className="ghost small" type="button" onClick={() => load(days, { fresh: true })}>Try again</button>
          </div>
        )}
        {mode === 'demo' && (
          <div className="banner demo" role="status">
            <Info size={16} /> <span><b>Demo data</b> — a synthetic portfolio for presentations. Not live telemetry.</span>
            <button className="ghost small" type="button" onClick={() => setSource('live')}>Switch to live data</button>
          </div>
        )}
        {mode === 'live' && payload?.sources?.registry?.warning && tab !== 'manage' && (
          <div className="banner warn" role="status"><AlertTriangle size={16} /> {payload.sources.registry.warning}</div>
        )}
        {mode === 'loading' && !payload && <div className="chart-empty">Loading telemetry…</div>}
        {payload && selected && !selectedAgent && (
          <Panel title="Agent not found">
            <p className="muted">“{selected.id}” is not a connected agent. It may have been disconnected.</p>
            <button className="ghost small" type="button" onClick={() => setSelected(null)}><ArrowLeft size={14} /> Back</button>
          </Panel>
        )}
        {payload &&
          (selectedAgent ? (
            <AgentDetail agent={selectedAgent} pillar={selected.pillar} setPillar={(p) => setSelected((s) => ({ ...s, pillar: p }))} back={() => setSelected(null)} days={days} library={library}
              canEdit={canEdit} onEdit={editAgent} onDisconnect={disconnectAgent} />
          ) : selected ? null : tab === 'overview' ? (
            <Overview agents={agents} discovered={discovered} days={days} library={library} kpis={kpis} goAgents={goAgents} goManage={goManage} openAgent={openAgent} mode={mode} />
          ) : tab === 'agents' ? (
            <Agents agents={agents} filters={filters} setFilters={setFilters} groupBy={groupBy} setGroupBy={setGroupBy} openAgent={openAgent} goManage={goManage} />
          ) : tab === 'manage' ? (
            <Manage agents={agents} discovered={discovered} payload={payload} mode={mode} canEdit={canEdit} signInNeeded={signInNeeded} onConnect={connectAgent} onConnectMany={connectMany}
              onEdit={editAgent} onDisconnect={disconnectAgent} openAgent={openAgent} busy={busy} days={days} />
          ) : tab === 'library' ? (
            <Library library={library} />
          ) : (
            <DataSources payload={payload} agents={agents} discovered={discovered} mode={mode} />
          ))}
      </main>
      {form && <AgentForm initial={form.initial} mode={form.mode} onCancel={() => setForm(null)} onSave={saveAgent} departments={departments} />}
      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.kind === 'ok' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />} {toast.text}
          <button type="button" className="icon" onClick={() => setToast(null)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}
      {helpSection && <Help close={() => setHelpSection(null)} library={library} kpiDefs={KPI_DEFS} initialSection={helpSection} sources={payload?.sources} mode={mode} />}
    </AppContext.Provider>
  );
}

const rootEl = typeof document !== 'undefined' ? document.getElementById('root') : null;
if (rootEl) createRoot(rootEl).render(<App />);

export { App, Overview, Agents, AgentDetail, Library, DataSources, Manage, AgentForm };
