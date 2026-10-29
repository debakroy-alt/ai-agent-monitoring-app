import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, HelpCircle, Search, X } from 'lucide-react';

/*
 * In-app guide: how the dashboard works, what each metric means, why it is
 * shown the way it is, and what to do when something looks wrong.
 *
 * Metric tables are rendered from the live metric library returned by the API,
 * so this page can never drift from the thresholds actually being applied.
 */

const STATUS = [
  ['green', 'Healthy', 'Every measured metric in the pillar is inside its green threshold.', 'No action.'],
  ['amber', 'Watch', 'At least one metric is in the amber band and none is red.', 'Owner should review the trend in the next working day.'],
  ['red', 'Action required', 'At least one metric has breached its red threshold.', 'Owner should investigate and remediate; production agents appear in the "High-severity" tile.'],
  ['unknown', 'No data', 'No telemetry, the data source is not connected, or the sample is too small to judge.', 'Treat as a visibility gap, not a pass. See Data Checks.'],
];

const SECTIONS = [
  { id: 'start', title: 'Getting started' },
  { id: 'layout', title: 'Finding your way around' },
  { id: 'status', title: 'How statuses work' },
  { id: 'health', title: 'Health metrics' },
  { id: 'risk', title: 'Risk metrics' },
  { id: 'cost', title: 'Cost metrics' },
  { id: 'policy', title: 'AI policy checks' },
  { id: 'tiles', title: 'Executive tiles' },
  { id: 'data', title: 'Where the data comes from' },
  { id: 'live', title: 'Live data vs demo data' },
  { id: 'why', title: 'Why it is designed this way' },
  { id: 'faq', title: 'FAQ and troubleshooting' },
  { id: 'glossary', title: 'Glossary' },
];

const AVAIL = { live: 'Live', conditional: 'When source connected', 'not-available': 'Not yet available' };

function Pill({ s, children }) {
  return (
    <span className={`status compact ${s}`}>
      <i />
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
    <div className="help-table-wrap">
      <table className="table help-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>What it tells you</th>
            <th>How it is calculated</th>
            <th>Thresholds</th>
            <th>Data</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>
                <b>{m.name}</b>
                {pillar === 'health' && <small className="muted block">{library.healthComponents[m.component]}</small>}
              </td>
              <td>{m.definition}</td>
              <td>
                <code className="block">{m.formula}</code>
                <small className="muted block">{m.source}</small>
                {m.minSample && <small className="muted block">Minimum sample: {m.minSample}</small>}
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
        <ChevronRight size={15} />
        {q}
      </summary>
      <div>{children}</div>
    </details>
  );
}

