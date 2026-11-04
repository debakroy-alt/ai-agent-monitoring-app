import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, HelpCircle, Search, X } from 'lucide-react';

/*
 * In-app guide: how the dashboard works, what each metric means, why it is
 * shown the way it is, and what to do when something looks wrong.
 *
 * Metric tables are rendered from the live metric library returned by the API,
 * so this page can never drift from the limits actually being applied.
 */

const STATUS = [
  ['green', 'Healthy', 'Every measured check in the area is within its Healthy limit.', 'No action.'],
  ['amber', 'Watch', 'At least one check is in the Watch band and none is at Action.', 'Owner reviews the trend within a working day.'],
  ['red', 'Action required', 'At least one check has passed its Action limit.', 'Owner investigates and fixes. Production agents appear in “Act now”.'],
  ['unknown', 'No data', 'No telemetry, the data source is not connected, or too little activity to judge.', 'Treat as a visibility gap, not a pass. See Data sources.'],
];

const SECTIONS = [
  { id: 'start', title: 'Getting started' },
  { id: 'layout', title: 'Finding your way around' },
  { id: 'status', title: 'How statuses work' },
  { id: 'health', title: 'Health metrics' },
  { id: 'risk', title: 'Risk metrics' },
  { id: 'cost', title: 'Cost metrics' },
  { id: 'policy', title: 'AI policy checks' },
  { id: 'tiles', title: 'Overview figures' },
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
  if (!library) {
    return <p className="help-note">Metric definitions load with the data. Refresh the dashboard (or open demo data) to see the full table here.</p>;
  }
  const rows = library.metrics.filter((m) => m.pillar === pillar);
  return (
    <div className="table-wrap">
      <table className="table help-table">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">What it tells you</th>
            <th scope="col">How it is calculated</th>
            <th scope="col">Limits</th>
            <th scope="col">Data</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>
                <b>{m.name}</b>
                {pillar === 'health' && <small className="muted block">{library.healthComponents[m.component]}</small>}
              </td>
              <td>
                {m.definition}
                {m.basis && <small className="muted block">Why: {m.basis}</small>}
              </td>
              <td>
                <code className="block">{m.formula}</code>
                <small className="muted block">{m.source}</small>
                {m.minSample && <small className="muted block">Minimum activity before rating: {m.minSample}</small>}
              </td>
              <td>{m.threshold}</td>
              <td>
                <span className={`avail ${m.availability}`}>{AVAIL[m.availability]}</span>
              </td>
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
      <summary>
        <ChevronRight size={15} aria-hidden="true" />
        {q}
      </summary>
      <div>{children}</div>
    </details>
  );
}

