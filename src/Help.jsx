import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, HelpCircle, Search, X } from 'lucide-react';

/*
 * In-app guide. Metric tables are rendered from the live metric library
 * returned by the API, so this page can never drift from the limits applied.
 */

const STATUS = [
  ['green', 'Healthy', 'Every measured check in the area is within its Healthy limit.', 'No action.'],
  ['amber', 'Watch', 'At least one check is in the Watch band and none is at Action.', 'Owner reviews the trend within a working day.'],
  ['red', 'Action required', 'At least one check has passed its Action limit.', 'Owner investigates and fixes.'],
  ['unknown', 'No data', 'No telemetry, the data source is not connected, or too little activity to judge.', 'Treat as a visibility gap, not a pass.'],
];

const SECTIONS = [
  { id: 'start', title: 'Getting started' },
  { id: 'layout', title: 'Finding your way around' },
  { id: 'manage', title: 'Connecting and removing agents' },
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
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the guide (e.g. connect, budget, no data)" />
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
                For every connected AI agent, this dashboard answers three questions: is it <b>working</b> (Health), is it <b>behaving safely</b> (Risk) and is it <b>affordable</b> (Cost)?
                Every colour is calculated automatically from runtime telemetry — nobody types in a status.
              </p>
              <div className="help-steps">
                <div><span>1</span><p><b>Read the three cards at the top.</b> Health, Risk and Cost each show the headline figure, how many agents are in each status and which agents need attention.</p></div>
                <div><span>2</span><p><b>Check the overall strip below.</b> The overall status, connected agents, conversations and AI-policy gaps in one line.</p></div>
                <div><span>3</span><p><b>Select an agent.</b> Any agent named in a card opens straight to the evidence for that area.</p></div>
                <div><span>4</span><p><b>Read the evidence.</b> Each metric shows its value, its limits, how much data it is based on and where the data comes from.</p></div>
              </div>
              <p>Hover over any <span className="inline-i">ⓘ</span> icon for a one-line definition, or select <b>Explain</b> next to a panel title.</p>
            </section>

            <section id="help-layout">
              <h3>Finding your way around</h3>
              <dl className="help-dl">
                <dt>Header</dt><dd>Shows <Pill s="green">Live data</Pill> or <Pill s="amber">Demo data</Pill>, when the figures were calculated, sign-in and Refresh.</dd>
                <dt>Reporting period</dt><dd>Last 24 hours, 7, 30 or 90 days. It applies to every number, status and chart on every page.</dd>
                <dt>Overview</dt><dd>Health, Risk and Cost cards, the overall status strip, a plain-English summary, trends, status by department and the agents needing action.</dd>
                <dt>Agents</dt><dd>Every connected agent as a card, grouped and filterable. Select a card for its evidence.</dd>
                <dt>Manage agents</dt><dd>Connect agents that send telemetry, edit their profile (owners, department, risk tier, budget) and disconnect retired agents.</dd>
                <dt>How it’s measured</dt><dd>The full metric library: definitions, formulas, sources, limits and the reasoning behind each limit.</dd>
                <dt>Data sources</dt><dd>What was loaded and from where. Start here when a number looks wrong.</dd>
              </dl>
            </section>

            <section id="help-manage">
              <h3>Connecting and removing agents</h3>
              <p className="lead">The dashboard monitors and counts <b>only connected agents</b>, so “Connected agents” is always exactly the list on Manage agents.</p>
              <ul>
                <li><b>Connect a discovered agent:</b> agents that sent telemetry in the period but are not connected are listed under “Sending telemetry but not connected”. Select <b>Connect</b>, fill in what you know and save. The telemetry ID is filled in for you.</li>
                <li><b>Connect manually:</b> for an agent that has not sent telemetry yet, enter its Copilot Studio schema name (or bot name) as the telemetry ID. It shows as “No activity” until its first conversation.</li>
                <li><b>Edit:</b> the pencil icon (or <b>Edit profile</b> on the agent page) updates owners, department, risk tier, approval and budget. These drive the AI policy checks and the Cost rating.</li>
                <li><b>Disconnect:</b> the bin icon stops monitoring an agent. Telemetry is not deleted and the agent reappears under “not connected” if it is still used.</li>
                <li>You must be <b>signed in</b> to make changes. Every change records who made it.</li>
              </ul>
              {sources?.registry?.label && <p className="help-note">The connected-agents list is stored in: <b>{sources.registry.label}</b>.</p>}
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
              <p>If a metric has no data source or too little activity (each metric has a minimum, e.g. 10 user messages), it shows <b>No data</b> and is left out of the roll-up. An agent is only called Healthy when its Health could actually be measured.</p>
            </section>

            <section id="help-health">
              <h3>Health metrics</h3>
              <p className="lead">Is the agent answering, finishing the job, responding quickly, and are its tools working?</p>
              <p>The Health card shows the share of conversations resolved across all connected agents, plus the share with errors, the share of user messages answered and the slowest agent.</p>
              <MetricTable library={library} pillar="health" />
              <ul>
                <li><b>Only engaged conversations count</b> — the user sent at least one message. Channel events (e.g. “conversation started”) are not treated as user messages.</li>
                <li><b>Response time</b> runs from a user message to the agent’s next reply. Replies slower than {slow}s count as “very slow”.</li>
                <li><b>Resolved</b> means the agent replied, nothing broke, and the conversation was not escalated or sent to the fallback topic.</li>
                <li><b>Safety blocks are not errors.</b> They are reported once, under Risk.</li>
              </ul>
            </section>

            <section id="help-risk">
              <h3>Risk metrics</h3>
              <p className="lead">Is someone attacking the agent, is it meeting harmful content, or is it trying to do something it shouldn’t?</p>
              <p>Copilot Studio checks every request and answer with Responsible AI filters. When something is blocked it records a <code>ContentFiltered</code> error with a sub-code that says why. The Risk card totals these “safety blocks”:</p>
              <ul>
                <li><b>Jailbreak attempts</b> (OpenAIJailBreak) — a user tried to override the agent’s instructions.</li>
                <li><b>Attacks hidden in documents</b> (OpenAIndirectAttack) — a knowledge source contained instructions aimed at the model.</li>
                <li><b>Harmful content</b> (OpenAIHate, OpenAISexual, OpenAIViolence, OpenAISelfHarm).</li>
                <li><b>Data policy blocks</b> (DataLossPreventionViolation) — the agent tried to use a connector a DLP policy forbids.</li>
              </ul>
              <MetricTable library={library} pillar="risk" />
              <p className="help-note">A blocked attack is a successful defence, but it still raises Risk: someone is probing the agent. Model-level guardrail metrics in Azure AI Foundry are set per model deployment, not per agent, so they are not used for agent statuses.</p>
            </section>

            <section id="help-cost">
              <h3>Cost metrics</h3>
              <p className="lead">What the agents are estimated to cost in the period, and how that compares with their budgets.</p>
              <MetricTable library={library} pillar="cost" />
              <ul>
                <li><b>Copilot Studio agents</b> are billed in Copilot Credits (classic answer 1, generative answer 2, agent action 5, tenant graph grounding 10). Estimate = answered messages × credits per response (default {sources?.creditsPerResponse || 2}) × price per credit ($0.01 pay-as-you-go).</li>
                <li>Agents used only by Microsoft 365 Copilot-licensed employees can be set to “Included in Microsoft 365 Copilot licences”.</li>
                <li><b>Foundry / SDK agents</b>: tokens × the price for the model used.</li>
                <li><b>Cost is only rated when a monthly budget is set</b> on the agent profile (Manage agents → edit). Without one, spend is still shown but Cost is “No data”, and the Cost card lists how many active agents have no budget.</li>
                <li>These are estimates for steering. Billed figures are in the Power Platform admin center and Azure Cost Management.</li>
              </ul>
            </section>

            <section id="help-policy">
              <h3>AI policy checks</h3>
              <p>These drive the <b>Out of AI policy</b> figure. Each compares what the telemetry shows with the agent profile; an agent is out of policy if any check fails. Fix them by editing the agent under Manage agents.</p>
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
                <div><b>This dashboard</b><span>connected agents only</span></div>
              </div>
              <div className="pipeline side-feed">
                <div><b>Connected-agents list</b><span>which agents are monitored + their profile</span></div>
                <span className="feed-label">joined by telemetry ID / aliases ↗</span>
              </div>
              <dl className="help-dl">
                <dt>Runtime telemetry</dt><dd>Copilot Studio sends conversation events to Application Insights. The API reads them server-side; no credentials reach the browser.</dd>
                <dt>Agent identity</dt><dd>Each conversation is assigned to exactly one agent — by its topic schema name (stable even if renamed), otherwise its bot name — and matched to a connected agent by telemetry ID or alias.</dd>
                <dt>Production vs test</dt><dd>Copilot Studio flags test-pane traffic. Conversations without that flag count as production use.</dd>
                <dt>Freshness</dt><dd>All queries share one fixed time window. Results are cached for one minute; Refresh and any change to the agent list always fetch new figures.</dd>
              </dl>
            </section>

            <section id="help-live">
              <h3>Live data vs demo data</h3>
              <ul>
                <li>In live mode <b>everything is live</b>: connected agents, their profiles and telemetry. No sample or template agents are mixed in.</li>
                <li>If live data cannot be retrieved you see a red banner naming the step that failed, and no figures.</li>
                <li><b>Show demo data</b> loads a synthetic portfolio built with the same rules. It is clearly marked and read-only.</li>
              </ul>
              {mode && <p className="help-note">You are currently viewing: <b>{mode === 'live' ? 'live telemetry' : mode === 'demo' ? 'demo data' : mode === 'error' ? 'no data (live retrieval failed)' : 'loading'}</b>.</p>}
            </section>

            <section id="help-faq">
              <h3>FAQ and troubleshooting</h3>
              <Faq q="The number of agents looks wrong.">Only connected agents are counted. Open Manage agents: the connected list is exactly what is counted, and any agent sending telemetry that is not connected is listed underneath.</Faq>
              <Faq q="The same agent appears twice under “not connected”.">It sends telemetry under two names (e.g. its schema name and display name). Connect one and add the other name under “Other telemetry names”; both are then counted as one agent.</Faq>
              <Faq q="Cost shows “No data” but there is spend.">Cost is only rated against a budget. Edit the agent and set a monthly budget.</Faq>
              <Faq q="I can’t connect or remove agents.">Sign in (top right). If you are signed in and still blocked, your administrator may have limited changes to a specific role.</Faq>
              <Faq q="An agent shows “No data” even though people use it.">Its activity is below the minimum for the selected period (try a longer period), or the specific metric needs a source that is not connected. The agent page lists every unmeasured metric and why.</Faq>
              <Faq q="The page says live telemetry could not be retrieved.">The banner names the failing step. Typical causes: LOG_ANALYTICS_WORKSPACE_ID missing, the API identity lacks Log Analytics Reader, or the connected-agents storage cannot be read.</Faq>
              <Faq q="Numbers differ from Copilot Studio’s built-in Analytics.">Copilot Studio Analytics uses its own session definitions. This dashboard counts engaged conversations and errors directly from Application Insights events, so small differences are normal.</Faq>
              <Faq q="How do I change a limit or add a metric?">Edit api/shared/metrics-registry.js. Limits are defined once and applied everywhere on the next deployment. Then run npm run demo:generate.</Faq>
            </section>

            <section id="help-glossary">
              <h3>Glossary</h3>
              <dl className="help-dl">
                <dt>Connected agent</dt><dd>An agent on the Manage agents list. Only these are monitored and counted.</dd>
                <dt>Telemetry ID</dt><dd>The name an agent appears under in Application Insights — usually its Copilot Studio schema name.</dd>
                <dt>Engaged conversation</dt><dd>A session in which the user sent at least one message.</dd>
                <dt>Escalation / fallback</dt><dd>The conversation was handed to a human, or the agent did not understand the request.</dd>
                <dt>95th percentile</dt><dd>95% of replies were faster than this value.</dd>
                <dt>Safety block</dt><dd>A request or answer stopped by the platform guardrails.</dd>
                <dt>DLP policy</dt><dd>A Power Platform data loss prevention rule controlling which connectors may be used.</dd>
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
