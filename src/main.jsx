import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Bot,
  ChevronRight,
  Clock3,
  DollarSign,
  Info,
  Moon,
  RefreshCw,
  Search,
  ShieldCheck,
  Sun,
  Wifi,
  Zap,
} from 'lucide-react';
import './styles.css';

const STATUS_LABELS = {
  green: 'Healthy',
  amber: 'Watch',
  red: 'Action required',
  unknown: 'Not monitored',
};

const DEFINITIONS = {
  portfolio:
    'A current inventory of agents discovered from runtime telemetry in the selected reporting period.',
  attention:
    'Agents with an overall red or amber status based on the visible threshold rules.',
  coverage:
    'The share of Health, Risk and Cost pillars with enough telemetry to calculate a status.',
  window:
    'The historical period included in every metric, status and chart on this page.',
  health:
    'Operational reliability signals available from runtime events, including responses and recorded failures.',
  risk: 'Observed runtime error signals. This does not currently include prompt injection, PII leakage or content-safety telemetry.',
  cost: 'Token consumption and estimated spend. The current Copilot Studio event feed does not provide these values.',
};

function Status({ value, compact = false }) {
  return (
    <span className={`status ${value} ${compact ? 'compact' : ''}`}>
      <i />
      {STATUS_LABELS[value] || value}
    </span>
  );
}

function Definition({ children }) {
  return (
    <span className="definition">
      <Info size={13} />
      {children}
    </span>
  );
}

function LineChart({ points = [], status = 'green', label }) {
  if (!points.length)
    return <div className="chart-empty">No activity in this period</div>;
  const width = 520,
    height = 170,
    pad = 20;
  const values = points.map((p) => Number(p.value || 0));
  const max = Math.max(...values, 1);
  const coords = values.map((v, i) => ({
    x: pad + i * ((width - pad * 2) / Math.max(values.length - 1, 1)),
    y: height - pad - (v / max) * (height - pad * 2),
  }));
  const path = coords.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
  return (
    <div className="chart-wrap">
      <svg
        className={`line-chart ${status}`}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
      >
        {[0.25, 0.5, 0.75].map((n) => (
          <line
            key={n}
            x1={pad}
            x2={width - pad}
            y1={height * n}
            y2={height * n}
            className="grid-line"
          />
        ))}
        <path d={path} className="area-line" />
        {coords.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="3.5">
            <title>
              {points[i].label}: {values[i]} conversations
            </title>
          </circle>
        ))}
      </svg>
      <div className="chart-axis">
        <span>{points[0]?.label}</span>
        <span>{points.at(-1)?.label}</span>
      </div>
    </div>
  );
}

function MetricRow({ metric }) {
  return (
    <div className="metric-row">
      <Status value={metric.status} compact />
      <div className="metric-copy">
        <b>{metric.name}</b>
        <span>{metric.description}</span>
        <small>{metric.why}</small>
      </div>
      <div className="metric-value">
        <b>{metric.value}</b>
        <span>{metric.threshold}</span>
      </div>
    </div>
  );
}

function Summary({ icon, label, value, definition }) {
  return (
    <div className="summary-card">
      <div className="sum-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <b>{value}</b>
        <Definition>{definition}</Definition>
      </div>
    </div>
  );
}

function Header({ mode, refresh, refreshing, theme, toggleTheme }) {
  return (
    <header>
      <div className="brand">
        <div className="mark">
          <BarChart3 />
        </div>
        <div>
          <b>Agent Assurance</b>
          <span>Runtime monitoring</span>
        </div>
      </div>
      <div className="header-actions">
        <span className={`mode ${mode}`}>
          {mode === 'live'
            ? 'Live telemetry'
            : mode === 'error'
              ? 'Telemetry unavailable'
              : 'Connecting'}
        </span>
        <button
          className="icon-button"
          onClick={toggleTheme}
          title="Switch color theme"
          aria-label="Switch color theme"
        >
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button onClick={refresh}>
          <RefreshCw className={refreshing ? 'spin' : ''} size={16} />
          Refresh
        </button>
      </div>
    </header>
  );
}