export default function Help({ close, library, kpiDefs, initialSection = 'start', sources, mode }) {
  const [active, setActive] = useState(initialSection);
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState(new Set());
  const bodyRef = useRef(null);
  const closeRef = useRef(null);

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

  // Highlight the section currently in view.
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

  // Simple text filter: hide sections whose text doesn't match.
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

  const visibleCount = SECTIONS.length - hidden.size;
  const slow = sources?.slowReplySeconds || 30;

  const tiles = useMemo(
    () => [
      ['Agents monitored', kpiDefs.monitored, 'Size of the estate under watch, and how much of it is in production.'],
      ['Need attention', kpiDefs.attention, 'The headline workload for agent owners.'],
      ['Act now (in production)', kpiDefs.highRisk, 'The “fix now” list for leadership. Test agents are excluded on purpose.'],
      ['Out of AI policy', kpiDefs.compliance, 'Governance view: agents running without the controls the AI policy expects.'],
      ['Conversations', kpiDefs.conversations, 'Shows how much the estate is actually used.'],
      ['Estimated spend', kpiDefs.spend, 'An estimate for steering, not an invoice. Billed figures are in the Power Platform admin center and Azure Cost Management.'],
      ['Open alerts', kpiDefs.alerts, 'One agent can carry several alerts; this shows the depth of issues, not just breadth.'],
      ['Data coverage', kpiDefs.coverage, 'How much of the picture the dashboard can actually see. Low coverage means grey statuses dominate.'],
    ],
    [kpiDefs]
  );

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
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the guide (e.g. latency, no data, budget)" />
          </label>
          <button ref={closeRef} className="icon help-close" onClick={close} type="button" aria-label="Close guide">
            <X size={20} />
          </button>
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
            {query && visibleCount === 0 && <p className="help-note">Nothing in the guide matches “{query}”.</p>}

            <section id="help-start">
              <h3>Getting started</h3>
              <p className="lead">
                This dashboard answers three questions for every AI agent: is it <b>working</b> (Health), is it <b>behaving safely</b> (Risk) and is it{' '}
                <b>affordable</b> (Cost)? Every colour is calculated automatically from runtime telemetry and the AI system inventory — nobody types in a status.
              </p>
              <div className="help-steps">
                <div><span>1</span><p><b>Read the summary.</b> The overall status and “What leadership should know” give the headline in one read.</p></div>
                <div><span>2</span><p><b>Select a figure or department.</b> It opens the Agents page already filtered to the agents behind that number.</p></div>
                <div><span>3</span><p><b>Open an agent.</b> Select its card, or its Health / Risk / Cost button to jump straight to that evidence.</p></div>
                <div><span>4</span><p><b>Read the evidence.</b> Each metric shows its value, its limits, how much data it is based on and where the data comes from.</p></div>
              </div>
              <p>Hover over any <span className="inline-i">ⓘ</span> icon for a one-line definition, or select <b>Explain</b> next to a panel title to jump to the right part of this guide.</p>
            </section>

            <section id="help-layout">
              <h3>Finding your way around</h3>
              <dl className="help-dl">
                <dt>Header</dt>
                <dd>The badge shows whether you are looking at <Pill s="green">Live data</Pill> or <Pill s="amber">Demo data</Pill>. “Data as of” is when the figures were calculated. Refresh re-queries immediately.</dd>
                <dt>Reporting period</dt>
                <dd>Last 24 hours, 7, 30 or 90 days. It applies to <i>every</i> number, status and chart on every page. Charts show hours for 24 hours and days otherwise.</dd>
                <dt>Auto-refresh</dt>
                <dd>When ticked, figures update every 5 minutes. Application Insights itself usually lags a few minutes behind the agent.</dd>
                <dt>Overview</dt>
                <dd>Overall status, key points for leadership, eight headline figures, Health / Risk / Cost at a glance, conversation and error trends, status by department and the agents needing action.</dd>
                <dt>Agents</dt>
                <dd>Every agent as a card, grouped by department (or location, platform, environment). Filter by status, area, department and more, or search by name, purpose, owner or ID.</dd>
                <dt>Agent page</dt>
                <dd>Profile from the AI inventory, a one-line explanation of the status, Health / Risk / Cost evidence, activity chart, automatic AI-policy checks and the most frequent error codes.</dd>
                <dt>How it’s measured</dt>
                <dd>The full metric library — definitions, formulas, sources, limits and the reasoning behind each limit.</dd>
                <dt>Data sources</dt>
                <dd>What was loaded, from where, and what is missing (for example agents seen in telemetry but not in the inventory). Start here when a number looks wrong.</dd>
              </dl>
            </section>

            <section id="help-status">
              <h3>How statuses work</h3>
              <div className="table-wrap">
                <table className="table help-table">
                  <thead><tr><th scope="col">Status</th><th scope="col">Meaning</th><th scope="col">Expected response</th></tr></thead>
                  <tbody>
                    {STATUS.map(([s, label, meaning, action]) => (
                      <tr key={s}><td><Pill s={s}>{label}</Pill></td><td>{meaning}</td><td>{action}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h4>The roll-up rule: worst result wins</h4>
              <div className="rollup">
                <div><b>Metric</b><span>rated against its own limits</span></div>
                <ChevronRight size={18} aria-hidden="true" />
                <div><b>Area</b><span>Health, Risk or Cost = worst metric</span></div>
                <ChevronRight size={18} aria-hidden="true" />
                <div><b>Agent</b><span>worst of the three areas</span></div>
                <ChevronRight size={18} aria-hidden="true" />
                <div><b>Portfolio</b><span>worst agent</span></div>
              </div>
              <p>
                We deliberately do <b>not</b> average. An agent that is 99.9% available but leaking data is not “mostly fine”; averaging would hide exactly the problem an
                executive needs to see. With worst-wins, every red can be traced to one specific metric on the agent page.
              </p>
              <h4>Why “No data” is never “Healthy”</h4>
              <p>
                If a metric has no data source, or too little activity to be meaningful (each metric has a minimum, e.g. 10 user messages), it shows <b>No data</b> and is
                left out of the roll-up — it never counts as a pass. An agent is only called Healthy when its Health could actually be measured, so a quiet or
                un-instrumented agent cannot look healthy by default.
              </p>
            </section>

            <section id="help-health">
              <h3>Health metrics</h3>
              <p className="lead">Is the agent answering, finishing the job, responding quickly, and are its tools working?</p>
              <div className="formula">
                <span className="eyebrow-sm">Operational health</span>
                <div className="formula-row">
                  {['Availability', 'Completion', 'Speed', 'Errors', 'Tools & connectors'].map((c, i) => (
                    <React.Fragment key={c}>{i > 0 && <span className="plus">+</span>}<span className="term">{c}</span></React.Fragment>
                  ))}
                </div>
                <p>Each component takes its worst metric; Health takes the worst component.</p>
              </div>
              <MetricTable library={library} pillar="health" />
              <h4>Things to know</h4>
              <ul>
                <li><b>Only engaged conversations count</b> — the user sent at least one message. Proactive greetings with no reply do not dilute the rates.</li>
                <li><b>Response time</b> runs from a user message to the agent’s next reply, so it includes model, knowledge-search and connector time — what the user experiences. Replies slower than {slow}s count as “very slow”.</li>
                <li><b>Resolved</b> means the agent replied, nothing broke, and the conversation was not escalated to a human or sent to the fallback topic. People who simply walk away also count as not resolved, which is why the Healthy limit is 85%, not 99%.</li>
                <li><b>Safety blocks are not errors.</b> A blocked jailbreak or harmful message is reported once, under Risk, and is not also counted as a Health error.</li>
                <li><b>Tool & connector failures</b> come from Copilot Studio error codes such as FlowActionTimedOut (an agent flow that did not reply within 100 seconds) and ConnectorRequestFailure.</li>
              </ul>
            </section>

            <section id="help-risk">
              <h3>Risk metrics</h3>
              <p className="lead">Is someone attacking the agent, is it meeting harmful content, or is it trying to do something it shouldn’t?</p>
              <p>
                Copilot Studio checks every request twice — the user’s input and the draft answer — with Responsible AI filters. When something is blocked it records a
                <code>ContentFiltered</code> error with a sub-code that says why. The dashboard reads those sub-codes per agent:
              </p>
              <ul>
                <li><b>Jailbreak attempts</b> (OpenAIJailBreak) — a user tried to override the agent’s instructions.</li>
                <li><b>Attacks hidden in documents</b> (OpenAIndirectAttack) — a knowledge source contained instructions aimed at the model. Review that source.</li>
                <li><b>Harmful content</b> (OpenAIHate, OpenAISexual, OpenAIViolence, OpenAISelfHarm).</li>
                <li><b>Data policy blocks</b> (DataLossPreventionViolation) — the agent tried to use a connector the organisation’s DLP policy forbids.</li>
              </ul>
              <MetricTable library={library} pillar="risk" />
              <p className="help-note">
                A blocked attack is a <i>successful</i> defence, but it still raises Risk: it tells the owner someone is probing the agent. Jailbreaks are rated per 1,000
                conversations so busy agents are not penalised for their volume. Model-level guardrail metrics in Azure AI Foundry are configured per model deployment,
                not per agent, so they are not used for agent statuses.
              </p>
            </section>

            <section id="help-cost">
              <h3>Cost metrics</h3>
              <p className="lead">What the agent is estimated to cost in the period, and how that compares with its budget.</p>
              <MetricTable library={library} pillar="cost" />
              <ul>
                <li>
                  <b>Copilot Studio agents</b> are billed in Copilot Credits. Microsoft’s rate card: classic answer 1 credit, generative answer 2, agent action 5,
                  tenant graph grounding 10. The dashboard estimates <code>answered messages × credits per response</code> (set per agent in the inventory as{' '}
                  <code>creditsPerResponse</code>; default {sources?.creditsPerResponse || 2}) × the price per credit (pay-as-you-go $0.01).
                </li>
                <li>Employee-facing use by people with a Microsoft 365 Copilot licence is not charged. Mark such agents with <code>"billingModel": "m365-copilot"</code> in the inventory and they show as “Included”.</li>
                <li><b>Foundry / SDK agents</b> send token counts; spend = input and output tokens × the price for the model used. Prices are configurable because they change often.</li>
                <li>Budget comes from <code>monthlyBudgetUsd</code> in the inventory and is pro-rated to the reporting period (e.g. 7 days = 7/30 of the monthly budget).</li>
                <li>These are <b>estimates for steering</b>. The billed figures live in the Power Platform admin center (Copilot Credit consumption) and Azure Cost Management.</li>
              </ul>
            </section>

            <section id="help-policy">
              <h3>AI policy checks</h3>
              <p>
                These drive the <b>Out of AI policy</b> figure. They are not a manual attestation: each one compares what the telemetry shows with what the AI inventory
                says. An agent is out of policy if any check fails.
              </p>
              {library ? (
                <table className="table help-table">
                  <thead><tr><th scope="col">Check</th><th scope="col">Rule</th></tr></thead>
                  <tbody>{library.compliance.map((c) => <tr key={c.id}><td><b>{c.name}</b></td><td>{c.definition}</td></tr>)}</tbody>
                </table>
              ) : (
                <p className="help-note">Checks load with the data.</p>
              )}
              <p>The most common real-world failure is an agent that is live in Copilot Studio but was never registered — these are listed by name on <b>Data sources</b>.</p>
            </section>

            <section id="help-tiles">
              <h3>Overview figures</h3>
              <div className="table-wrap">
                <table className="table help-table">
                  <thead><tr><th scope="col">Figure</th><th scope="col">Definition</th><th scope="col">Why it is there</th></tr></thead>
                  <tbody>{tiles.map(([t, d, w]) => <tr key={t}><td><b>{t}</b></td><td>{d}</td><td>{w}</td></tr>)}</tbody>
                </table>
              </div>
              <p>Figures with a “View agents” link open the Agents page pre-filtered to the agents behind the number.</p>
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
                <div><b>This dashboard</b><span>statuses, figures, drill-downs</span></div>
              </div>
              <div className="pipeline side-feed">
                <div><b>AI system inventory</b><span>department, owners, purpose, risk tier, approval, budget</span></div>
                <span className="feed-label">joined by agent name ↗</span>
              </div>
              <dl className="help-dl">
                <dt>Runtime telemetry</dt>
                <dd>Copilot Studio sends conversation events (messages received and sent, topics, errors) to Application Insights. The API reads them server-side; no credentials ever reach the browser.</dd>
                <dt>Agent identity</dt>
                <dd>Each conversation is assigned to exactly one agent — by its topic schema name (stable even if the agent is renamed), otherwise by the bot name — and then matched to the inventory record by id, display name or alias. New agents appear automatically.</dd>
                <dt>Agent profile</dt>
                <dd>Department, owners, purpose, location, risk tier, approval, go-live date and budget come from the AI inventory{sources?.inventoryLabel ? ` (currently: ${sources.inventoryLabel})` : ''}. An unregistered agent still appears, labelled “Unassigned”, and fails the policy check.</dd>
                <dt>Production vs test</dt>
                <dd>Copilot Studio flags test-pane traffic. Conversations without that flag count as production use.</dd>
                <dt>Freshness</dt>
                <dd>All queries for one refresh share the same fixed time window, so every figure on the page describes exactly the same period. Results are cached for one minute to protect the data service when many people open the page at once; Refresh always fetches new figures.</dd>
              </dl>
            </section>

            <section id="help-live">
              <h3>Live data vs demo data</h3>
              <ul>
                <li>The dashboard always tries <b>live telemetry</b> first. Demo data is not even downloaded unless you ask for it.</li>
                <li>If live data cannot be retrieved you see a red banner and <b>no figures</b> — never old or sample numbers presented as real.</li>
                <li>If an automatic refresh fails after figures were shown, the last figures stay on screen with an amber banner stating their time.</li>
                <li><b>Show demo data</b> loads a synthetic portfolio built with the same rules as live data. It is marked with a “Demo data” badge and banner, and auto-refresh is paused.</li>
              </ul>
              {mode && <p className="help-note">You are currently viewing: <b>{mode === 'live' ? 'live telemetry' : mode === 'demo' ? 'demo data' : mode === 'error' ? 'no data (live retrieval failed)' : 'loading'}</b>.</p>}
            </section>

            <section id="help-faq">
              <h3>FAQ and troubleshooting</h3>
              <Faq q="The list of agents seemed to change between refreshes.">
                Fixed in this version. Each conversation is now mapped to one agent deterministically, every name for an agent is mapped to its single inventory record,
                all queries share one time window and agents are always sorted the same way (worst status first, then by conversations, then by name). If an agent still
                appears twice, add the extra name shown under “Telemetry names” on its page to the inventory record’s <code>aliases</code>.
              </Faq>
              <Faq q="An agent shows “Unassigned” department and no owners.">
                Its telemetry name has no matching record in the AI inventory. Open <b>Data sources</b>, copy the name listed under “Agents in telemetry without an
                inventory record”, and add it to the record’s <code>id</code> or <code>aliases</code>.
              </Faq>
              <Faq q="Why is the spend an estimate?">
                Copilot Studio does not publish billed credits to Application Insights, so the dashboard multiplies answered messages by the credits per response for that
                agent’s design. Set <code>creditsPerResponse</code> in the inventory (e.g. 5 for agents that mainly run actions) to make the estimate closer. The billed
                figure is in the Power Platform admin center.
              </Faq>
              <Faq q="An agent shows “No data” even though people are using it.">
                Either its activity is below the minimum for the selected period (try a longer period), or the specific metrics need a source that is not connected. The
                agent page lists every unmeasured metric and why.
              </Faq>
              <Faq q="Numbers differ from Copilot Studio’s built-in Analytics.">
                Copilot Studio Analytics uses its own session definitions and refresh cycle. This dashboard counts engaged conversations and errors directly from
                Application Insights events in the selected period, so small differences are normal.
              </Faq>
              <Faq q="A new agent isn’t showing up.">
                Check that Application Insights is connected in the agent’s settings in Copilot Studio and that it has had at least one conversation in the period.
                Ingestion can take a few minutes. Registered agents with no activity still appear as “No activity”.
              </Faq>
              <Faq q="How do I change a limit or add a metric?">
                Edit <code>api/shared/metrics-registry.js</code>. Limits, definitions and the reasoning behind them are defined once there and applied to every agent,
                figure, chart and this guide on the next deployment. Then run <code>npm run demo:generate</code> to refresh the demo data.
              </Faq>
              <Faq q="The page says live telemetry could not be retrieved.">
                The API could not query Log Analytics. Typical causes: LOG_ANALYTICS_WORKSPACE_ID is missing, the API’s managed identity lacks Log Analytics Reader, or
                the Function app is stopped. Use “Show demo data” for a walkthrough in the meantime.
              </Faq>
              <Faq q="Why did an agent go red when nothing changed?">
                Statuses are recalculated on every refresh over a rolling window. A short burst of errors, or lower volume making each failure weigh more, can tip a
                rate over a limit. Switch the reporting period to compare short and long-term behaviour.
              </Faq>
            </section>

            <section id="help-glossary">
              <h3>Glossary</h3>
              <dl className="help-dl">
                <dt>Agent</dt><dd>An AI assistant built in Copilot Studio or Azure AI Foundry.</dd>
                <dt>Engaged conversation</dt><dd>A session in which the user sent at least one message.</dd>
                <dt>User message</dt><dd>A single message from the user to the agent.</dd>
                <dt>Escalation / fallback</dt><dd>The conversation was handed to a human, or the agent did not understand the request.</dd>
                <dt>95th percentile</dt><dd>95% of replies were faster than this value; it captures the slow tail users notice, which an average hides.</dd>
                <dt>Limit</dt><dd>The boundary values that turn a measurement into Healthy, Watch or Action required.</dd>
                <dt>Jailbreak</dt><dd>A user trying to make the agent ignore its instructions.</dd>
                <dt>Indirect prompt attack</dt><dd>Instructions hidden in a document or web page the agent reads, aimed at manipulating it.</dd>
                <dt>DLP policy</dt><dd>A Power Platform data loss prevention rule that controls which connectors may be used together.</dd>
                <dt>Copilot Credit</dt><dd>The unit Copilot Studio usage is billed in.</dd>
                <dt>AI inventory</dt><dd>The system of record listing each approved AI system, its owners, purpose, risk tier and approval status.</dd>
                <dt>Data coverage</dt><dd>Share of applicable metrics that currently have enough data to produce a status.</dd>
              </dl>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
