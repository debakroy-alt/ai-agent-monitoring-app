import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, HelpCircle, Search, X } from 'lucide-react';

/*
 * In-app guide. Metric tables are rendered from the live metric library
 * returned by the API, so this page can never drift from the limits applied.
 */

const STATUS = [
  ['green', 'Healthy', 'Every rated check in the area is within its Healthy limit.', 'No action.'],
  ['amber', 'Watch', 'At least one check is in the Watch band and none is at Action.', 'Owner reviews the trend within a working day.'],
  ['red', 'Action required', 'At least one check has passed its Action limit.', 'Owner investigates and fixes.'],
  ['unknown', 'No data', 'Too little activity to judge, or the data source is not connected. Figures are still shown where they exist.', 'Treat as a visibility gap, not a pass.'],
];

const SECTIONS = [
  { id: 'start', title: 'Getting started' },
  { id: 'layout', title: 'Finding your way around' },
  { id: 'manage', title: 'Which agents are shown' },
  { id: 'status', title: 'How statuses work' },
  { id: 'health', title: 'Health metrics' },
  { id: 'risk', title: 'Risk metrics' },
  { id: 'cost', title: 'Cost metrics' },
  { id: 'policy', title: 'AI policy checks' },
  { id: 'data', title: 'Where the data comes from' },
  { id: 'live', title: 'Live data vs demo data' },
  { id: 'faq', title: 'FAQ and troubleshooting' },
  { id: 'glossary', title: 'Glossary' },
];

const AVAIL = { live: 'Measured today', conditional: 'When source connected', 'not-available': 'Not yet available' };

