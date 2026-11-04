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
  Moon,
  RefreshCw,
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
  { id: 'library', label: 'How it’s measured' },
  { id: 'sources', label: 'Data sources' },
];
const GROUP_FIELDS = { department: 'Department', location: 'Location', platform: 'Platform', environment: 'Environment', none: 'No grouping' };
const ENVIRONMENTS = ['Production', 'Test only', 'No activity'];
const AUTO_REFRESH_MS = 5 * 60 * 1000;

export const KPI_DEFS = {
  monitored: 'Every agent that sent telemetry in the period, plus registered agents that were silent.',
  conversations: 'Conversations where a user sent at least one message (greeting-only sessions are excluded).',
  attention: 'Agents whose overall status is Watch or Action required.',
  highRisk: 'Agents used in production with at least one metric past its Action limit — the “fix now” list.',
  compliance: 'Agents failing one or more automatic AI-policy checks (registered, owners, risk tier, approval, telemetry).',
  spend: 'Estimated spend in the period: Copilot Studio agents from Copilot Credits, Foundry agents from tokens × model price.',
  alerts: 'Individual metrics currently at Watch or Action level, across all agents.',
  coverage: 'Share of metrics that could be measured with enough data. Grey (No data) is a visibility gap, never a pass.',
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

const HelpContext = createContext(() => {});
const useHelp = () => useContext(HelpContext);

/* ==================================================================== helpers */
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtDateTime = (d) =>
  d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtNum = (n) => (n === null || n === undefined ? '—' : Math.round(Number(n)).toLocaleString('en-US'));
const fmtUsd = (n) =>
  n === null || n === undefined ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: n >= 100 ? 0 : 2, maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
const plural = (n, word, many = `${word}s`) => `${fmtNum(n)} ${n === 1 ? word : many}`;
const periodOf = (days) => PERIODS.find((p) => p.days === days) || { label: `Last ${days} days`, short: `${days} days` };
const worst = (list) => list.reduce((w, s) => (STATUS_ORDER.indexOf(s) < STATUS_ORDER.indexOf(w) ? s : w), 'unknown');
const countBy = (items, fn) => items.reduce((m, x) => ((m[fn(x)] = (m[fn(x)] || 0) + 1), m), {});

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
  return days === 1
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
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

/** One plain-English sentence explaining an agent's overall status. */
function agentHeadline(agent) {
  if (agent.statuses.overall === 'unknown') {
    return agent.volume ? 'Too little activity in this period to rate.' : 'No activity in this period.';
  }
  const top = agent.alerts[0];
  if (!top) return 'All measured checks are within limits.';
  const more = agent.alerts.length - 1;
  return `${top.metric} is ${top.value}${more > 0 ? ` (+${more} more issue${more === 1 ? '' : 's'})` : ''}.`;
}

/** “Nice” axis maximum and step for roughly 4 gridlines. */
function niceScale(max, ticks = 4) {
  if (!max || max <= 0) return { top: 1, step: 0.25 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { top: step * Math.ceil(max / step), step };
}

/* ================================================================= primitives */
function StatusBadge({ value, size = 'md', onClick, title }) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag className={`status ${value} ${size}`} onClick={onClick} type={onClick ? 'button' : undefined} title={title || STATUS_MEANING[value]}>
      <i aria-hidden="true" />
      {STATUS_LABELS[value] || value}
    </Tag>
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
  const openHelp = useHelp();
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
          {it.hint && <span className="legend-hint"> {it.hint}</span>}
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

function AxisTitles({ xTitle, yTitle, right = CHART.R }) {
  const { W, H, L, T, B } = CHART;
  return (
    <>
      <text className="axis-title" x={(L + W - right) / 2} y={H - 8} textAnchor="middle">
        {xTitle}
      </text>
      <text className="axis-title" transform={`translate(16 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle">
        {yTitle}
      </text>
    </>
  );
}

/** Line chart over Healthy / Watch / Action threshold bands, fully labelled. */
function TrendChart({ points, thresholds, unit = '%', days, title, xTitle, yTitle, seriesLabel }) {
  if (!points.some((p) => p.value !== null)) return <div className="chart-empty">No conversations in this period, so there is no trend to show.</div>;
  const { W, H, L, T, B } = CHART;
  const R = 110; // room for the band labels on the right
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
            <title>{`${bucketLabel(p.t, days)}: ${p.value}${unit} of ${fmtNum(p.n)} conversations`}</title>
          </circle>
        ))}
        <line className="axis-line" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
        <XAxisLabels points={points} x={x} days={days} y0={y(0)} />
        <AxisTitles xTitle={xTitle} yTitle={yTitle} right={R} />
      </svg>
      <figcaption>
        <Legend
          items={[
            { label: seriesLabel, cls: 'line' },
            { label: 'Healthy band', cls: 'band-green' },
            { label: 'Watch band', cls: 'band-amber' },
            { label: 'Action band', cls: 'band-red' },
          ]}
        />
        <span className="chart-note">Hover a point for the exact value. Gaps mean no conversations in that {days === 1 ? 'hour' : 'day'}.</span>
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

/** Stacked bar chart of conversations per hour / day, with axes, gridlines and legend. */
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

/** Horizontal bar split by status with the count written on each segment. */
function StatusSplit({ counts, total, label }) {
  if (!total) return <div className="split-empty">No agents</div>;
  return (
    <div className="split" role="img" aria-label={`${label}: ${STATUS_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${STATUS_LABELS[s]}`).join(', ')}`}>
      {STATUS_ORDER.map((s) =>
        counts[s] ? (
          <span key={s} className={`seg ${s}`} style={{ flexGrow: counts[s] }} title={`${counts[s]} ${STATUS_LABELS[s]}`}>
            {counts[s]}
          </span>
        ) : null
      )}
    </div>
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
            <p>Is each AI agent working, safe and affordable? · Copilot Studio and Azure AI Foundry</p>
          </div>
        </div>
        <div className="masthead-actions">
          <span className={`mode-badge ${mode}`} title={mode === 'demo' ? 'Synthetic data for demonstrations' : undefined}>
            <i aria-hidden="true" />
            {mode === 'live' ? (stale ? 'Live data (refresh failed)' : 'Live data') : mode === 'demo' ? 'Demo data' : mode === 'error' ? 'No data' : 'Loading…'}
          </span>
          <button className="ghost" onClick={() => openHelp('start')} type="button" title="How this dashboard works (shortcut: ?)">
            <HelpCircle size={15} /> How it works
          </button>
          <button className="ghost icon-only" onClick={toggleTheme} type="button" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
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
          <span className="range">
            {win ? `${fmtDateTime(win.start)} → ${fmtDateTime(win.end)}` : ''}
          </span>
          <span className="asof" title={payload?.generatedAt ? fmtDateTime(payload.generatedAt) : ''}>
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
function buildKeyPoints({ agents, kpis, days }) {
  if (!agents.length) return [];
  const pts = [];
  const counts = countBy(agents, (a) => a.statuses.overall);
  pts.push(
    <>
      <b>{fmtNum(counts.green || 0)}</b> of {plural(agents.length, 'agent')} are healthy;{' '}
      <b>{fmtNum(kpis.attention)}</b> need attention ({fmtNum(counts.red || 0)} action required, {fmtNum(counts.amber || 0)} watch)
      {counts.unknown ? <>, and {fmtNum(counts.unknown)} could not be rated (no data)</> : null}.
    </>
  );
  if (kpis.highRisk.length) {
    pts.push(
      <>
        <b>Act now in production:</b> {kpis.highRisk.slice(0, 4).map((a) => a.name).join(', ')}
        {kpis.highRisk.length > 4 ? ` and ${kpis.highRisk.length - 4} more` : ''}.
      </>
    );
  } else {
    pts.push(<>No production agent has a metric past its Action limit.</>);
  }
  const issues = {};
  agents.forEach((a) => new Set(a.alerts.map((x) => x.metric)).forEach((m) => (issues[m] = (issues[m] || 0) + 1)));
  const topIssue = Object.entries(issues).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
  if (topIssue) pts.push(<>Most common issue: <b>{topIssue[0]}</b> ({plural(topIssue[1], 'agent')}).</>);
  if (kpis.nonCompliant) {
    const fails = {};
    agents.forEach((a) => a.compliance.filter((c) => !c.pass).forEach((c) => (fails[c.name] = (fails[c.name] || 0) + 1)));
    const topFail = Object.entries(fails).sort((x, y) => y[1] - x[1])[0];
    pts.push(
      <>
        <b>{plural(kpis.nonCompliant, 'agent is', 'agents are')}</b> out of AI policy{topFail ? <>, most often failing “{topFail[0]}”</> : null}.
      </>
    );
  }
  pts.push(
    kpis.spend !== null ? (
      <>
        Estimated spend over the {periodOf(days).short} is <b>{fmtUsd(kpis.spend)}</b>
        {kpis.overBudget ? <>; <b>{plural(kpis.overBudget, 'agent is', 'agents are')}</b> over budget</> : <>; no agent is over budget</>}.
      </>
    ) : (
      <>Cost cannot be estimated yet — no usage data is connected.</>
    )
  );
  return pts;
}

function KpiTile({ label, value, sub, tone, def, onClick, action = 'View agents' }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`kpi ${onClick ? 'clickable' : ''}`} onClick={onClick} type={onClick ? 'button' : undefined}>
      <span className="kpi-label">
        {label} <Tip text={def} />
      </span>
      <b className={`kpi-value ${tone || ''}`}>{value}</b>
      <span className="kpi-sub">{sub}</span>
      {onClick && (
        <span className="kpi-action">
          {action} <ArrowRight size={13} />
        </span>
      )}
    </Tag>
  );
}

function PillarGlance({ pillar, agents, goAgents }) {
  const meta = PILLAR_META[pillar];
  const Icon = meta.icon;
  const counts = countBy(agents, (a) => a.statuses[pillar]);
  const issues = {};
  agents.forEach((a) => a.alerts.filter((x) => x.pillar === pillar).forEach((x) => (issues[x.metric] = (issues[x.metric] || 0) + 1)));
  const top = Object.entries(issues).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
  const attention = (counts.red || 0) + (counts.amber || 0);
  return (
    <div className="glance">
      <div className="glance-head">
        <Icon size={18} aria-hidden="true" />
        <div>
          <b>{meta.name}</b>
          <span>{meta.question}</span>
        </div>
      </div>
      <StatusSplit counts={counts} total={agents.length} label={`${meta.name} status of agents`} />
      <dl className="glance-facts">
        <div><dt>Need attention</dt><dd>{plural(attention, 'agent')}</dd></div>
        <div><dt>Most common issue</dt><dd>{top ? `${top[0]} (${top[1]})` : 'None'}</dd></div>
      </dl>
      <button className="link-btn" type="button" onClick={() => goAgents({ pillar, status: 'attention' })} disabled={!attention}>
        See {meta.name.toLowerCase()} issues <ArrowRight size={13} />
      </button>
    </div>
  );
}

function Overview({ agents, days, library, kpis, goAgents, openAgent }) {
  const series = useMemo(() => aggregateSeries(agents), [agents]);
  const failMetric = library?.metrics?.find((m) => m.id === 'failed_execution_rate');
  const thresholds = failMetric?.thresholds || { green: 2, amber: 5 };
  const points = series.map((s) => ({ t: s.t, n: s.conversations, value: s.conversations ? Math.round((1000 * s.failed) / s.conversations) / 10 : null }));
  const portfolioStatus = worst(agents.map((a) => a.statuses.overall));
  const healthy = agents.filter((a) => a.statuses.overall === 'green').length;
  const keyPoints = buildKeyPoints({ agents, kpis, days });
  const p = periodOf(days);

  const departments = useMemo(() => {
    const m = {};
    agents.forEach((a) => {
      const d = (m[a.department] ||= { name: a.department, agents: [], counts: {} });
      d.agents.push(a);
      d.counts[a.statuses.overall] = (d.counts[a.statuses.overall] || 0) + 1;
    });
    return Object.values(m).sort((x, y) => (x.name === 'Unassigned') - (y.name === 'Unassigned') || y.agents.length - x.agents.length || x.name.localeCompare(y.name));
  }, [agents]);

  const needAction = agents.filter((a) => ['red', 'amber'].includes(a.statuses.overall));

  return (
    <>
      <section className="summary">
        <div className="summary-status">
          <span className="eyebrow">Overall status · {p.label}</span>
          <StatusBadge value={portfolioStatus} size="lg" />
          <div className="summary-figure">
            <b>{healthy}</b>
            <span>
              of {plural(agents.length, 'agent')}
              <br />
              healthy
            </span>
          </div>
          <span className="summary-note">The overall status is the worst status of any agent.</span>
        </div>
        <div className="summary-points">
          <span className="eyebrow">What leadership should know</span>
          <ul>
            {keyPoints.map((pt, i) => (
              <li key={i}>{pt}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="kpi-grid" aria-label="Key figures">
        <KpiTile label="Agents monitored" value={fmtNum(kpis.monitored)} sub={`${kpis.production} in production · ${kpis.departments} departments`} def={KPI_DEFS.monitored} onClick={() => goAgents({})} />
        <KpiTile label="Need attention" value={fmtNum(kpis.attention)} tone={kpis.attention ? 'amber' : 'green'} sub="Watch or Action required" def={KPI_DEFS.attention} onClick={() => goAgents({ status: 'attention' })} />
        <KpiTile label="Act now (in production)" value={fmtNum(kpis.highRisk.length)} tone={kpis.highRisk.length ? 'red' : 'green'} sub="Production agents past an Action limit" def={KPI_DEFS.highRisk}
          onClick={() => goAgents({ status: 'red', environment: 'Production' })} />
        <KpiTile label="Out of AI policy" value={fmtNum(kpis.nonCompliant)} tone={kpis.nonCompliant ? 'red' : 'green'} sub="Failing an automatic governance check" def={KPI_DEFS.compliance}
          onClick={() => goAgents({ nonCompliantOnly: true })} />
        <KpiTile label="Conversations" value={fmtNum(kpis.conversations)} sub={`Engaged conversations · ${p.short}`} def={KPI_DEFS.conversations} />
        <KpiTile label="Estimated spend" value={kpis.spend !== null ? fmtUsd(kpis.spend) : 'Not available'} tone={kpis.spend === null ? 'muted' : kpis.overBudget ? 'amber' : ''}
          sub={kpis.spend !== null ? `Estimate · ${kpis.overBudget ? `${kpis.overBudget} over budget` : 'all within budget'}` : 'No usage data connected'} def={KPI_DEFS.spend}
          onClick={kpis.overBudget ? () => goAgents({ pillar: 'cost', status: 'attention' }) : undefined} action="View cost issues" />
        <KpiTile label="Open alerts" value={fmtNum(kpis.alerts)} tone={kpis.alerts ? 'amber' : 'green'} sub="Metrics at Watch or Action" def={KPI_DEFS.alerts} />
        <KpiTile label="Data coverage" value={`${kpis.coverage}%`} tone={kpis.coverage < 50 ? 'amber' : ''} sub="Metrics with enough data to rate" def={KPI_DEFS.coverage} />
      </section>

      <Panel title="Health, risk and cost at a glance" subtitle="Number of agents in each status, per area. Each bar segment shows its agent count." helpSection="status" right={<Legend items={STATUS_LEGEND} title="Status colours" />}>
        <div className="glance-grid">
          {PILLARS.map((pl) => (
            <PillarGlance key={pl} pillar={pl} agents={agents} goAgents={goAgents} />
          ))}
        </div>
      </Panel>

      <div className="chart-grid">
        <Panel title="Conversations over time" subtitle={`Engaged conversations per ${days === 1 ? 'hour' : 'day'}, all agents · ${p.label.toLowerCase()}`}
          tip="Each bar is one hour or day. Colours show how those conversations ended.">
          <VolumeChart series={series} days={days} title="Conversations over time" />
        </Panel>
        <Panel title="Conversations with errors" subtitle={`Share of conversations that hit a runtime error, all agents · ${p.label.toLowerCase()}`} helpSection="health"
          tip="Same limits as the “Conversations with errors” health metric. Safety blocks are excluded and reported under Risk.">
          <TrendChart points={points} thresholds={thresholds} days={days} title="Conversations with errors over time" xTitle={days === 1 ? 'Hour (your local time)' : 'Day'}
            yTitle="% of conversations with an error" seriesLabel="% of conversations with an error" />
        </Panel>
      </div>

      <Panel title="Status by department" subtitle="Select a department to see its agents." right={<Legend items={STATUS_LEGEND} title="Status colours" />}>
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

      <Panel title="Agents needing action" subtitle="Worst first. Select a row to see the evidence." tip="Agents whose overall status is Action required or Watch.">
        {needAction.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Department</th>
                  <th scope="col">Used in</th>
                  <th scope="col">Overall</th>
                  {PILLARS.map((pl) => <th key={pl} scope="col">{PILLAR_META[pl].name}</th>)}
                  <th scope="col">Main issue</th>
                </tr>
              </thead>
              <tbody>
                {needAction.map((a) => (
                  <tr key={a.id} onClick={() => openAgent(a.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && openAgent(a.id)}>
                    <td><b>{a.name}</b></td>
                    <td>{a.department}</td>
                    <td>{a.environment}</td>
                    <td><StatusBadge value={a.statuses.overall} size="sm" /></td>
                    {PILLARS.map((pl) => <td key={pl}><StatusBadge value={a.statuses[pl]} size="sm" /></td>)}
                    <td className="issue">{a.alerts[0] ? <><b>{a.alerts[0].metric}</b> {a.alerts[0].value}</> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="chart-empty">No agent currently needs action.</div>
        )}
      </Panel>
    </>
  );
}

/* ================================================================ agents tab */
const EMPTY_FILTERS = {
  status: 'all',
  pillar: 'overall',
  environment: 'all',
  department: 'all',
  location: 'all',
  owner: 'all',
  platform: 'all',
  riskTier: 'all',
  nonCompliantOnly: false,
  query: '',
};

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
    if (q && !`${a.name} ${a.purpose} ${a.department} ${a.businessOwner || ''} ${a.technicalOwner || ''} ${a.telemetryNames?.join(' ')}`.toLowerCase().includes(q)) return false;
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
      <p className="purpose">{agent.purpose}</p>
      <p className={`headline ${agent.statuses.overall}`}>{agentHeadline(agent)}</p>
      <div className="pillar-row" role="group" aria-label="Status by area">
        {PILLARS.map((p) => {
          const Icon = PILLAR_META[p].icon;
          return (
            <button key={p} className={`pillar-chip ${agent.statuses[p]}`} type="button" onClick={(e) => { e.stopPropagation(); openAgent(agent.id, p); }}
              title={`Open ${PILLAR_META[p].name} evidence`}>
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

function Agents({ agents, filters, setFilters, groupBy, setGroupBy, openAgent }) {
  const [collapsed, setCollapsed] = useState({});
  const [more, setMore] = useState(false);
  const opts = (field, allLabel = 'All') => [
    { value: 'all', label: allLabel },
    ...[...new Set(agents.map((a) => fieldValue(a, field)))].sort().map((v) => ({ value: v, label: v })),
  ];
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

  const active = Object.entries(filters).filter(([k, v]) => v !== EMPTY_FILTERS[k] && !(k === 'pillar' && filters.status === 'all'));
  const describe = ([k, v]) => {
    if (k === 'status') return `${filters.pillar !== 'overall' ? PILLAR_META[filters.pillar].name : 'Status'}: ${v === 'attention' ? 'Need attention' : STATUS_LABELS[v]}`;
    if (k === 'pillar') return null;
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
          <SelectField label="Status of" value={filters.pillar} onChange={(v) => set({ pillar: v })}
            options={[{ value: 'overall', label: 'Overall' }, ...PILLARS.map((p) => ({ value: p, label: PILLAR_META[p].name }))]} />
          <SelectField label="Department" tip="From the AI inventory." value={filters.department} onChange={(v) => set({ department: v })} options={opts('department', 'All departments')} />
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
            <SelectField label="Location" tip="From the AI inventory." value={filters.location} onChange={(v) => set({ location: v })} options={opts('location', 'All locations')} />
            <SelectField label="Business owner" value={filters.owner} onChange={(v) => set({ owner: v })} options={opts('owner', 'All owners')} />
            <SelectField label="Platform" value={filters.platform} onChange={(v) => set({ platform: v })} options={opts('platform', 'All platforms')} />
            <SelectField label="Risk tier" tip="Inherent risk tier assigned at intake (AI inventory)." value={filters.riskTier} onChange={(v) => set({ riskTier: v })} options={opts('riskTier', 'All tiers')} />
          </div>
        )}
      </section>

      <div className="result-line" aria-live="polite">
        Showing <b>{shown.length}</b> of {plural(agents.length, 'agent')}
        {groupBy !== 'none' && <> in {plural(groups.length, 'group')}</>}
        {active.length > 0 && (
          <span className="active-filters">
            {active.map((f) => {
              const text = describe(f);
              return text ? (
                <button key={f[0]} type="button" className="chip on" onClick={() => set({ [f[0]]: EMPTY_FILTERS[f[0]], ...(f[0] === 'status' ? { pillar: 'overall' } : {}) })} title="Remove filter">
                  {text} <X size={12} />
                </button>
              ) : null;
            })}
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
            {!isCollapsed && (
              <div className="agent-grid">
                {g.agents.map((a) => <AgentCard key={a.id} agent={a} openAgent={openAgent} />)}
              </div>
            )}
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

function AgentDetail({ agent, pillar, setPillar, back, days, library }) {
  const openHelp = useHelp();
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
      <button className="back" onClick={back} type="button"><ArrowLeft size={15} /> Back</button>
      <section className={`agent-hero edge-${agent.statuses.overall}`}>
        <div className="ah-main">
          <span className="eyebrow">{agent.platform}</span>
          <h2>{agent.name}</h2>
          <p>{agent.purpose}</p>
          <p className={`headline big ${agent.statuses.overall}`}>
            <b>{STATUS_LABELS[agent.statuses.overall]}:</b> {agentHeadline(agent)}
          </p>
        </div>
        <div className="ah-status">
          <span className="field-label">Overall status</span>
          <StatusBadge value={agent.statuses.overall} size="lg" />
          <span className="field-label">AI policy</span>
          {agent.compliant ? <span className="comp ok pill"><CheckCircle2 size={14} /> In policy</span> : <span className="comp bad pill"><XCircle size={14} /> Out of policy</span>}
        </div>
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
              <Icon size={20} aria-hidden="true" />
              <span className="pt-copy">
                <b>{PILLAR_META[p].name}</b>
                <small>{PILLAR_META[p].question} · {n} of {agent.metrics[p].length} measured</small>
              </span>
              <StatusBadge value={agent.statuses[p]} size="sm" />
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
              <ul>
                {unmeasured.map((m) => (
                  <li key={m.id}><b>{m.name}</b> — {m.why}</li>
                ))}
              </ul>
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
              <div>
                <dt>{agent.billing === 'tokens' ? 'Tokens' : 'Copilot Credits (est.)'}</dt>
                <dd>{agent.billing === 'tokens' ? fmtNum(agent.tokens) : agent.billing === 'included' ? 'Included' : fmtNum(agent.credits)}</dd>
              </div>
              <div><dt>Est. spend</dt><dd>{agent.billing === 'included' ? 'Included' : fmtUsd(agent.spendUsd)}</dd></div>
              <div><dt>Budget for period</dt><dd>{agent.budgetUsd ? fmtUsd(agent.budgetUsd) : 'Not set'}</dd></div>
            </dl>
          </Panel>
          <Panel title="AI policy checks" helpSection="policy" tip="Automatic: telemetry compared with the AI inventory record. No manual attestation.">
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
            <Panel title="Most frequent error codes" tip="Error codes recorded by the platform in the period. Raw messages are not shown.">
              <table className="table compact">
                <thead><tr><th scope="col">Code</th><th scope="col">Meaning</th><th scope="col">Count</th></tr></thead>
                <tbody>
                  {agent.topErrorCodes.map((c) => {
                    const code = typeof c === 'string' ? c : c.code;
                    return (
                      <tr key={code}>
                        <td><code>{code}</code></td>
                        <td>{ERROR_HELP[code] || 'See the Copilot Studio error-code reference'}</td>
                        <td>{typeof c === 'string' ? '—' : fmtNum(c.count)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          )}
          <Panel title="Telemetry names" tip="Names under which this agent appears in telemetry. Add any missing ones to the inventory record’s aliases.">
            <div className="codes">{(agent.telemetryNames || [agent.id]).map((n) => <code key={n}>{n}</code>)}</div>
          </Panel>
        </div>
      </div>
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
          One shared rulebook sits behind every colour on this dashboard. Each metric is compared with fixed limits to give <b>Healthy</b>, <b>Watch</b> or{' '}
          <b>Action required</b>. An area takes the worst of its metrics, and an agent takes the worst of Health, Risk and Cost. Metrics without enough data show{' '}
          <b>No data</b> and are never counted as healthy.
        </p>
        <p className="muted">
          {counts.live || 0} metrics are measured today · {counts.conditional || 0} when their source is connected · {counts['not-available'] || 0} defined and waiting for a data source.
        </p>
      </section>
      <Panel title="Metric library" helpSection="health" right={<Segmented label="Area" value={pillar} onChange={setPillar}
        options={[{ value: 'all', label: 'All areas' }, ...PILLARS.map((p) => ({ value: p, label: PILLAR_META[p].name }))]} />}>
        <div className="table-wrap">
          <table className="table lib">
            <thead>
              <tr>
                <th scope="col">Area</th>
                <th scope="col">Metric</th>
                <th scope="col">What it tells you</th>
                <th scope="col">How it’s calculated</th>
                <th scope="col">Limits</th>
                <th scope="col">Why these limits</th>
                <th scope="col">Data</th>
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
      <Panel title="AI policy checks" subtitle="Drive the “Out of AI policy” figure. Evaluated automatically against the AI inventory.">
        <table className="table">
          <thead><tr><th scope="col">Check</th><th scope="col">Rule</th></tr></thead>
          <tbody>{library.compliance.map((c) => <tr key={c.id}><td><b>{c.name}</b></td><td>{c.definition}</td></tr>)}</tbody>
        </table>
      </Panel>
    </>
  );
}

/* =============================================================== data sources */
function DataSources({ payload, agents, mode }) {
  const s = payload?.sources || {};
  const unregistered = agents.filter((a) => !a.registered);
  const silent = agents.filter((a) => !a.allConversations);
  const rows = [
    ['Data as of', fmtDateTime(payload?.generatedAt)],
    ['Data mode', mode === 'live' ? 'Live telemetry' : mode === 'demo' ? 'Demo data (synthetic, not live)' : 'Unavailable'],
    ['Reporting period', payload?.window ? `${fmtDateTime(payload.window.start)} → ${fmtDateTime(payload.window.end)}` : periodOf(payload?.lookbackDays || 7).label],
    ['Telemetry source', s.telemetry || '—'],
    ['Agents with telemetry', agents.length - silent.length],
    ['Registered but silent', silent.length],
    ['AI inventory source', s.inventoryLabel || '—'],
    ['Inventory records', s.inventoryRecords ?? '—'],
    ['Agents not in inventory', unregistered.length],
    ['Token telemetry (Foundry)', s.costTelemetry || '—'],
    ['Pricing', s.pricing || '—'],
    ['Slow-reply limit', s.slowReplySeconds ? `${s.slowReplySeconds} seconds` : '—'],
    ['Query time', payload?.queryMs ? `${(payload.queryMs / 1000).toFixed(1)} s${payload.cached ? ' (served from 1-minute cache)' : ''}` : '—'],
  ];
  return (
    <div className="checks-grid">
      <Panel title="What was loaded" subtitle="Sources and record counts behind every page.">
        {s.inventory === 'file' && (
          <div className="warn"><AlertTriangle size={15} /> The AI inventory is the bundled stand-in file. Connect INVENTORY_URL to the system of record before client use.</div>
        )}
        {s.inventory === 'error' && (
          <div className="warn"><AlertTriangle size={15} /> The AI inventory could not be loaded ({s.inventoryLabel}). All agents show as unregistered.</div>
        )}
        <dl className="kv">
          {rows.map(([k, v]) => (<React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>))}
        </dl>
        {unregistered.length > 0 && (
          <>
            <h4 className="mini-head">Agents in telemetry without an inventory record</h4>
            <p className="muted small">Add one of these names to the inventory record’s <code>id</code> or <code>aliases</code>; the agent picks up its profile on the next refresh.</p>
            <div className="codes">{unregistered.map((a) => <code key={a.id}>{a.id}</code>)}</div>
          </>
        )}
        {s.aliasClashes?.length > 0 && (
          <>
            <h4 className="mini-head">Names used by more than one inventory record</h4>
            <div className="codes">{s.aliasClashes.map((n) => <code key={n}>{n}</code>)}</div>
          </>
        )}
      </Panel>
      <Panel title="How the figures are built" subtitle="Method notes for executive reporting." helpSection="data">
        <div className="method">
          <p><b>Agents.</b> Every conversation is assigned to exactly one agent: the topic schema name (stable across renames), else the bot name. All names are mapped to the AI inventory record, so an agent never appears twice or changes identity between refreshes.</p>
          <p><b>Conversations.</b> Only engaged conversations count — a user sent at least one message. Greeting-only sessions are excluded.</p>
          <p><b>Statuses.</b> Each metric is rated against the limits in the metric library. An area takes its worst metric and an agent its worst area. Metrics without enough data are “No data” and never count as healthy.</p>
          <p><b>Health.</b> Replies vs user messages; conversations resolved without an error, escalation or fallback; 95th-percentile response time; very slow replies; conversations with errors; flow / connector failures.</p>
          <p><b>Risk.</b> Responsible AI blocks read from error sub-codes: jailbreaks (OpenAIJailBreak), attacks in documents (OpenAIndirectAttack), harmful content (OpenAIHate / Sexual / Violence / SelfHarm) and DLP blocks. These are excluded from Health errors so nothing is counted twice.</p>
          <p><b>Cost.</b> Copilot Studio: answered messages × credits per response × price per credit (an estimate; the billed figure is in the Power Platform admin center). Foundry: tokens × model price.</p>
          <p><b>Freshness.</b> Application Insights ingestion usually lags a few minutes. All queries use the same fixed time window.</p>
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

function App() {
  const initial = readHash();
  const [payload, setPayload] = useState(null);
  const [mode, setMode] = useState('loading'); // what is on screen: loading | live | demo | error
  const [source, setSource] = useState('live'); // what the user asked for: live | demo
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(null);
  const [days, setDays] = useState(7);
  const [tab, setTab] = useState(initial.tab);
  const [selected, setSelected] = useState(initial.id ? { id: initial.id, pillar: initial.pillar } : null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [groupBy, setGroupBy] = useState('department');
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [helpSection, setHelpSection] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('agent-theme') || 'light');
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

  // Keep the URL in step so browser Back works and views can be bookmarked.
  useEffect(() => {
    const next = selected ? `#/agents/${encodeURIComponent(selected.id)}/${selected.pillar}` : `#/${tab}`;
    if (window.location.hash !== next) window.history.pushState(null, '', next);
  }, [tab, selected]);
  useEffect(() => {
    const onPop = () => {
      const h = readHash();
      setTab(h.tab);
      setSelected(h.id ? { id: h.id, pillar: h.pillar } : null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** Only the newest request may update the screen; older ones are aborted or ignored. */
  const load = useCallback(async (d, { fresh = false } = {}) => {
    const id = ++reqId.current;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/agents?days=${d}${fresh === true ? '&fresh=1' : ''}`, { cache: 'no-store', signal: ctrl.signal });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.mode === 'error' || !Array.isArray(body.agents)) throw new Error(body?.message || `The data service returned ${res.status}`);
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
        setStale(new Date().toISOString()); // keep last good figures, clearly flagged
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
  const library = payload?.library;

  const kpis = useMemo(() => {
    // Coverage ignores metrics that are defined but have no data source anywhere yet (they would always be grey).
    const notYet = new Set((library?.metrics || []).filter((m) => m.availability === 'not-available').map((m) => m.id));
    const applicable = agents
      .flatMap((a) => [...a.metrics.health, ...a.metrics.risk, ...a.metrics.cost])
      .filter((m) => !m.informational && !notYet.has(m.id));
    const spends = agents.map((a) => a.spendUsd).filter((v) => v !== null && v !== undefined);
    return {
      monitored: agents.length,
      departments: new Set(agents.map((a) => a.department)).size,
      production: agents.filter((a) => a.environment === 'Production').length,
      conversations: agents.reduce((s, a) => s + (a.volume || 0), 0),
      attention: agents.filter((a) => ['red', 'amber'].includes(a.statuses.overall)).length,
      alerts: agents.reduce((s, a) => s + a.alerts.length, 0),
      highRisk: agents.filter((a) => a.environment === 'Production' && a.statuses.overall === 'red'),
      nonCompliant: agents.filter((a) => !a.compliant).length,
      spend: spends.length ? spends.reduce((s, v) => s + v, 0) : null,
      overBudget: agents.filter((a) => a.metrics.cost.some((m) => m.id === 'spend' && m.rawValue > 100)).length,
      coverage: applicable.length ? Math.round((100 * applicable.filter((m) => m.status !== 'unknown').length) / applicable.length) : 0,
    };
  }, [agents, library]);

  const selectedAgent = selected ? agents.find((a) => a.id === selected.id) : null;

  const openAgent = (id, pillar = 'health') => {
    setSelected({ id, pillar });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const goAgents = (patch) => {
    setFilters({ ...EMPTY_FILTERS, ...patch });
    setSelected(null);
    setTab('agents');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const refresh = () => (source === 'demo' ? loadDemo(days) : load(days, { fresh: true }));

  return (
    <HelpContext.Provider value={setHelpSection}>
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
            <button className="ghost small" type="button" onClick={() => (source === 'live' ? load(days) : setSource('live'))}>Switch to live data</button>
          </div>
        )}
        {mode === 'loading' && !payload && <div className="chart-empty">Loading telemetry…</div>}
        {payload && selected && !selectedAgent && (
          <Panel title="Agent not found in this period">
            <p className="muted">“{selected.id}” has no data for {periodOf(days).label.toLowerCase()}. Try a longer reporting period.</p>
            <button className="ghost small" type="button" onClick={() => setSelected(null)}><ArrowLeft size={14} /> Back</button>
          </Panel>
        )}
        {payload &&
          (selectedAgent ? (
            <AgentDetail agent={selectedAgent} pillar={selected.pillar} setPillar={(p) => setSelected((s) => ({ ...s, pillar: p }))} back={() => setSelected(null)} days={days} library={library} />
          ) : selected ? null : tab === 'overview' ? (
            <Overview agents={agents} days={days} library={library} kpis={kpis} goAgents={goAgents} openAgent={openAgent} />
          ) : tab === 'agents' ? (
            <Agents agents={agents} filters={filters} setFilters={setFilters} groupBy={groupBy} setGroupBy={setGroupBy} openAgent={openAgent} />
          ) : tab === 'library' ? (
            <Library library={library} />
          ) : (
            <DataSources payload={payload} agents={agents} mode={mode} />
          ))}
      </main>
      {helpSection && <Help close={() => setHelpSection(null)} library={library} kpiDefs={KPI_DEFS} initialSection={helpSection} sources={payload?.sources} mode={mode} />}
    </HelpContext.Provider>
  );
}

const rootEl = typeof document !== 'undefined' ? document.getElementById('root') : null;
if (rootEl) createRoot(rootEl).render(<App />);

export { App, Overview, Agents, AgentDetail, Library, DataSources };