export default function Help({ close, library, kpiDefs, initialSection = 'start', sources, mode }) {
  const [active, setActive] = useState(initialSection);
  const [query, setQuery] = useState('');
  const bodyRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [close]);

  useEffect(() => {
    if (initialSection !== 'start') jump(initialSection);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // highlight the section currently in view
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return undefined;
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

  const jump = (id) => {
    const el = bodyRef.current?.querySelector(`#help-${id}`);
    if (el) bodyRef.current.scrollTo({ top: el.offsetTop - 16, behavior: 'smooth' });
    setActive(id);
  };

  // simple text filter: hide sections whose text doesn't match
  const [hidden, setHidden] = useState(new Set());
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
  const timeout = sources?.timeoutSeconds || 30;

  const tiles = useMemo(
    () => [
      ['Agents monitored', kpiDefs.monitored, 'Size of the estate under watch. Drill in to see every agent.'],
      ['In production', kpiDefs.production, 'Separates real business exposure from build/test activity.'],
      ['Need attention', kpiDefs.attention, 'The headline workload for agent owners.'],
      ['Open alerts', kpiDefs.alerts, 'One agent can carry several alerts; this shows the depth of issues, not just breadth.'],
      ['High-severity in production', kpiDefs.highRisk, 'The "fix now" list for leadership. Test agents are excluded on purpose.'],
      ['Out of AI policy', kpiDefs.compliance, 'Governance view: agents running without the controls the AI policy expects.'],
      ['Spend this period', kpiDefs.spend, 'Shows tokens instead of $ when no price list is configured, and "Not connected" when there is no token data.'],
      ['Telemetry coverage', kpiDefs.coverage, 'How much of the picture the dashboard can actually see. Low coverage means grey statuses dominate.'],
    ],
    [kpiDefs]
  );

  return (
    <div className="help-wrap" role="dialog" aria-modal="true" aria-label="How this dashboard works">
      <div className="help">
        <header className="help-head">
          <div className="help-title">
            <HelpCircle size={22} />
            <div>
              <h2>How this dashboard works</h2>
              <p>Metrics, rationale, data sources and tips. Press Esc to close.</p>
            </div>
          </div>
          <div className="help-search">
            <Search size={15} />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the guide (e.g. latency, grey, inventory)" />
          </div>
          <button className="icon help-close" onClick={close} type="button" aria-label="Close guide">
            <X size={20} />
          </button>
        </header>

        <div className="help-main">
          <nav className="help-nav">
            {SECTIONS.map((s) => (
              <button key={s.id} type="button" className={`${active === s.id ? 'on' : ''} ${hidden.has(s.id) ? 'dim' : ''}`} onClick={() => jump(s.id)} disabled={hidden.has(s.id)}>
                {s.title}
              </button>
            ))}
          </nav>

          <div className="help-body" ref={bodyRef}>
            {query && visibleCount === 0 && <p className="help-note">Nothing in the guide matches “{query}”.</p>}

            {/* ------------------------------------------------------------ */}
            <section id="help-start">
              <h3>Getting started</h3>
              <p className="lead">
                This dashboard shows, in one view, whether each AI agent is <b>working</b> (Health), <b>behaving safely</b> (Risk) and <b>affordable</b> (Cost). Every
                colour on the page is calculated automatically from runtime telemetry and the AI system inventory — nobody types in a status.
              </p>
              <div className="help-steps">
                <div><span>1</span><p><b>Scan the Executive Overview.</b> The purple banner and the “What leadership should know” paragraph give the headline in one read.</p></div>
                <div><span>2</span><p><b>Click a tile or department.</b> It opens the Agent Portfolio already filtered to the agents behind that number.</p></div>
                <div><span>3</span><p><b>Open an agent.</b> Click the card, or click its Health / Risk / Cost chip to jump straight to that evidence.</p></div>
                <div><span>4</span><p><b>Read the evidence.</b> Each metric shows its value, the threshold it was judged against, the sample size and the data source.</p></div>
              </div>
              <p>Hover over any <span className="inline-i">ⓘ</span> icon on the dashboard for a one-line definition. The <b>Definitions</b> button in the header gives a quick summary; this guide is the full reference.</p>
            </section>

            {/* ------------------------------------------------------------ */}
            <section id="help-layout">
              <h3>Finding your way around</h3>
              <dl className="help-dl">
                <dt>Header</dt>
                <dd>“Data as of” is the time the figures were calculated. The coloured dot shows the data mode: <Pill s="green">Live</Pill> <Pill s="amber">Demo</Pill> <Pill s="red">Error</Pill>. Refresh re-queries immediately.</dd>
                <dt>Reporting period</dt>
                <dd>Last 24 hours, 7, 30 or 90 days. It applies to <i>every</i> number, status and chart on every tab. Charts use hourly points for 24 hours and daily points otherwise.</dd>
                <dt>Near real-time</dt>
                <dd>When ticked, the page re-queries every 5 minutes. Application Insights itself usually lags a few minutes behind the agent, so end-to-end freshness is typically under 10 minutes — well inside the agreed 30-minute tolerance.</dd>
                <dt>Executive Overview</dt>
                <dd>Portfolio headline, auto-written leadership summary, 8 KPI tiles, failed-conversation trend over green/amber/red bands, department breakdown and the list of agents needing action.</dd>
                <dt>Agent Portfolio</dt>
                <dd>Every agent as a card, grouped by Department (or Location, Platform, Environment). Filter by status, environment, department, location, owner, platform and risk tier, or search by name, purpose, owner or ID. Click a group header to collapse it.</dd>
                <dt>Agent detail</dt>
                <dd>Inventory profile at the top; Health / Risk / Cost tabs with the evidence for each metric; activity chart; automatic AI-policy checks; top error codes.</dd>
                <dt>Metric Library</dt>
                <dd>The full list of metrics, formulas, sources and thresholds — the single rulebook behind every status.</dd>
                <dt>Data Checks</dt>
                <dd>What was loaded, from where, and what is missing (e.g. agents seen in telemetry but not in the inventory). Start here when a number looks wrong.</dd>
              </dl>
            </section>

            {/* ------------------------------------------------------------ */}
            <section id="help-status">
              <h3>How statuses work</h3>
              <table className="table help-table">
                <thead><tr><th>Status</th><th>Meaning</th><th>Expected response</th></tr></thead>
                <tbody>
                  {STATUS.map(([s, label, meaning, action]) => (
                    <tr key={s}><td><Pill s={s}>{label}</Pill></td><td>{meaning}</td><td>{action}</td></tr>
                  ))}
                </tbody>
              </table>
              <h4>The roll-up rule: worst result wins</h4>
              <div className="rollup">
                <div><b>Metric</b><span>rated against its own threshold</span></div>
                <ChevronRight size={18} />
                <div><b>Component</b><span>worst metric (Health only)</span></div>
                <ChevronRight size={18} />
                <div><b>Pillar</b><span>worst component / metric</span></div>
                <ChevronRight size={18} />
                <div><b>Agent overall</b><span>worst of Health, Risk, Cost</span></div>
                <ChevronRight size={18} />
                <div><b>Portfolio</b><span>worst agent</span></div>
              </div>
              <p>
                We deliberately do <b>not</b> average. An agent that is 99.9% available but leaking data is not “mostly fine”; averaging would hide exactly the problem
                an executive needs to see. With worst-wins, every red on a summary can be traced to one specific metric in the drill-down.
              </p>
              <h4>Why grey is never green</h4>
              <p>
                If a metric has no data source, or too few events to be meaningful (each metric has a minimum sample, e.g. 10 user messages), it is shown grey and
                <b> ignored</b> in the roll-up. It never counts as a pass. A pillar where every metric is grey is itself grey. This keeps the dashboard honest: a
                quiet or un-instrumented agent cannot look healthy by default.
              </p>
            </section>

            {/* ------------------------------------------------------------ */}
            <section id="help-health">
              <h3>Health metrics</h3>
              <p className="lead">Is the agent up, responsive and completing its work?</p>
              <div className="formula">
                <span className="eyebrow-sm">Operational health</span>
                <div className="formula-row">
                  {['Availability', 'Completion', 'Latency', 'Error / Retry', 'Dependency health'].map((c, i) => (
                    <React.Fragment key={c}>{i > 0 && <span className="plus">+</span>}<span className="term">{c}</span></React.Fragment>
                  ))}
                </div>
                <p>Definition agreed in the dashboard review. Each component takes its worst metric; Health takes the worst component.</p>
              </div>
              <MetricTable library={library} pillar="health" />
              <h4>Things to know</h4>
              <ul>
                <li><b>Latency</b> is measured from a user message to the agent’s next reply in the same conversation, so it includes model, knowledge-search and connector time — what the user actually experiences. Replies slower than {timeout}s count as timeouts.</li>
                <li><b>Completion</b> means the conversation reached the end of a topic without an error. A user who simply walks away mid-topic counts as not completed, which is why the amber band starts at 90% rather than 99%.</li>
                <li><b>Retries</b> and <b>dependency health</b> are not emitted by Copilot Studio; they light up automatically for Foundry / SDK agents that send OpenTelemetry.</li>
              </ul>
            </section>

            {/* ------------------------------------------------------------ */}
            <section id="help-risk">
              <h3>Risk metrics</h3>
              <p className="lead">Is the agent being attacked, producing unsafe content, or doing things it shouldn’t?</p>
              <p>
                Risk is built in two layers, as agreed in the review. <b>Baseline</b> metrics apply to every agent (prompt injection, content safety, data leakage).
                <b> Use-case</b> metrics only apply where they make sense — for example “an HR agent should only call Workday” uses the allowed-connector list held
                for that agent in the AI inventory. Both layers come from the same library, so a rule is written once and reused.
              </p>
              <MetricTable library={library} pillar="risk" />
              <p className="help-note">
                A blocked jailbreak is a <i>successful</i> defence, but it still raises Risk: it tells the owner someone is probing the agent. One or two attempts is
                amber; more is red.
              </p>
            </section>

            {/* ------------------------------------------------------------ */}
            <section id="help-cost">
              <h3>Cost metrics</h3>
              <p className="lead">How many tokens the agent consumes and what that costs against its budget.</p>
              <MetricTable library={library} pillar="cost" />
              <ul>
                <li>Spend = tokens × the configured price per 1,000 input / output tokens. Budget comes from <code>monthlyBudgetUsd</code> in the inventory and is pro-rated to the reporting period.</li>
                <li>Copilot Studio does not publish token usage to Application Insights, so Copilot Studio agents show Cost as grey until a token source (Foundry / PurpleStratus or a gateway) is connected.</li>
              </ul>
            </section>

            {/* ------------------------------------------------------------ */}
            <section id="help-policy">
              <h3>AI policy checks</h3>
              <p>
                These drive the <b>Out of AI policy</b> tile. They are not a manual attestation: each one compares what the telemetry shows with what the AI
                inventory says. An agent fails if any check fails.
              </p>
              {library ? (
                <table className="table help-table">
                  <thead><tr><th>Check</th><th>Rule</th></tr></thead>
                  <tbody>{library.compliance.map((c) => <tr key={c.id}><td><b>{c.name}</b></td><td>{c.definition}</td></tr>)}</tbody>
                </table>
              ) : (
                <p className="help-note">Checks load with the data.</p>
              )}
              <p>The most common real-world failure is an agent that is live in Copilot Studio but was never registered — these are listed by ID on <b>Data Checks</b>.</p>
            </section>

            {/* ------------------------------------------------------------ */}
            <section id="help-tiles">
              <h3>Executive tiles</h3>
              <table className="table help-table">
                <thead><tr><th>Tile</th><th>Definition</th><th>Why it is there</th></tr></thead>
                <tbody>{tiles.map(([t, d, w]) => <tr key={t}><td><b>{t}</b></td><td>{d}</td><td>{w}</td></tr>)}</tbody>
              </table>
              <p>Tiles with a <b>›</b> are clickable and open the Agent Portfolio pre-filtered to the agents behind the number.</p>
            </section>

            {/* ------------------------------------------------------------ */}
            <section id="help-data">
              <h3>Where the data comes from</h3>
              <div className="pipeline">
                <div><b>AI agents</b><span>Copilot Studio, Foundry</span></div>
                <ChevronRight size={18} />
                <div><b>Application Insights</b><span>runtime events, tokens</span></div>
                <ChevronRight size={18} />
                <div><b>Dashboard API</b><span>KQL queries + metric library</span></div>
                <ChevronRight size={18} />
                <div><b>This dashboard</b><span>statuses, tiles, drill-downs</span></div>
              </div>
              <div className="pipeline side-feed">
                <div><b>AI system inventory</b><span>department, owners, purpose, risk tier, approval, budget</span></div>
                <span className="feed-label">joined by agent ID ↗</span>
              </div>
              <dl className="help-dl">
                <dt>Runtime telemetry</dt>
                <dd>Copilot Studio sends conversation events (messages received/sent, topic start/end, errors) to Application Insights. The API reads them with server-side KQL queries; no credentials ever reach the browser.</dd>
                <dt>Agent identity</dt>
                <dd>Each conversation is mapped to one agent using the bot name on its messages, falling back to the topic schema prefix. New agents appear automatically — no code change needed.</dd>
                <dt>Agent profile</dt>
                <dd>Department, owners, purpose, location, risk tier, approval status, production date and budget come from the AI inventory{sources?.inventoryLabel ? ` (currently: ${sources.inventoryLabel})` : ''}. If an agent isn’t registered it still appears, labelled “Unassigned”, and fails the policy check.</dd>
                <dt>Production vs test</dt>
                <dd>Copilot Studio flags test-canvas traffic (DesignMode). Agents with any non-test traffic in the period count as Production.</dd>
                <dt>Freshness</dt>
                <dd>Queried live on every refresh — nothing is cached between refreshes, so every status reflects the latest telemetry in the selected window.</dd>
              </dl>
            </section>

            {/* ------------------------------------------------------------ */}
            <section id="help-live">
              <h3>Live data vs demo data</h3>
              <ul>
                <li>On every load the dashboard tries <b>live telemetry only</b>. Demo data is not even downloaded unless you ask for it.</li>
                <li>If live data cannot be retrieved you see a red banner and <b>no figures</b> — never stale or sample numbers presented as real.</li>
                <li><b>Show demo data</b> loads a realistic synthetic portfolio for walkthroughs. It is marked by an amber banner and a “Demo data” tag in the header, and auto-refresh is paused.</li>
                <li><b>Try live again</b> returns to live mode. If that fails, the screen clears back to the error state.</li>
              </ul>
              {mode && <p className="help-note">You are currently viewing: <b>{mode === 'live' ? 'live telemetry' : mode === 'demo' ? 'demo data' : mode === 'error' ? 'no data (live retrieval failed)' : 'loading'}</b>.</p>}
            </section>

            {/* ------------------------------------------------------------ */}
            <section id="help-why">
              <h3>Why it is designed this way</h3>
              <dl className="help-dl">
                <dt>One view, not separate tabs per topic</dt>
                <dd>Health, Risk and Cost sit side by side on every agent card so an executive never has to hop between governance, security and cost screens to understand one agent.</dd>
                <dt>Grouped by department</dt>
                <dd>Estates grow from tens to hundreds of agents; a flat list stops being readable. Grouping and filters let each business owner find their agents in seconds.</dd>
                <dt>Automatic, not manual</dt>
                <dd>Manually entered statuses go stale and can’t be audited. Every status here can be traced to a query, a threshold and a sample size.</dd>
                <dt>Simple, explainable maths</dt>
                <dd>Fixed thresholds and worst-wins roll-ups can be explained in one sentence to a non-technical audience and challenged metric by metric — unlike a weighted score.</dd>
                <dt>One metric library</dt>
                <dd>Thresholds and definitions live in one place and are reused by every agent, avoiding a separate rule set per agent that becomes impossible to maintain.</dd>
                <dt>Honest about gaps</dt>
                <dd>Metrics that can’t be measured yet are listed and shown grey rather than hidden, so the coverage gap is visible and can be closed deliberately.</dd>
              </dl>
            </section>

            {/* ------------------------------------------------------------ */}
            <section id="help-faq">
              <h3>FAQ and troubleshooting</h3>
              <Faq q="An agent shows “Unassigned” department and no owners.">
                Its telemetry ID has no matching record in the AI inventory. Open <b>Data Checks</b>, copy the ID listed under “Telemetry IDs without an inventory record”, and add it to the inventory record’s <code>id</code> or <code>aliases</code>. It will pick up its profile on the next refresh.
              </Faq>
              <Faq q="Cost is grey for most agents.">
                Expected for Copilot Studio agents — they don’t publish token usage. Cost fills in automatically for agents that emit OpenTelemetry token data (e.g. Foundry), and shows dollars once a price list is configured.
              </Faq>
              <Faq q="An agent is grey even though people are using it.">
                Either its traffic is below the minimum sample for the selected period (try a longer period), or the specific metrics need a source that isn’t connected. The evidence row explains which.
              </Faq>
              <Faq q="Numbers differ from Copilot Studio’s built-in Analytics.">
                Copilot Studio Analytics uses its own session definitions and refresh cycle. This dashboard counts conversations and errors directly from Application Insights events within the selected period, so small differences are normal. Large differences usually mean an agent’s Application Insights connection was added part-way through the period.
              </Faq>
              <Faq q="A new agent isn’t showing up.">
                Check that Application Insights is connected in the agent’s settings in Copilot Studio and that the agent has had at least one conversation in the reporting period. Ingestion can take a few minutes. Registered agents with no traffic still appear as grey “No traffic”.
              </Faq>
              <Faq q="How do I change a threshold or add a metric?">
                Edit <code>api/shared/metrics-registry.js</code>. Thresholds, definitions and sources are defined once there and applied to every agent, tile, chart and this guide on the next deployment.
              </Faq>
              <Faq q="The page says live telemetry could not be retrieved.">
                The API couldn’t query Log Analytics or wasn’t reachable. Typical causes: the workspace ID setting is missing, the API’s managed identity lacks Log Analytics Reader, or the Function is stopped. Use “Show demo data” for a walkthrough in the meantime.
              </Faq>
              <Faq q="Why did an agent go red when nothing changed?">
                Statuses are recalculated on every refresh over a rolling window. A short burst of errors, or a lower volume making each failure weigh more, can tip a rate over a threshold. Switch the reporting period to compare short and long-term behaviour.
              </Faq>
            </section>

            {/* ------------------------------------------------------------ */}
            <section id="help-glossary">
              <h3>Glossary</h3>
              <dl className="help-dl">
                <dt>Agent</dt><dd>An AI assistant built in Copilot Studio or Foundry, identified by a stable ID in telemetry.</dd>
                <dt>Conversation</dt><dd>One session between a user and an agent (one conversation ID).</dd>
                <dt>User turn</dt><dd>A single message from the user to the agent.</dd>
                <dt>Topic</dt><dd>A Copilot Studio conversation flow; reaching the end of a topic is our completion signal.</dd>
                <dt>P95 latency</dt><dd>95% of replies were faster than this value; captures the slow tail users notice, which an average hides.</dd>
                <dt>Threshold</dt><dd>The boundary values that turn a measurement into green, amber or red.</dd>
                <dt>Minimum sample</dt><dd>The fewest events needed before a rate is trusted; below it the metric is grey.</dd>
                <dt>Prompt injection / jailbreak</dt><dd>Attempts to make the agent ignore its instructions, either directly or through content it reads.</dd>
                <dt>AI inventory</dt><dd>The system of record listing each approved AI system, its owners, purpose, risk tier and approval status.</dd>
                <dt>Application Insights / KQL</dt><dd>Azure’s telemetry store for the agents, and the query language used to read it.</dd>
                <dt>Telemetry coverage</dt><dd>Share of applicable metrics that currently have enough data to produce a status.</dd>
              </dl>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small round "?" button used in the header and next to section titles. */
export function HelpButton({ onClick, label = 'How this dashboard works' }) {
  return (
    <button className="help-btn" onClick={onClick} type="button" title={label} aria-label={label}>
      <HelpCircle size={17} />
    </button>
  );
}