function App() {
  const [agents, setAgents] = useState([]);
  const [mode, setMode] = useState('loading');
  const [selected, setSelected] = useState(null);
  const [pillar, setPillar] = useState('health');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [days, setDays] = useState(7);
  const [theme, setTheme] = useState(
    () => localStorage.getItem('agent-theme') || 'light'
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('agent-theme', theme);
  }, [theme]);

  const load = async (selectedDays = days) => {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/agents?days=${selectedDays}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const payload = await response.json();
      setAgents(payload.agents || []);
      setMode(payload.mode || 'live');
    } catch (error) {
      console.error(error);
      setAgents([]);
      setMode('error');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load(days);
  }, [days]);

  const shown = useMemo(
    () =>
      agents.filter((agent) =>
        `${agent.name} ${agent.provider} ${agent.environment}`
          .toLowerCase()
          .includes(query.toLowerCase())
      ),
    [agents, query]
  );
  const needAttention = agents.filter((a) =>
    ['red', 'amber'].includes(a.statuses.overall)
  ).length;
  const coverage = agents.length
    ? Math.round(
        (agents.reduce(
          (sum, a) =>
            sum + Object.values(a.statuses).filter((x) => x !== 'unknown').length / 4,
          0
        ) /
          agents.length) *
          100
      )
    : 0;
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  if (selected) {
    const agent = agents.find((a) => a.id === selected);
    if (!agent) setSelected(null);
    else
      return (
        <main>
          <Header
            mode={mode}
            refresh={() => load(days)}
            refreshing={refreshing}
            theme={theme}
            toggleTheme={toggleTheme}
          />
          <div className="shell">
            <button className="back" onClick={() => setSelected(null)}>
              <ArrowLeft size={16} />
              All agents
            </button>
            <section className="agent-head">
              <div>
                <span className="eyebrow">AGENT RUNTIME PROFILE</span>
                <h1>{agent.name}</h1>
                <p>{agent.purpose}</p>
                <div className="meta">
                  <span>{agent.provider}</span>
                  <span>{agent.environment}</span>
                  <span>
                    <Clock3 size={14} />
                    Updated {agent.updated}
                  </span>
                </div>
              </div>
              <Status value={agent.statuses.overall} />
            </section>
            <div className="pillar-tabs">
              {['health', 'risk', 'cost'].map((name) => (
                <button
                  className={pillar === name ? 'active' : ''}
                  onClick={() => setPillar(name)}
                  key={name}
                >
                  {name === 'health' ? (
                    <Activity />
                  ) : name === 'risk' ? (
                    <ShieldCheck />
                  ) : (
                    <DollarSign />
                  )}
                  <span>
                    <b>{name[0].toUpperCase() + name.slice(1)}</b>
                    <Definition>{DEFINITIONS[name]}</Definition>
                    <Status value={agent.statuses[name]} compact />
                  </span>
                </button>
              ))}
            </div>
            <section className="detail-grid">
              <div className="panel">
                <div className="panel-title">
                  <div>
                    <span className="eyebrow">STATUS EVIDENCE</span>
                    <h2>{pillar[0].toUpperCase() + pillar.slice(1)} measurements</h2>
                    <p>
                      Each measurement explains the observed value, its meaning and the
                      threshold applied.
                    </p>
                  </div>
                  <Status value={agent.statuses[pillar]} />
                </div>
                {agent.metrics[pillar].map((metric) => (
                  <MetricRow key={metric.name} metric={metric} />
                ))}
              </div>
              <aside className="panel">
                <span className="eyebrow">ACTIVITY TREND</span>
                <h2>Conversations over time</h2>
                <Definition>
                  Distinct conversation IDs observed per time bucket in the selected
                  reporting period.
                </Definition>
                <LineChart
                  points={agent.activityTrend}
                  status={agent.statuses.overall}
                  label={`${agent.name} conversation activity trend`}
                />
                <div className="stat-strip">
                  <div>
                    <span>Total conversations</span>
                    <b>{agent.volume.toLocaleString()}</b>
                  </div>
                  <div>
                    <span>Reporting period</span>
                    <b>{days === 1 ? '24 hours' : `${days} days`}</b>
                  </div>
                </div>
              </aside>
            </section>
            <section className="panel coverage-panel">
              <div>
                <span className="eyebrow">MEASUREMENT COVERAGE</span>
                <h2>What this dashboard can and cannot see</h2>
                <p>Gray indicators are data gaps, not healthy results.</p>
              </div>
              <div className="coverage">
                <div>
                  <Wifi />
                  <span>
                    <b>Health</b>Response, error and activity signals from Application
                    Insights
                  </span>
                  <Status value={agent.statuses.health} compact />
                </div>
                <div>
                  <ShieldCheck />
                  <span>
                    <b>Risk</b>Runtime errors only; safety and privacy guardrails are not
                    connected
                  </span>
                  <Status value={agent.statuses.risk} compact />
                </div>
                <div>
                  <DollarSign />
                  <span>
                    <b>Cost</b>Token and pricing telemetry are not available
                  </span>
                  <Status value={agent.statuses.cost} compact />
                </div>
              </div>
            </section>
          </div>
        </main>
      );
  }

  return (
    <main>
      <Header
        mode={mode}
        refresh={() => load(days)}
        refreshing={refreshing}
        theme={theme}
        toggleTheme={toggleTheme}
      />
      <div className="shell">
        <section className="hero">
          <span className="eyebrow">RUNTIME MONITORING</span>
          <h1>AI Agent Runtime Assurance</h1>
          <p>
            A clear portfolio view of operational health, observed risk signals, telemetry
            coverage and cost-data readiness.
          </p>
        </section>
        <section className="summary">
          <Summary
            icon={<Bot />}
            label="Agents monitored"
            value={agents.length}
            definition={DEFINITIONS.portfolio}
          />
          <Summary
            icon={<AlertTriangle />}
            label="Need attention"
            value={needAttention}
            definition={DEFINITIONS.attention}
          />
          <Summary
            icon={<Activity />}
            label="Telemetry coverage"
            value={`${coverage}%`}
            definition={DEFINITIONS.coverage}
          />
          <Summary
            icon={<Clock3 />}
            label="Reporting window"
            value={days === 1 ? '24 hours' : `${days} days`}
            definition={DEFINITIONS.window}
          />
        </section>
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents or providers"
            />
          </div>
          <div className="period-control">
            <label htmlFor="lookback-days">Reporting period</label>
            <select
              id="lookback-days"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value={1}>Last 24 hours</option>
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={60}>Last 60 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </div>
          <span className="legend">
            <i className="g" />
            Healthy <i className="a" />
            Watch <i className="r" />
            Action <i className="u" />
            No data
          </span>
        </div>
        {mode === 'error' && (
          <div className="error-banner">
            <AlertTriangle />
            Live telemetry could not be retrieved. No sample data is displayed.
          </div>
        )}
        <section className="agents">
          {shown.map((agent) => (
            <article
              className="agent-card"
              key={agent.id}
              onClick={() => setSelected(agent.id)}
              tabIndex="0"
              onKeyDown={(e) => e.key === 'Enter' && setSelected(agent.id)}
            >
              <div className="agent-card-top">
                <div className="agent-icon">
                  <Bot />
                </div>
                <div>
                  <h2>{agent.name}</h2>
                  <p>
                    {agent.provider} · {agent.environment}
                  </p>
                </div>
                <ChevronRight className="chev" />
              </div>
              <p className="purpose">{agent.purpose}</p>
              <div className="status-grid">
                {['health', 'risk', 'cost'].map((name) => (
                  <div key={name}>
                    <span>{name}</span>
                    <Definition>{DEFINITIONS[name]}</Definition>
                    <Status value={agent.statuses[name]} compact />
                  </div>
                ))}
              </div>
              <div className="card-metrics">
                <div>
                  <Activity />
                  <span>
                    <b>{agent.volume.toLocaleString()}</b>Conversations
                  </span>
                </div>
                <div>
                  <Zap />
                  <span>
                    <b>{agent.runtimeSignals ?? '—'}</b>Runtime events
                  </span>
                </div>
                <div>
                  <AlertTriangle />
                  <span>
                    <b>{agent.errorEvents ?? '—'}</b>Error events
                  </span>
                </div>
              </div>
              <div className="mini-trend">
                <LineChart
                  points={agent.activityTrend}
                  status={agent.statuses.overall}
                  label="Conversation activity"
                />
              </div>
              <footer>
                <Status value={agent.statuses.overall} />
                <span>Updated {agent.updated}</span>
              </footer>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
