import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  DollarSign,
  HelpCircle,
  Info,
  Moon,
  RefreshCw,
  Search,
  ShieldCheck,
  Sun,
  X,
  XCircle,
} from 'lucide-react';
import Help, { HelpButton } from './Help.jsx';
import './styles.css';

/* ------------------------------------------------------------------ constants */

const STATUS_LABELS = { green: 'Healthy', amber: 'Watch', red: 'Action required', unknown: 'No data' };
const STATUS_ORDER = ['red', 'amber', 'green', 'unknown'];
const PILLARS = ['health', 'risk', 'cost'];
const PILLAR_ICON = { health: Activity, risk: ShieldCheck, cost: DollarSign };
const PERIODS = [
  { days: 1, label: 'Last 24 hours' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];
const TABS = [
  { id: 'overview', label: 'Executive Overview' },
  { id: 'portfolio', label: 'Agent Portfolio' },
  { id: 'library', label: 'Metric Library' },
  { id: 'checks', label: 'Data Checks' },
];
const GROUP_FIELDS = {
  department: 'Department',
  location: 'Location',
  platform: 'Platform',
  environment: 'Environment',
  none: 'No grouping',
};
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let openHelpAt = () => {};

const KPI_DEFS = {
  monitored: 'Agents that sent runtime telemetry in the period, plus registered agents that went silent.',
  production: 'Agents with live (non test-canvas) traffic in the period. Derived from the Copilot Studio DesignMode flag.',
  attention: 'Agents whose overall status is Watch or Action required.',
  alerts: 'Number of individual metrics currently outside their green threshold, across all agents.',
  highRisk: 'Production agents with at least one red metric — candidates for immediate remediation.',
  compliance: 'Agents failing one or more automatic AI-policy checks (inventory registration, owners, risk tier, approval, telemetry).',
  spend: 'Estimated model spend for the period from token telemetry × configured price list.',
  coverage: 'Share of applicable metrics with enough telemetry to calculate a status. Grey = data gap, never healthy.',
};

const EMPTY_FILTERS = {
  status: 'all',
  environments: [],
  department: 'all',
  location: 'all',
  owner: 'all',
  platform: 'all',
  riskTier: 'all',
  nonCompliantOnly: false,
  query: '',
};

/* -------------------------------------------------------------------- helpers */

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
const fmtDateTime = (d) =>
  d
    ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';
const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
const fmtUsd = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const periodLabel = (days) => PERIODS.find((p) => p.days === days)?.label || `Last ${days} days`;
const worst = (list) => list.reduce((w, s) => (STATUS_ORDER.indexOf(s) < STATUS_ORDER.indexOf(w) ? s : w), 'unknown');

function fieldValue(agent, field) {
  if (field === 'owner') return agent.businessOwner || 'Unassigned';
  return agent[field] || 'Unassigned';
}

function aggregateSeries(agents) {
  const buckets = {};
  agents.forEach((a) =>
    (a.series || []).forEach((p) => {
      const b = (buckets[p.t] ||= { t: p.t, conversations: 0, failed: 0, completed: 0 });
      b.conversations += p.conversations;
      b.failed += p.failed;
      b.completed += p.completed;
    })
  );
  return Object.values(buckets).sort((a, b) => new Date(a.t) - new Date(b.t));
}

function bucketLabel(t, days) {
  const d = new Date(t);
  return days === 1
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/* ----------------------------------------------------------------- primitives */

function Status({ value, compact = false, onClick }) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag className={`status ${value} ${compact ? 'compact' : ''}`} onClick={onClick} type={onClick ? 'button' : undefined}>
      <i />
      {STATUS_LABELS[value] || value}
    </Tag>
  );
}

function Tip({ text }) {
  return (
    <span className="tip" tabIndex={0} aria-label={text}>
      <Info size={13} />
      <span className="tip-body">{text}</span>
    </span>
  );
}