function Pill({ s, children }) {
  return (
    <span className={`status sm ${s}`}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

function MetricTable({ library, pillar }) {
  if (!library) return <p className="help-note">Metric definitions load with the data.</p>;
  return (
    <div className="table-wrap">
      <table className="table help-table">
        <thead>
          <tr><th scope="col">Metric</th><th scope="col">What it tells you</th><th scope="col">How it is calculated</th><th scope="col">Limits</th><th scope="col">Data</th></tr>
        </thead>
        <tbody>
          {library.metrics.filter((m) => m.pillar === pillar).map((m) => (
            <tr key={m.id}>
              <td><b>{m.name}</b>{pillar === 'health' && <small className="muted block">{library.healthComponents[m.component]}</small>}</td>
              <td>{m.definition}{m.basis && <small className="muted block">Why: {m.basis}</small>}</td>
              <td>
                <code className="block">{m.formula}</code>
                <small className="muted block">{m.source}</small>
                {m.minSample && <small className="muted block">Minimum activity before rating: {m.minSample}</small>}
              </td>
              <td>{m.threshold}</td>
              <td><span className={`avail ${m.availability}`}>{AVAIL[m.availability]}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Faq({ q, children }) {
  return (
    <details className="faq">
      <summary><ChevronRight size={15} aria-hidden="true" />{q}</summary>
      <div>{children}</div>
    </details>
  );
}

export default function Help({ close, library, initialSection = 'start', sources, mode }) {
  const [active, setActive] = useState(initialSection);
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState(new Set());
  const bodyRef = useRef(null);

  const jump = (id) => {
    const el = bodyRef.current?.querySelector(`#help-${id}`);
    if (el) bodyRef.current.scrollTo({ top: el.offsetTop - 16, behavior: 'smooth' });
    setActive(id);
  };

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [close]);

  useEffect(() => {
    if (initialSection !== 'start') requestAnimationFrame(() => jump(initialSection));
  }, [initialSection]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const root = bodyRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return undefined;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id.replace('help-', ''));
      },
      { root, rootMargin: '0px 0px -70% 0px' }
    );
    root.querySelectorAll('section[id^="help-"]').forEach((s) => obs.observe(s));
    return () => obs.disconnect();
  }, [query]);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const q = query.trim().toLowerCase();
    const next = new Set();
    root.querySelectorAll('section[id^="help-"]').forEach((s) => {
      const match = !q || s.textContent.toLowerCase().includes(q);
      s.style.display = match ? '' : 'none';
      if (!match) next.add(s.id.replace('help-', ''));
      if (q && match) s.querySelectorAll('details').forEach((d) => (d.open = d.textContent.toLowerCase().includes(q)));
    });
    setHidden(next);
  }, [query, library]);

  const slow = sources?.slowReplySeconds || 30;

  return (
    <div className="help-wrap" role="dialog" aria-modal="true" aria-label="How this dashboard works" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="help">
        <header className="help-head">
          <div className="help-title">
            <HelpCircle size={22} aria-hidden="true" />
            <div>
              <h2>How this dashboard works</h2>
              <p>What each figure means, how it is calculated and what to do about it. Press Esc to close.</p>
            </div>
          </div>
          <label className="help-search">
            <Search size={15} aria-hidden="true" />
            <span className="sr-only">Search the guide</span>
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the guide (e.g. budget, no data, quiet)" />
          </label>
          <button className="icon help-close" onClick={close} type="button" aria-label="Close guide"><X size={20} /></button>
        </header>
        <div className="help-main">
          <nav className="help-nav" aria-label="Guide sections">
            {SECTIONS.map((s) => (
              <button key={s.id} type="button" className={`${active === s.id ? 'on' : ''} ${hidden.has(s.id) ? 'dim' : ''}`} onClick={() => jump(s.id)} disabled={hidden.has(s.id)}>
                {s.title}
              </button>
            ))}
          </nav>
          <div className="help-body" ref={bodyRef}>
            {query && hidden.size === SECTIONS.length && <p className="help-note">Nothing in the guide matches “{query}”.</p>}

            <section id="help-start">
              <h3>Getting started</h3>
              <p className="lead">
                For every AI agent that sends telemetry, this dashboard answers three questions: is it <b>working</b> (Health), is it <b>behaving safely</b> (Risk) and
                is it <b>affordable</b> (Cost)? Every colour is calculated automatically from runtime telemetry — nobody types in a status.
              </p>
              <div className="help-steps">
                <div><span>1</span><p><b>Read the three cards at the top.</b> Each card counts all monitored agents: how many have a problem, the main reason (with the target it missed) and which agent to start with. Agents with too little activity in the period are shown as “not measured” — never as passing.</p></div>
                <div><span>2</span><p><b>Check the overall strip below.</b> Overall status, agents monitored, activity and AI-policy gaps in one line.</p></div>
                <div><span>3</span><p><b>Select an agent.</b> Any agent named in a card or table opens straight to its evidence.</p></div>
                <div><span>4</span><p><b>Add details.</b> Under Manage agents, give each agent a name, department, owners and budget so policy checks and Cost can be rated.</p></div>
              </div>
            </section>

            <section id="help-layout">
              <h3>Finding your way around</h3>
              <dl className="help-dl">
                <dt>Reporting period</dt><dd>Last 24 hours, 7, 30 or 90 days. Agents with no activity in the period show their most recent 90 days instead, labelled “Last 90 days”.</dd>
                <dt>Overview</dt><dd>Health, Risk and Cost cards, the overall status strip, a plain-English summary, trends, status by department and every agent in one table.</dd>
                <dt>Agents</dt><dd>Every monitored agent as a card, grouped and filterable.</dd>
                <dt>Manage agents</dt><dd>Add details to an agent, stop monitoring agents you don’t need (e.g. test agents), or restore them.</dd>
                <dt>How it’s measured</dt><dd>The full metric library: definitions, formulas, sources, limits and the reasoning behind each limit.</dd>
                <dt>Data sources</dt><dd>What was loaded and from where. Start here when a number looks wrong.</dd>
              </dl>
            </section>

            <section id="help-manage">
              <h3>Which agents are shown</h3>
              <p className="lead">Every agent that sent telemetry to Application Insights in the last 90 days is <b>monitored automatically</b>. There is nothing to connect.</p>
              <ul>
                <li><b>Quiet agents still show data.</b> If an agent had no activity in the selected period, its figures use its most recent 90 days and it carries a “Last 90 days” label.</li>
                <li><b>Names.</b> Until you add a display name, an agent is shown with a readable version of its schema name (e.g. <code>sps_dailyCyberPrivacyBriefing</code> → “Daily Cyber Privacy Briefing”).</li>
                <li><b>Edit details</b> (Manage agents or the agent page) to add purpose, department, owners, risk tier, approval and budget. These drive the AI policy checks and the Cost rating.</li>
                <li><b>Stop monitoring</b> hides an agent from every figure. Telemetry is kept and you can monitor it again from Manage agents.</li>
                <li><b>Add by hand</b> is only needed for an agent that has not sent any telemetry yet.</li>
              </ul>
              {sources?.registry?.label && <p className="help-note">Agent details are stored in: <b>{sources.registry.label}</b>.</p>}
            </section>

            <section id="help-status">
              <h3>How statuses work</h3>
              <div className="table-wrap">
                <table className="table help-table">
                  <thead><tr><th scope="col">Status</th><th scope="col">Meaning</th><th scope="col">Expected response</th></tr></thead>
                  <tbody>{STATUS.map(([s, label, meaning, action]) => <tr key={s}><td><Pill s={s}>{label}</Pill></td><td>{meaning}</td><td>{action}</td></tr>)}</tbody>
                </table>
              </div>
              <h4>The roll-up rule: worst result wins</h4>
              <div className="rollup">
                <div><b>Metric</b><span>rated against its own limits</span></div>
                <ChevronRight size={18} aria-hidden="true" />
                <div><b>Health / Risk / Cost</b><span>worst metric in the area</span></div>
                <ChevronRight size={18} aria-hidden="true" />
                <div><b>Agent overall</b><span>worst of the three areas</span></div>
              </div>
              <p>We deliberately do <b>not</b> average. An agent that is 99.9% available but leaking data is not “mostly fine”. With worst-wins, every red can be traced to one metric.</p>
              <h4>Why “No data” is never “Healthy”</h4>
              <p>Each metric needs a minimum amount of activity (e.g. 5 runs or 10 user messages) before it is rated. Below that, its figure is still shown but the status is <b>No data</b> and it is left out of the roll-up.</p>
            </section>

            <section id="help-health">
              <h3>Health metrics</h3>
              <p className="lead">Is the agent answering, finishing the job, responding quickly, and are its tools working?</p>
              <MetricTable library={library} pillar="health" />
              <ul>
                <li><b>Runs</b> are chat conversations where a user sent a message, plus <b>automatic runs</b> started by a trigger or schedule (e.g. a daily briefing agent). Greeting-only sessions are not counted.</li>
                <li><b>Response time</b> runs from a user message to the agent’s next reply. Replies slower than {slow}s count as “very slow”. Automatic runs have no chat reply, so they don’t affect availability or response time.</li>
                <li><b>Safety blocks are not errors.</b> They are reported once, under Risk.</li>
              </ul>
            </section>

            <section id="help-risk">
              <h3>Risk metrics</h3>
              <p className="lead">Is someone attacking the agent, is it meeting harmful content, or is it trying to do something it shouldn’t?</p>
              <p>Copilot Studio checks requests and answers with Responsible AI filters. When something is blocked it records a <code>ContentFiltered</code> error with a sub-code that says why:</p>
              <ul>
                <li><b>Jailbreak attempts</b> (OpenAIJailBreak) — a user tried to override the agent’s instructions.</li>
                <li><b>Attacks hidden in documents</b> (OpenAIndirectAttack) — a knowledge source contained instructions aimed at the model.</li>
                <li><b>Harmful content</b> (OpenAIHate, OpenAISexual, OpenAIViolence, OpenAISelfHarm).</li>
                <li><b>Data policy blocks</b> (DataLossPreventionViolation).</li>
              </ul>
              <MetricTable library={library} pillar="risk" />
            </section>

            <section id="help-cost">
              <h3>Cost metrics</h3>
              <p className="lead">What the agents are estimated to cost, and how that compares with their budgets.</p>
              <MetricTable library={library} pillar="cost" />
              <ul>
                <li><b>Copilot Studio agents</b> are billed in Copilot Credits (classic answer 1, generative answer 2, agent action 5, tenant graph grounding 10). Estimate = (chat replies + automatic runs) × credits per response (default {sources?.creditsPerResponse || 2}) × price per credit ($0.01 pay-as-you-go).</li>
                <li><b>Foundry / SDK agents</b>: tokens × the price for the model used.</li>
                <li><b>Cost is only rated when a monthly budget is set</b> (Manage agents → Edit details). Without one, spend is still shown.</li>
                <li>These are estimates for steering. Billed figures are in the Power Platform admin center and Azure Cost Management.</li>
              </ul>
            </section>

            <section id="help-policy">
              <h3>AI policy checks</h3>
              <p>These drive the <b>Out of AI policy</b> figure. Each compares the telemetry with the agent details; fix them by selecting <b>Edit details</b>.</p>
              {library && (
                <table className="table help-table">
                  <thead><tr><th scope="col">Check</th><th scope="col">Rule</th></tr></thead>
                  <tbody>{library.compliance.map((c) => <tr key={c.id}><td><b>{c.name}</b></td><td>{c.definition}</td></tr>)}</tbody>
                </table>
              )}
            </section>

            <section id="help-data">
              <h3>Where the data comes from</h3>
              <div className="pipeline">
                <div><b>AI agents</b><span>Copilot Studio, Foundry</span></div>
                <ChevronRight size={18} aria-hidden="true" />
                <div><b>Application Insights</b><span>runtime events, error codes, tokens</span></div>
                <ChevronRight size={18} aria-hidden="true" />
                <div><b>Dashboard API</b><span>queries + metric library</span></div>
                <ChevronRight size={18} aria-hidden="true" />
                <div><b>This dashboard</b><span>every agent, automatically</span></div>
              </div>
              <dl className="help-dl">
                <dt>Runtime telemetry</dt><dd>Copilot Studio sends conversation events to Application Insights. The API reads them server-side; no credentials reach the browser.</dd>
                <dt>Agent identity</dt><dd>Each conversation is assigned to exactly one agent by its topic schema name (stable even if renamed), otherwise its bot name.</dd>
                <dt>Production vs test</dt><dd>Copilot Studio flags test-pane traffic. Conversations without that flag count as production use.</dd>
                <dt>Freshness</dt><dd>Application Insights usually lags a few minutes. Results are cached for one minute; Refresh always fetches new figures.</dd>
              </dl>
            </section>

            <section id="help-live">
              <h3>Live data vs demo data</h3>
              <ul>
                <li>In live mode <b>everything is live</b>. No sample or template agents are mixed in.</li>
                <li>If live data cannot be retrieved you see a red banner naming the step that failed.</li>
                <li><b>Show demo data</b> loads a synthetic portfolio built with the same rules. It is clearly marked and read-only.</li>
              </ul>
              {mode && <p className="help-note">You are currently viewing: <b>{mode === 'live' ? 'live telemetry' : mode === 'demo' ? 'demo data' : mode === 'error' ? 'no data (live retrieval failed)' : 'loading'}</b>.</p>}
            </section>

            <section id="help-faq">
              <h3>FAQ and troubleshooting</h3>
              <Faq q="An agent shows “No data” even though it is used.">Its activity is below the minimum needed to rate a metric (e.g. 5 runs). The figures are still shown on its page; the status turns colour once there is enough activity. Try a longer reporting period.</Faq>
              <Faq q="An agent shows “Last 90 days”.">It had no activity in the selected period, so the dashboard shows its most recent 90 days instead of a blank card.</Faq>
              <Faq q="An agent appears twice.">It sends telemetry under two names. Edit one, add the other name under “Other telemetry names”, and stop monitoring the duplicate.</Faq>
              <Faq q="Cost shows “No data” but there is spend.">Cost is only rated against a budget. Select Edit details and set a monthly budget.</Faq>
              <Faq q="My changes disappear after a while.">The API is saving agent details in a temporary file. Set REGISTRY_BLOB_SAS_URL so they are stored permanently (see Data sources).</Faq>
              <Faq q="The page says live telemetry could not be retrieved.">The banner names the failing step. Typical causes: LOG_ANALYTICS_WORKSPACE_ID missing, or the API identity lacks Log Analytics Reader.</Faq>
            </section>

            <section id="help-glossary">
              <h3>Glossary</h3>
              <dl className="help-dl">
                <dt>Run</dt><dd>A chat conversation in which the user sent a message, or an automatic run started by a trigger or schedule.</dd>
                <dt>Telemetry ID</dt><dd>The name an agent appears under in Application Insights — usually its Copilot Studio schema name.</dd>
                <dt>Escalation / fallback</dt><dd>The conversation was handed to a human, or the agent did not understand the request.</dd>
                <dt>95th percentile</dt><dd>95% of replies were faster than this value.</dd>
                <dt>Safety block</dt><dd>A request or answer stopped by the platform guardrails.</dd>
                <dt>Copilot Credit</dt><dd>The unit Copilot Studio usage is billed in.</dd>
                <dt>Data coverage</dt><dd>Share of applicable metrics on active agents that have enough data to produce a status.</dd>
              </dl>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