function Segmented({ options, value, onChange }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)} type="button">
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Panel({ title, subtitle, tip, right, children, className = '', help }) {
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <div className="panel-head">
          <div>
            {title && (
              <h3>
                {title} {tip && <Tip text={tip} />}
                {help && <HelpButton onClick={help} label="Learn how this works" />}
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

/* --------------------------------------------------------------------- charts */

/** Line chart over coloured threshold bands (mirrors the Risk Posture view). */
function BandChart({ points, green, amber, days, unit = '%' }) {
  if (!points.length) return <div className="chart-empty">No activity in this period</div>;
  const W = 1000, H = 250, L = 48, R = 104, T = 22, B = 34;
  const values = points.map((p) => p.value);
  const top = Math.max(amber * 2, Math.ceil(Math.max(...values.filter((v) => v !== null), 0) * 1.2), 1);
  const x = (i) => L + (i * (W - L - R)) / Math.max(points.length - 1, 1);
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const valid = points.map((p, i) => ({ ...p, i })).filter((p) => p.value !== null);
  const path = valid.map((p, k) => `${k ? 'L' : 'M'}${x(p.i)},${y(p.value)}`).join(' ');
  const ticks = [0, top / 4, top / 2, (3 * top) / 4, top];
  const labelEvery = Math.ceil(points.length / 8);
  return (
    <svg className="band-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Trend with threshold bands">
      <rect className="band red" x={L} y={y(top)} width={W - L - R} height={y(amber) - y(top)} />
      <rect className="band amber" x={L} y={y(amber)} width={W - L - R} height={y(green) - y(amber)} />
      <rect className="band green" x={L} y={y(green)} width={W - L - R} height={y(0) - y(green)} />
      {ticks.map((t) => (
        <text key={t} className="axis" x={L - 8} y={y(t) + 4} textAnchor="end">
          {Math.round(t * 10) / 10}
          {unit}
        </text>
      ))}
      <text className="band-label red" x={W - R + 18} y={y(top) + 16}>Action</text>
      <text className="band-label amber" x={W - R + 18} y={(y(amber) + y(green)) / 2 + 4}>Watch</text>
      <text className="band-label green" x={W - R + 18} y={(y(green) + y(0)) / 2 + 4}>Healthy</text>
      <path d={path} className="trend-line" />
      {valid.map((p) => (
        <g key={p.i}>
          <circle cx={x(p.i)} cy={y(p.value)} r="5" className="trend-dot">
            <title>{`${bucketLabel(p.t, days)}: ${p.value}${unit} (${p.n} conversations)`}</title>
          </circle>
          {points.length <= 14 && (
            <text className="point-label" x={x(p.i)} y={y(p.value) - 10} textAnchor="middle">
              {p.value}
            </text>
          )}
        </g>
      ))}
      {points.map((p, i) =>
        i % labelEvery === 0 || i === points.length - 1 ? (
          <text key={`x${i}`} className="axis" x={x(i)} y={H - 10} textAnchor="middle">
            {bucketLabel(p.t, days)}
          </text>
        ) : null
      )}
    </svg>
  );
}

/** Stacked bars: completed / other / failed conversations per bucket. */
function VolumeBars({ series, days }) {
  if (!series.length) return <div className="chart-empty">No activity in this period</div>;
  const W = 520, H = 170, L = 8, B = 22, T = 8;
  const max = Math.max(...series.map((s) => s.conversations), 1);
  const bw = (W - L * 2) / series.length;
  const h = (v) => (v / max) * (H - T - B);
  return (
    <svg className="volume-bars" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Conversations over time">
      {series.map((s, i) => {
        const other = Math.max(s.conversations - s.completed - s.failed, 0);
        let yy = H - B;
        const seg = (v, cls) => {
          const hh = h(v);
          yy -= hh;
          return hh > 0 ? <rect key={cls} className={cls} x={L + i * bw + bw * 0.15} y={yy} width={bw * 0.7} height={hh} rx="2" /> : null;
        };
        return (
          <g key={s.t}>
            <title>{`${bucketLabel(s.t, days)} · ${s.conversations} conversations · ${s.completed} completed · ${s.failed} failed`}</title>
            {seg(s.completed, 'bar-ok')}
            {seg(other, 'bar-other')}
            {seg(s.failed, 'bar-fail')}
          </g>
        );
      })}
      <text className="axis" x={L} y={H - 4}>{bucketLabel(series[0].t, days)}</text>
      <text className="axis" x={W - L} y={H - 4} textAnchor="end">{bucketLabel(series.at(-1).t, days)}</text>
    </svg>
  );
}

function StatusBar({ counts, total }) {
  return (
    <div className="status-bar">
      {STATUS_ORDER.map((s) =>
        counts[s] ? <span key={s} className={s} style={{ width: `${(counts[s] / total) * 100}%` }} title={`${counts[s]} ${STATUS_LABELS[s]}`} /> : null
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- header */

function Header({ payload, mode, agents, theme, toggleTheme, refresh, refreshing, openDefs, openHelp }) {
  const conversations = agents.reduce((s, a) => s + (a.volume || 0), 0);
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <div className="brand-block">
          <div className="wordmark">Grant Thornton</div>
          <div className="title-block">
            <h1>AI Agent Runtime Monitoring | Executive Dashboard</h1>
            <p>Health, risk and cost across AI agents | Copilot Studio · Application Insights</p>
          </div>
        </div>
        <div className="masthead-actions">
          <div className="asof">
            <div>
              Data as of <b>{payload?.generatedAt ? fmtDateTime(payload.generatedAt) : '—'}</b>
              <span className={`mode-dot ${mode}`} title={mode} />
              {mode === 'demo' && <em className="demo-tag">Demo data</em>}
            </div>
            <div>
              {plural(agents.length, 'agent')} | {fmtNum(conversations)} conversations | {periodLabel(payload?.lookbackDays || 7).toLowerCase()}
            </div>
          </div>
          <button className="ghost" onClick={openHelp} type="button" title="How this dashboard works (shortcut: ?)">
            <HelpCircle size={15} /> How it works
          </button>
          <button className="ghost" onClick={openDefs} type="button">Definitions</button>
          <button className="ghost" onClick={toggleTheme} type="button">
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <button className="primary" onClick={refresh} type="button">
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </div>
    </header>
  );
}

function PeriodBar({ days, setDays, generatedAt, autoRefresh, setAutoRefresh }) {
  const end = generatedAt ? new Date(generatedAt) : new Date();
  const start = new Date(end.getTime() - days * 86400000);
  return (
    <div className="period-bar">
      <span className="label">
        Reporting period <Tip text="Every tile, status and chart uses this window. Statuses are recalculated from telemetry on each refresh." />
      </span>
      <Segmented options={PERIODS.map((p) => ({ value: p.days, label: p.label }))} value={days} onChange={setDays} />
      <span className="range">
        {fmtDate(start)} to {fmtDate(end)}
      </span>
      <label className="check">
        <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
        Near real-time (refresh every 5 min)
      </label>
    </div>
  );
}

/* --------------------------------------------------------- executive overview */

function buildNarrative({ agents, kpis, alertsByMetric, failingCheck }) {
  if (!agents.length) return null;
  const parts = [];
  const portfolio = worst(agents.map((a) => a.statuses.overall));
  parts.push(
    <>
      Portfolio runtime status is <b>{STATUS_LABELS[portfolio]}</b>: <b>{kpis.attention}</b> of {agents.length} agents need attention.{' '}
    </>
  );
  if (kpis.highRisk.length) {
    parts.push(
      <>
        <b>{plural(kpis.highRisk.length, 'production agent')}</b> {kpis.highRisk.length === 1 ? 'has' : 'have'} red alerts (
        <b>{kpis.highRisk.slice(0, 3).map((a) => a.name).join(', ')}</b>).{' '}
      </>
    );
  } else {
    parts.push(<>No production agent has a red alert. </>);
  }
  if (alertsByMetric[0]) {
    parts.push(
      <>
        Most frequent issue: <b>{alertsByMetric[0][0]}</b> ({plural(alertsByMetric[0][1], 'agent')}).{' '}
      </>
    );
  }
  if (kpis.nonCompliant) {
    parts.push(
      <>
        <b>{kpis.nonCompliant}</b> {kpis.nonCompliant === 1 ? 'agent is' : 'agents are'} out of policy
        {failingCheck ? (
          <>
            , most often for <b>{failingCheck}</b>
          </>
        ) : null}
        .{' '}
      </>
    );
  }
  parts.push(
    kpis.spend !== null ? (
      <>
        Estimated spend in the period is <b>{fmtUsd(kpis.spend)}</b>.
      </>
    ) : (
      <>Cost is not yet measurable — token telemetry is not connected.</>
    )
  );
  return parts;
}

function KpiTile({ label, value, sub, tone, def, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`kpi ${onClick ? 'clickable' : ''}`} onClick={onClick} type={onClick ? 'button' : undefined}>
      <span className="kpi-label">
        {label}
        {onClick && ' ›'} <Tip text={def} />
      </span>
      <b className={`kpi-value ${tone || ''}`}>{value}</b>
      {sub && <span className="kpi-sub">{sub}</span>}
    </Tag>
  );
}

function Overview({ agents, days, library, kpis, goPortfolio, openAgent }) {
  const series = useMemo(() => aggregateSeries(agents), [agents]);
  const failMetric = library?.metrics?.find((m) => m.id === 'failed_execution_rate');
  const [g, a] = failMetric?.threshold.match(/[\d.]+/g)?.map(Number) || [2, 5];
  const points = series.map((s) => ({
    t: s.t,
    n: s.conversations,
    value: s.conversations ? Math.round((1000 * s.failed) / s.conversations) / 10 : null,
  }));

  const alertsByMetric = useMemo(() => {
    const m = {};
    agents.forEach((ag) => new Set(ag.alerts.map((x) => x.metric)).forEach((name) => (m[name] = (m[name] || 0) + 1)));
    return Object.entries(m).sort((x, y) => y[1] - x[1]);
  }, [agents]);

  const failingCheck = useMemo(() => {
    const m = {};
    agents.forEach((ag) => ag.compliance.filter((c) => !c.pass).forEach((c) => (m[c.name] = (m[c.name] || 0) + 1)));
    return Object.entries(m).sort((x, y) => y[1] - x[1])[0]?.[0];
  }, [agents]);

  const departments = useMemo(() => {
    const m = {};
    agents.forEach((ag) => {
      const d = (m[ag.department] ||= { name: ag.department, agents: [], counts: {} });
      d.agents.push(ag);
      d.counts[ag.statuses.overall] = (d.counts[ag.statuses.overall] || 0) + 1;
    });
    return Object.values(m).sort((x, y) => y.agents.length - x.agents.length);
  }, [agents]);

  const portfolioStatus = worst(agents.map((ag) => ag.statuses.overall));
  const healthyCount = agents.filter((ag) => ag.statuses.overall === 'green').length;
  const needAction = agents
    .filter((ag) => ['red', 'amber'].includes(ag.statuses.overall))
    .sort((x, y) => STATUS_ORDER.indexOf(x.statuses.overall) - STATUS_ORDER.indexOf(y.statuses.overall));
  const narrative = buildNarrative({ agents, kpis, alertsByMetric, failingCheck });

  return (
    <>
      <section className="hero-card">
        <span className="eyebrow">
          Portfolio runtime status <Tip text="Worst overall status across all monitored agents." />
        </span>
        <div className="hero-row">
          <b className="hero-figure">
            {healthyCount}
            <small>/{agents.length}</small>
          </b>
          <div>
            <div className="hero-caption">agents healthy</div>
            <Status value={portfolioStatus} />
          </div>
        </div>
        <span className="hero-range">{periodLabel(days)}</span>
      </section>

      {narrative && (
        <div className="leadership">
          <span className="eyebrow-sm">
            What leadership should know <Tip text="Generated automatically from the current figures on this page." />
          </span>
          <p>{narrative}</p>
        </div>
      )}

      <div className="section-link">
        <button type="button" onClick={() => openHelpAt('tiles')}><HelpCircle size={14} /> What do these tiles mean?</button>
      </div>
      <section className="kpi-grid">
        <KpiTile label="Agents monitored" value={kpis.monitored} sub={`${kpis.departments} departments`} def={KPI_DEFS.monitored} onClick={() => goPortfolio({})} />
        <KpiTile label="In production" value={kpis.production} sub={`${kpis.monitored - kpis.production} not in production`} def={KPI_DEFS.production}
          onClick={() => goPortfolio({ environments: ['Production'] })} />
        <KpiTile label="Need attention" value={kpis.attention} tone={kpis.attention ? 'amber' : 'green'} sub="Watch or action required" def={KPI_DEFS.attention}
          onClick={() => goPortfolio({ status: 'attention' })} />
        <KpiTile label="Open alerts" value={kpis.alerts} tone={kpis.alerts ? 'amber' : 'green'} sub="Metrics outside threshold" def={KPI_DEFS.alerts} />
        <KpiTile label="High-severity in production" value={kpis.highRisk.length} tone={kpis.highRisk.length ? 'red' : 'green'} sub="Need immediate remediation"
          def={KPI_DEFS.highRisk} onClick={() => goPortfolio({ status: 'red', environments: ['Production'] })} />
        <KpiTile label="Out of AI policy" value={kpis.nonCompliant} tone={kpis.nonCompliant ? 'red' : 'green'} sub="Failing automatic checks"
          def={KPI_DEFS.compliance} onClick={() => goPortfolio({ nonCompliantOnly: true })} />
        <KpiTile label="Spend this period" value={kpis.spend !== null ? fmtUsd(kpis.spend) : kpis.tokens !== null ? fmtNum(kpis.tokens) : 'Not connected'}
          tone={kpis.spend === null && kpis.tokens === null ? 'muted' : ''} sub={kpis.spend === null && kpis.tokens !== null ? 'tokens (no price list)' : 'Token telemetry'}
          def={KPI_DEFS.spend} />
        <KpiTile label="Telemetry coverage" value={`${kpis.coverage}%`} tone={kpis.coverage < 50 ? 'amber' : ''} sub="Metrics with live data" def={KPI_DEFS.coverage} />
      </section>

      <Panel help={() => openHelpAt('status')} title="Failed conversation rate" subtitle={`Share of conversations that recorded a runtime error · ${periodLabel(days).toLowerCase()}`}
        tip="Same thresholds as the Failed execution rate health metric in the Metric Library.">
        <BandChart points={points} green={g} amber={a} days={days} />
      </Panel>

      <Panel help={() => openHelpAt('layout')} title={<><span className="level">Level 2</span> Departments</>} subtitle="Select a department to see its agents"
        right={<Legend />}>
        <div className="dept-grid">
          {departments.map((d) => (
            <button key={d.name} className="dept-card" onClick={() => goPortfolio({ department: d.name })} type="button">
              <div className="dept-top">
                <div>
                  <b>{d.name}</b>
                  <span>{plural(d.agents.length, 'agent')}</span>
                </div>
                <ChevronRight size={16} />
              </div>
              <StatusBar counts={d.counts} total={d.agents.length} />
              <div className="dept-counts">
                {STATUS_ORDER.map((s) => (d.counts[s] ? <span key={s} className={`dot-count ${s}`}><i />{d.counts[s]}</span> : null))}
              </div>
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Agents needing action" subtitle="Select a row to open the agent" tip="Agents with an overall Watch or Action required status, worst first.">
        {needAction.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th><th>Department</th><th>Environment</th><th>Health</th><th>Risk</th><th>Cost</th><th>Top alert</th>
              </tr>
            </thead>
            <tbody>
              {needAction.map((ag) => (
                <tr key={ag.id} onClick={() => openAgent(ag.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && openAgent(ag.id)}>
                  <td><b>{ag.name}</b></td>
                  <td>{ag.department}</td>
                  <td>{ag.environment}</td>
                  {PILLARS.map((p) => <td key={p}><Status value={ag.statuses[p]} compact /></td>)}
                  <td className="muted">{ag.alerts.find((x) => x.status === 'red')?.metric || ag.alerts[0]?.metric}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="chart-empty">No agent currently needs action.</div>
        )}
      </Panel>
    </>
  );
}

function Legend() {
  return (
    <div className="legend">
      {STATUS_ORDER.map((s) => (
        <span key={s} className={`pill ${s}`}>{STATUS_LABELS[s]}</span>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- portfolio tab */

function Select({ label, tip, value, onChange, options }) {
  return (
    <label className="select">
      <span>
        {label} {tip && <Tip text={tip} />}
      </span>
      <div className="select-box">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <ChevronDown size={15} />
      </div>
    </label>
  );
}

function AgentCard({ agent, openAgent }) {
  return (
    <article className="agent-card" onClick={() => openAgent(agent.id)} tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && openAgent(agent.id)}>
      <div className="agent-top">
        <div className="agent-icon"><Bot size={18} /></div>
        <div className="agent-title">
          <h4>{agent.name}</h4>
          <span>{agent.platform} · {agent.environment}</span>
        </div>
        <ChevronRight className="chev" size={18} />
      </div>
      <p className="purpose">{agent.purpose}</p>
      <dl className="agent-meta">
        <div><dt>Business owner</dt><dd>{agent.businessOwner || <em>Unassigned</em>}</dd></div>
        <div><dt>Technical owner</dt><dd>{agent.technicalOwner || <em>Unassigned</em>}</dd></div>
        <div><dt>In production</dt><dd>{agent.productionDays !== null ? `${agent.productionDays} days` : agent.environment === 'Production' ? 'Yes' : 'Not yet'}</dd></div>
        <div><dt>Last activity</dt><dd>{agent.updated}</dd></div>
      </dl>
      <div className="pillar-row">
        {PILLARS.map((p) => {
          const Icon = PILLAR_ICON[p];
          return (
            <button key={p} className={`pillar-chip ${agent.statuses[p]}`} type="button"
              onClick={(e) => { e.stopPropagation(); openAgent(agent.id, p); }}
              title={`Open ${p} details`}>
              <Icon size={14} />
              <span>{p}</span>
              <i />
            </button>
          );
        })}
      </div>
      <footer>
        <Status value={agent.statuses.overall} compact />
        <span>{fmtNum(agent.volume)} conversations</span>
        {agent.compliant ? (
          <span className="comp ok"><CheckCircle2 size={13} /> In policy</span>
        ) : (
          <span className="comp bad"><XCircle size={13} /> Out of policy</span>
        )}
      </footer>
    </article>
  );
}

function Portfolio({ agents, filters, setFilters, groupBy, setGroupBy, openAgent }) {
  const [collapsed, setCollapsed] = useState({});
  const opts = (field) => [
    { value: 'all', label: 'All' },
    ...[...new Set(agents.map((a) => fieldValue(a, field)))].sort().map((v) => ({ value: v, label: v })),
  ];
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const toggleEnv = (env) =>
    set({ environments: filters.environments.includes(env) ? filters.environments.filter((e) => e !== env) : [...filters.environments, env] });

  const shown = agents.filter((a) => {
    const f = filters;
    if (f.status === 'attention' && !['red', 'amber'].includes(a.statuses.overall)) return false;
    if (!['all', 'attention'].includes(f.status) && a.statuses.overall !== f.status) return false;
    if (f.environments.length && !f.environments.includes(a.environment)) return false;
    if (f.department !== 'all' && fieldValue(a, 'department') !== f.department) return false;
    if (f.location !== 'all' && fieldValue(a, 'location') !== f.location) return false;
    if (f.owner !== 'all' && fieldValue(a, 'owner') !== f.owner) return false;
    if (f.platform !== 'all' && fieldValue(a, 'platform') !== f.platform) return false;
    if (f.riskTier !== 'all' && fieldValue(a, 'riskTier') !== f.riskTier) return false;
    if (f.nonCompliantOnly && a.compliant) return false;
    const q = f.query.trim().toLowerCase();
    if (q && !`${a.name} ${a.purpose} ${a.department} ${a.businessOwner} ${a.technicalOwner} ${a.id}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ name: 'All agents', agents: shown }];
    const m = {};
    shown.forEach((a) => (m[fieldValue(a, groupBy)] ||= []).push(a));
    return Object.entries(m)
      .sort((x, y) => (x[0] === 'Unassigned') - (y[0] === 'Unassigned') || y[1].length - x[1].length)
      .map(([name, list]) => ({ name, agents: list }));
  }, [shown, groupBy]);

  return (
    <>
      <section className="filters panel">
        <div className="filter-row">
          <span className="label">Status <Tip text="Overall status = worst of Health, Risk and Cost." /></span>
          <Segmented
            value={filters.status}
            onChange={(v) => set({ status: v })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'attention', label: 'Need attention' },
              { value: 'red', label: 'Action' },
              { value: 'amber', label: 'Watch' },
              { value: 'green', label: 'Healthy' },
              { value: 'unknown', label: 'No data' },
            ]}
          />
          <span className="divider" />
          <span className="label">Environment <Tip text="Production vs test-canvas traffic, from the Copilot Studio DesignMode flag." /></span>
          {['Production', 'Test', 'No traffic'].map((env) => (
            <button key={env} type="button" className={`chip ${filters.environments.includes(env) ? 'on' : ''}`} onClick={() => toggleEnv(env)}>
              {env}
            </button>
          ))}
          <label className="check">
            <input type="checkbox" checked={filters.nonCompliantOnly} onChange={(e) => set({ nonCompliantOnly: e.target.checked })} />
            Out of policy only
          </label>
          <div className="search">
            <Search size={15} />
            <input value={filters.query} onChange={(e) => set({ query: e.target.value })} placeholder="Search name, purpose, owner, ID" />
          </div>
          <button className="ghost small" type="button" onClick={() => setFilters(EMPTY_FILTERS)}>Reset filters</button>
        </div>
        <div className="select-grid">
          <Select label="Department" tip="From the AI inventory." value={filters.department} onChange={(v) => set({ department: v })} options={opts('department')} />
          <Select label="Location" tip="From the AI inventory." value={filters.location} onChange={(v) => set({ location: v })} options={opts('location')} />
          <Select label="Business owner" value={filters.owner} onChange={(v) => set({ owner: v })} options={opts('owner')} />
          <Select label="Platform" value={filters.platform} onChange={(v) => set({ platform: v })} options={opts('platform')} />
          <Select label="Risk tier" tip="Inherent risk tier assigned at intake (AI inventory)." value={filters.riskTier} onChange={(v) => set({ riskTier: v })} options={opts('riskTier')} />
          <Select label="Group by" value={groupBy} onChange={setGroupBy}
            options={Object.entries(GROUP_FIELDS).map(([value, label]) => ({ value, label }))} />
        </div>
      </section>

      <div className="result-line">
        Showing <b>{shown.length}</b> of {plural(agents.length, 'agent')} in {plural(groups.length, 'group')}
      </div>

      {groups.map((g) => {
        const counts = g.agents.reduce((m, a) => ((m[a.statuses.overall] = (m[a.statuses.overall] || 0) + 1), m), {});
        const isCollapsed = collapsed[g.name];
        return (
          <section key={g.name} className="group">
            <button className="group-head" type="button" onClick={() => setCollapsed((c) => ({ ...c, [g.name]: !c[g.name] }))}>
              {groupBy !== 'none' && <span className="level">{GROUP_FIELDS[groupBy]}</span>}
              <b>{g.name}</b>
              <span className="muted">{plural(g.agents.length, 'agent')}</span>
              <div className="group-counts">
                {STATUS_ORDER.map((s) => (counts[s] ? <span key={s} className={`dot-count ${s}`}><i />{counts[s]}</span> : null))}
              </div>
              <ChevronDown size={16} className={`caret ${isCollapsed ? 'closed' : ''}`} />
            </button>
            {!isCollapsed && (
              <div className="agent-grid">
                {g.agents.map((a) => <AgentCard key={a.id} agent={a} openAgent={openAgent} />)}
              </div>
            )}
          </section>
        );
      })}
      {!shown.length && <div className="chart-empty">No agents match these filters.</div>}
    </>
  );
}

/* ----------------------------------------------------------------- agent view */

function MetricRow({ metric }) {
  return (
    <div className="metric-row">
      <Status value={metric.status} compact />
      <div className="metric-copy">
        <b>{metric.name}</b>
        <span>{metric.description}</span>
        {metric.why && <small>{metric.why}</small>}
        <em className="source">Source: {metric.source}</em>
      </div>
      <div className="metric-value">
        <b>{metric.value}</b>
        <span>{metric.threshold}</span>
      </div>
    </div>
  );
}

function AgentDetail({ agent, pillar, setPillar, back, days, library }) {
  const metrics = agent.metrics[pillar] || [];
  const components = library?.healthComponents || {};
  const grouped =
    pillar === 'health'
      ? Object.entries(components).map(([key, label]) => ({ key, label, rows: metrics.filter((m) => m.component === key) })).filter((g) => g.rows.length)
      : [{ key: 'all', label: null, rows: metrics }];

  return (
    <>
      <button className="back" onClick={back} type="button"><ArrowLeft size={15} /> All agents</button>

      <section className="agent-hero">
        <div>
          <span className="eyebrow">{agent.department} · {agent.platform}</span>
          <h2>{agent.name}</h2>
          <p>{agent.purpose}</p>
          <div className="hero-meta">
            <span><b>Environment</b>{agent.environment}</span>
            <span><b>Location</b>{agent.location}</span>
            <span><b>Risk tier</b>{agent.riskTier || 'Not assigned'}</span>
            <span><b>Business owner</b>{agent.businessOwner || 'Unassigned'}</span>
            <span><b>Technical owner</b>{agent.technicalOwner || 'Unassigned'}</span>
            <span><b>In production</b>{agent.productionDays !== null ? `${agent.productionDays} days` : '—'}</span>
            <span><b>Last activity</b>{agent.updated}</span>
          </div>
        </div>
        <div className="hero-status">
          <Status value={agent.statuses.overall} />
          {agent.compliant ? <span className="comp ok"><CheckCircle2 size={14} /> In policy</span> : <span className="comp bad"><XCircle size={14} /> Out of policy</span>}
        </div>
      </section>

      <div className="pillar-tabs">
        {PILLARS.map((p) => {
          const Icon = PILLAR_ICON[p];
          const measured = agent.metrics[p].filter((m) => m.status !== 'unknown').length;
          return (
            <button key={p} type="button" className={pillar === p ? 'active' : ''} onClick={() => setPillar(p)}>
              <Icon size={20} />
              <span className="pt-copy">
                <b>{library?.pillars?.[p]?.name || p}</b>
                <small>{measured} of {agent.metrics[p].length} metrics measured</small>
              </span>
              <Status value={agent.statuses[p]} compact />
            </button>
          );
        })}
      </div>

      <div className="detail-grid">
        <Panel help={() => openHelpAt(pillar)} title={`${library?.pillars?.[pillar]?.name || pillar} evidence`} subtitle={library?.pillars?.[pillar]?.definition}
          right={<Status value={agent.statuses[pillar]} />}>
          {grouped.map((g) => (
            <div key={g.key} className="component">
              {g.label && (
                <div className="component-head">
                  <span>{g.label}</span>
                  <Status value={worst(g.rows.map((r) => r.status))} compact />
                </div>
              )}
              {g.rows.map((m) => <MetricRow key={m.id} metric={m} />)}
            </div>
          ))}
        </Panel>

        <div className="side">
          <Panel title="Activity" subtitle={`Conversations per ${days === 1 ? 'hour' : 'day'} · ${periodLabel(days).toLowerCase()}`}>
            <VolumeBars series={agent.series} days={days} />
            <div className="bar-legend">
              <span><i className="bar-ok" />Completed</span><span><i className="bar-other" />Other</span><span><i className="bar-fail" />Failed</span>
            </div>
            <div className="stat-strip">
              <div><span>Conversations</span><b>{fmtNum(agent.volume)}</b></div>
              <div><span>User messages</span><b>{fmtNum(agent.userTurns)}</b></div>
              <div><span>Error events</span><b>{fmtNum(agent.errorEvents)}</b></div>
              <div><span>Tokens</span><b>{agent.tokens !== null ? fmtNum(agent.tokens) : 'n/a'}</b></div>
            </div>
          </Panel>

          <Panel help={() => openHelpAt('policy')} title="AI policy checks" tip="Automatic: telemetry compared with the AI inventory record. No manual attestation.">
            <ul className="checks">
              {agent.compliance.map((c) => (
                <li key={c.id} className={c.pass ? 'ok' : 'bad'}>
                  {c.pass ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                  <div><b>{c.name}</b><span>{c.detail}</span></div>
                </li>
              ))}
            </ul>
          </Panel>

          {agent.topErrorCodes?.length > 0 && (
            <Panel title="Top error codes" tip="Distinct OnErrorLog error codes seen in the period. Raw messages are not exposed.">
              <div className="codes">{agent.topErrorCodes.map((c) => <code key={c}>{c}</code>)}</div>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- library tab */

const AVAIL_LABEL = { live: 'Live', conditional: 'When connected', 'not-available': 'Not yet available' };

function Library({ library }) {
  const [pillar, setPillar] = useState('all');
  if (!library) return <div className="chart-empty">Metric library loads with telemetry.</div>;
  const rows = library.metrics.filter((m) => pillar === 'all' || m.pillar === pillar);
  const counts = library.metrics.reduce((m, x) => ((m[x.availability] = (m[x.availability] || 0) + 1), m), {});
  return (
    <>
      <section className="hero-card slim">
        <span className="eyebrow">Metric library</span>
        <p className="hero-text">
          One shared library behind every status. Thresholds are maintained here once and applied to every agent; use-case specific
          metrics are attached by tag. <b>{counts.live || 0}</b> live · <b>{counts.conditional || 0}</b> when source connected ·{' '}
          <b>{counts['not-available'] || 0}</b> defined, awaiting a source.
        </p>
      </section>

      <div className="formula">
        <span className="eyebrow-sm">Operational health</span>
        <div className="formula-row">
          {Object.values(library.healthComponents).map((c, i) => (
            <React.Fragment key={c}>
              {i > 0 && <span className="plus">+</span>}
              <span className="term">{c}</span>
            </React.Fragment>
          ))}
        </div>
        <p>Each component takes the worst status of its metrics; Health takes the worst component. Grey components are excluded, never counted as green.</p>
      </div>

      <Panel help={() => openHelpAt('health')} title="Metrics" right={
        <Segmented value={pillar} onChange={setPillar}
          options={[{ value: 'all', label: 'All' }, ...PILLARS.map((p) => ({ value: p, label: library.pillars[p].name }))]} />
      }>
        <table className="table lib">
          <thead>
            <tr><th>Pillar</th><th>Metric</th><th>Definition and formula</th><th>Source</th><th>Thresholds</th><th>Data</th><th>Applies to</th></tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td><span className="level">{library.pillars[m.pillar].name}</span></td>
                <td><b>{m.name}</b><small className="muted block">{library.healthComponents[m.component] || m.component}</small></td>
                <td>{m.definition}<code className="block">{m.formula}</code></td>
                <td className="muted">{m.source}</td>
                <td>{m.threshold}</td>
                <td><span className={`avail ${m.availability}`}>{AVAIL_LABEL[m.availability]}</span></td>
                <td>{m.appliesTo.includes('all') ? 'All agents' : 'Use-case specific'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="AI policy checks" subtitle="Drives the “Out of AI policy” tile. Evaluated automatically against the AI inventory.">
        <table className="table">
          <thead><tr><th>Check</th><th>Rule</th></tr></thead>
          <tbody>{library.compliance.map((c) => <tr key={c.id}><td><b>{c.name}</b></td><td>{c.definition}</td></tr>)}</tbody>
        </table>
      </Panel>
    </>
  );
}

/* ---------------------------------------------------------------- data checks */

function DataChecks({ payload, agents, mode }) {
  const s = payload?.sources || {};
  const unregistered = agents.filter((a) => !a.registered);
  const silent = agents.filter((a) => !a.volume);
  const rows = [
    ['Data as of', fmtDateTime(payload?.generatedAt)],
    ['Mode', mode === 'live' ? 'Live telemetry' : mode === 'demo' ? 'Demo data (not live)' : 'Unavailable'],
    ['Reporting period', periodLabel(payload?.lookbackDays || 7)],
    ['Telemetry source', s.telemetry || '—'],
    ['Agents in telemetry', agents.length - silent.length],
    ['Registered but silent', silent.length],
    ['Inventory source', s.inventoryLabel || '—'],
    ['Inventory records', s.inventoryRecords ?? '—'],
    ['Agents not in inventory', unregistered.length],
    ['Token telemetry', s.costTelemetry || '—'],
    ['Price list', s.pricing || '—'],
    ['Timeout limit', s.timeoutSeconds ? `${s.timeoutSeconds}s` : '—'],
    ['Query time', payload?.queryMs ? `${(payload.queryMs / 1000).toFixed(1)}s` : '—'],
  ];
  return (
    <div className="checks-grid">
      <Panel title="Current load" subtitle="Sources and record counts behind every view.">
        {s.inventory === 'file' && (
          <div className="warn"><AlertTriangle size={15} /> Inventory is the bundled stand-in file. Connect INVENTORY_URL to the AI system inventory before client use.</div>
        )}
        <dl className="kv">
          {rows.map(([k, v]) => (<React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>))}
        </dl>
        {unregistered.length > 0 && (
          <>
            <h4 className="mini-head">Telemetry IDs without an inventory record</h4>
            <div className="codes">{unregistered.map((a) => <code key={a.id}>{a.id}</code>)}</div>
          </>
        )}
      </Panel>
      <Panel help={() => openHelpAt('data')} title="How the figures are built" subtitle="Method notes for executive reporting.">
        <div className="method">
          <p><b>Agents.</b> Each conversation is resolved to one agent from the Copilot Studio events (bot name on inbound messages, then outbound, then the topic schema prefix). Agent metadata — department, owners, purpose, risk tier, production date — is joined from the AI inventory.</p>
          <p><b>Statuses.</b> Every metric is rated green / amber / red against the thresholds in the Metric Library. Health, Risk and Cost take the worst metric in the pillar; the overall status takes the worst pillar. Metrics without data, or below the minimum sample, are grey and do not count as healthy.</p>
          <p><b>Health.</b> Availability = answered user messages ÷ user messages. Completion = conversations reaching a topic end without an error. Latency = time from a user message to the next agent reply (P95), with replies over the timeout limit counted as timeouts. Failed execution = conversations with an OnErrorLog event.</p>
          <p><b>Risk.</b> Baseline signals that apply to every agent: guardrail blocks for jailbreak / indirect prompt injection and content safety, read from error codes. Sensitive-data exposure and unapproved tool calls are defined but await Purview and dependency telemetry.</p>
          <p><b>Cost.</b> Token counts come from OpenTelemetry gen_ai attributes (Foundry / SDK agents). Copilot Studio does not publish tokens, so its agents show Cost as grey.</p>
          <p><b>AI policy.</b> An agent is out of policy when any automatic check fails: not in the inventory, missing an owner or risk tier, production traffic without approval, or no telemetry in the period.</p>
          <p><b>Freshness.</b> Application Insights ingestion typically lags a few minutes. With near real-time on, the dashboard re-queries every 5 minutes.</p>
        </div>
      </Panel>
    </div>
  );
}

/* --------------------------------------------------------------- definitions */

function Definitions({ close, library, openHelp }) {
  return (
    <div className="drawer-wrap" onClick={close}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><BookOpen size={18} /> Definitions</h3>
          <button className="icon" onClick={close} type="button" aria-label="Close"><X size={18} /></button>
        </div>
        <button className="guide-link" type="button" onClick={() => { close(); openHelp('start'); }}>
          <HelpCircle size={16} /> Open the full guide — metrics, rationale, data sources and FAQ
        </button>
        <h4>Statuses</h4>
        <dl className="defs">
          <dt><Status value="green" compact /></dt><dd>All measured metrics within the green threshold.</dd>
          <dt><Status value="amber" compact /></dt><dd>At least one metric in the amber band; monitor.</dd>
          <dt><Status value="red" compact /></dt><dd>At least one metric breached the red threshold; remediation needed.</dd>
          <dt><Status value="unknown" compact /></dt><dd>No telemetry or insufficient sample. A data gap, not a healthy result.</dd>
        </dl>
        <h4>Pillars</h4>
        <dl className="defs">
          {PILLARS.map((p) => (<React.Fragment key={p}><dt>{library?.pillars?.[p]?.name || p}</dt><dd>{library?.pillars?.[p]?.definition}</dd></React.Fragment>))}
        </dl>
        <h4>Executive tiles</h4>
        <dl className="defs">
          {Object.entries({
            'Agents monitored': KPI_DEFS.monitored, 'In production': KPI_DEFS.production, 'Need attention': KPI_DEFS.attention,
            'Open alerts': KPI_DEFS.alerts, 'High-severity in production': KPI_DEFS.highRisk, 'Out of AI policy': KPI_DEFS.compliance,
            'Spend this period': KPI_DEFS.spend, 'Telemetry coverage': KPI_DEFS.coverage,
          }).map(([k, v]) => (<React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>))}
        </dl>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------------ app */

function App() {
  const [payload, setPayload] = useState(null);
  const [mode, setMode] = useState('loading');
  const [days, setDays] = useState(7);
  const [tab, setTab] = useState('overview');
  const [selected, setSelected] = useState(null); // { id, pillar }
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [groupBy, setGroupBy] = useState('department');
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [defsOpen, setDefsOpen] = useState(false);
  const [helpSection, setHelpSection] = useState(null);
  openHelpAt = setHelpSection;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '?' && !/input|select|textarea/i.test(document.activeElement?.tagName || '')) setHelpSection('start');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [theme, setTheme] = useState(() => localStorage.getItem('agent-theme') || 'dark');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('agent-theme', theme);
  }, [theme]);

  const load = useCallback(async (d) => {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/agents?days=${d}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const body = await response.json();
      setPayload(body);
      setMode(body.mode || 'live');
    } catch (error) {
      console.error(error);
      // Never leave old figures (live or demo) on screen under an error banner.
      setMode((m) => {
        if (m === 'demo') return 'demo';
        setPayload(null);
        return 'error';
      });
    } finally {
      setRefreshing(false);
    }
  }, []);

  const loadDemo = async () => {
    const { buildDemoPayload } = await import('./demoData.js');
    setPayload(buildDemoPayload(days));
    setMode('demo');
  };

  useEffect(() => {
    if (mode === 'demo') loadDemo();
    else load(days);
  }, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!autoRefresh || mode === 'demo') return undefined;
    const t = setInterval(() => load(days), AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [autoRefresh, days, mode, load]);

  const agents = payload?.agents || [];
  const library = payload?.library;

  const kpis = useMemo(() => {
    const allMetrics = agents.flatMap((a) => [...a.metrics.health, ...a.metrics.risk, ...a.metrics.cost]);
    const spends = agents.map((a) => a.spendUsd).filter((v) => v !== null && v !== undefined);
    const tokens = agents.map((a) => a.tokens).filter((v) => v !== null && v !== undefined);
    return {
      monitored: agents.length,
      departments: new Set(agents.map((a) => a.department)).size,
      production: agents.filter((a) => a.environment === 'Production').length,
      attention: agents.filter((a) => ['red', 'amber'].includes(a.statuses.overall)).length,
      alerts: agents.reduce((s, a) => s + a.alerts.length, 0),
      highRisk: agents.filter((a) => a.environment === 'Production' && a.alerts.some((x) => x.status === 'red')),
      nonCompliant: agents.filter((a) => !a.compliant).length,
      spend: spends.length ? spends.reduce((s, v) => s + v, 0) : null,
      tokens: tokens.length ? tokens.reduce((s, v) => s + v, 0) : null,
      coverage: allMetrics.length ? Math.round((100 * allMetrics.filter((m) => m.status !== 'unknown').length) / allMetrics.length) : 0,
    };
  }, [agents]);

  const selectedAgent = selected ? agents.find((a) => a.id === selected.id) : null;
  useEffect(() => {
    if (selected && !selectedAgent) setSelected(null);
  }, [selected, selectedAgent]);

  const openAgent = (id, pillar = 'health') => {
    setSelected({ id, pillar });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const goPortfolio = (patch) => {
    setFilters({ ...EMPTY_FILTERS, ...patch });
    setSelected(null);
    setTab('portfolio');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <main>
      <Header payload={payload} mode={mode} agents={agents} theme={theme} toggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        refresh={() => (mode === 'demo' ? loadDemo() : load(days))} refreshing={refreshing} openDefs={() => setDefsOpen(true)}
        openHelp={() => setHelpSection('start')} />

      <nav className="tabs">
        <div className="tabs-inner">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id && !selectedAgent ? 'active' : ''} onClick={() => { setTab(t.id); setSelected(null); }}>
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      <PeriodBar days={days} setDays={setDays} generatedAt={payload?.generatedAt} autoRefresh={autoRefresh} setAutoRefresh={setAutoRefresh} />

      <div className="shell">
        {mode === 'error' && (
          <div className="error-banner">
            <AlertTriangle size={18} />
            <span>Live telemetry could not be retrieved. No figures are shown rather than stale or sample data.</span>
            <button className="ghost small" type="button" onClick={loadDemo}>Show demo data</button>
          </div>
        )}
        {mode === 'demo' && (
          <div className="demo-banner">
            <Info size={16} /> Demo data — generated sample for presentation only. Not live telemetry.
            <button className="ghost small" type="button" onClick={() => { setMode('loading'); load(days); }}>Try live again</button>
          </div>
        )}
        {mode === 'loading' && !payload && <div className="chart-empty">Loading telemetry…</div>}

        {payload && (selectedAgent ? (
          <AgentDetail agent={selectedAgent} pillar={selected.pillar} setPillar={(p) => setSelected((s) => ({ ...s, pillar: p }))}
            back={() => setSelected(null)} days={days} library={library} />
        ) : tab === 'overview' ? (
          <Overview agents={agents} days={days} library={library} kpis={kpis} goPortfolio={goPortfolio} openAgent={openAgent} />
        ) : tab === 'portfolio' ? (
          <Portfolio agents={agents} filters={filters} setFilters={setFilters} groupBy={groupBy} setGroupBy={setGroupBy} openAgent={openAgent} />
        ) : tab === 'library' ? (
          <Library library={library} />
        ) : (
          <DataChecks payload={payload} agents={agents} mode={mode} />
        ))}
      </div>

      {defsOpen && <Definitions close={() => setDefsOpen(false)} library={library} openHelp={setHelpSection} />}
      {helpSection && (
        <Help close={() => setHelpSection(null)} library={library} kpiDefs={KPI_DEFS} initialSection={helpSection}
          sources={payload?.sources} mode={mode} />
      )}
      <button className="help-fab" type="button" onClick={() => setHelpSection('start')} aria-label="How this dashboard works" title="How this dashboard works (?)">
        ?
      </button>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
