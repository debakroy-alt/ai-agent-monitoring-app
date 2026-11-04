/**
 * Metrics library — single source of truth for every metric on the dashboard.
 *
 * A common library maintained once; each agent "picks" the metrics that apply
 * to it (by platform / tags). Change a threshold here and every agent, tile,
 * chart and the in-app guide picks it up. Nothing here is entered per agent by
 * hand; values are calculated from telemetry at request time.
 *
 * availability:
 *   'live'          – calculated today from Copilot Studio -> Application Insights
 *   'conditional'   – calculated only when the source is connected (e.g. token telemetry)
 *   'not-available' – defined, but no automatic source exists yet (shown grey, never green)
 *
 * thresholds:
 *   higherIsBetter: true  -> green if value >= green, amber if value >= amber, else red
 *   higherIsBetter: false -> green if value <= green, amber if value <= amber, else red
 *
 * Rationale / references for thresholds are kept next to each metric (`basis`)
 * and shown in the Metric Library so they can be challenged by the business.
 */

const PILLARS = {
  health: {
    name: 'Health',
    question: 'Is the agent working?',
    definition:
      'Operational reliability: is the agent answering, finishing the job, responding quickly and are its tools working. ' +
      'Health = the worst measured component (one red component makes Health red).',
  },
  risk: {
    name: 'Risk',
    question: 'Is the agent behaving safely?',
    definition:
      'Safety and security signals raised by the platform guardrails (jailbreaks, prompt attacks hidden in documents, harmful content, ' +
      'data-policy blocks). Baseline signals apply to every agent; use-case rules (e.g. an HR agent may only call Workday) are added per agent.',
  },
  cost: {
    name: 'Cost',
    question: 'Is the agent affordable?',
    definition:
      'Estimated consumption and spend in the period, compared with the agent budget held in the AI inventory. ' +
      'Copilot Studio agents are estimated from Copilot Credits; Foundry agents from token usage × model price.',
  },
};

// Operational Health = Availability + Completion + Latency + Error/Retry + Dependency Health
const HEALTH_COMPONENTS = {
  availability: 'Availability',
  completion: 'Completion',
  latency: 'Speed',
  errors: 'Errors',
  dependency: 'Tools & connectors',
};

const METRICS = [
  // ---------------------------------------------------------------- HEALTH
  {
    id: 'agent_availability',
    pillar: 'health',
    component: 'availability',
    name: 'Agent availability',
    plain: 'How often users got a reply',
    unit: '%',
    definition: 'Share of user messages that received a reply from the agent.',
    formula: 'answered user messages ÷ user messages × 100',
    source: 'Application Insights · AppEvents (BotMessageReceived → BotMessageSend)',
    thresholds: { higherIsBetter: true, green: 99, amber: 95 },
    basis: 'Common SLO practice for interactive services: ≥99% green; below 95% means 1 in 20 questions goes unanswered.',
    minSample: 10,
    sampleLabel: 'user messages',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'task_completion',
    pillar: 'health',
    component: 'completion',
    name: 'Conversations resolved',
    plain: 'Conversations finished without an error or hand-off',
    unit: '%',
    definition:
      'Engaged conversations where the agent replied, no runtime error occurred and the conversation was not escalated or sent to the fallback topic.',
    formula: 'engaged conversations answered with no error, escalation or fallback ÷ engaged conversations × 100',
    source: 'Application Insights · AppEvents (BotMessageSend, OnErrorLog, Escalate / Fallback topics)',
    thresholds: { higherIsBetter: true, green: 85, amber: 70 },
    basis:
      'Users can leave mid-topic and some questions legitimately need a human, so 100% is not realistic. 85% / 70% are starting bands to be tuned per use case.',
    minSample: 5,
    sampleLabel: 'engaged conversations',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'p95_latency',
    pillar: 'health',
    component: 'latency',
    name: 'Response time (95th percentile)',
    plain: '95% of replies arrived faster than this',
    unit: 's',
    definition: 'Time between a user message and the agent’s next reply, at the 95th percentile (the slow tail users notice).',
    formula: 'percentile(reply time − message time, 95)',
    source: 'Application Insights · AppEvents (BotMessageReceived → BotMessageSend)',
    thresholds: { higherIsBetter: false, green: 10, amber: 20 },
    basis:
      'Nielsen’s response-time limits: ~10 seconds is the limit for keeping a user’s attention on the dialogue. Generative answers with knowledge search typically take several seconds.',
    minSample: 10,
    sampleLabel: 'answered messages',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'timeout_rate',
    pillar: 'health',
    component: 'latency',
    name: 'Very slow replies',
    plain: 'Replies that took longer than the slow-reply limit',
    unit: '%',
    definition: 'Share of answered user messages where the reply took longer than the slow-reply limit (default 30 seconds).',
    formula: 'answered messages slower than SLOW_REPLY_SECONDS ÷ answered messages × 100',
    source: 'Application Insights · AppEvents',
    thresholds: { higherIsBetter: false, green: 2, amber: 5 },
    basis: 'A reply that takes 3× the 10-second attention limit is likely to be abandoned.',
    minSample: 10,
    sampleLabel: 'answered messages',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'failed_execution_rate',
    pillar: 'health',
    component: 'errors',
    name: 'Conversations with errors',
    plain: 'Conversations where something broke',
    unit: '%',
    definition:
      'Share of engaged conversations that recorded at least one runtime error. Guardrail blocks (jailbreak, harmful content, data policy) are excluded here and reported under Risk.',
    formula: 'engaged conversations with a non-safety OnErrorLog ÷ engaged conversations × 100',
    source: 'Application Insights · AppEvents (OnErrorLog)',
    thresholds: { higherIsBetter: false, green: 2, amber: 5 },
    basis: 'Mirrors a 98% success objective; above 5% means 1 in 20 conversations is visibly broken.',
    minSample: 5,
    sampleLabel: 'engaged conversations',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'dependency_failure_rate',
    pillar: 'health',
    component: 'dependency',
    name: 'Tool & connector failures',
    plain: 'Conversations where a flow, connector or tool failed',
    unit: '%',
    definition:
      'Share of engaged conversations where an agent flow, connector, AI tool, knowledge search or connected agent failed (e.g. FlowActionTimedOut after the 100-second agent-flow limit, ConnectorRequestFailure).',
    formula: 'engaged conversations with a tool/connector error code ÷ engaged conversations × 100',
    source: 'Application Insights · AppEvents (OnErrorLog error codes) · Foundry: AppDependencies success flag',
    thresholds: { higherIsBetter: false, green: 1, amber: 3 },
    basis: 'Tool failures are a subset of all errors, so the bands are tighter than the overall error rate.',
    minSample: 5,
    sampleLabel: 'engaged conversations',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'avg_retries',
    pillar: 'health',
    component: 'errors',
    name: 'Retries per run',
    plain: 'How often the agent had to retry',
    unit: '',
    definition: 'Average number of automatic retries per agent run.',
    formula: 'retry events ÷ executions',
    source: 'Not emitted by Copilot Studio. Available from Foundry / SDK agents instrumented with OpenTelemetry.',
    thresholds: { higherIsBetter: false, green: 0.2, amber: 0.5 },
    minSample: 5,
    availability: 'not-available',
    appliesTo: ['all'],
  },

  // ------------------------------------------------------------------ RISK
  {
    id: 'prompt_injection_attempts',
    pillar: 'risk',
    component: 'security',
    name: 'Jailbreak attempts blocked',
    plain: 'Users trying to make the agent ignore its rules',
    unit: 'per1k',
    definition:
      'Messages blocked by the platform guardrails because the user tried to override the agent’s instructions (jailbreak / direct prompt injection, error sub-code OpenAIJailBreak).',
    formula: 'blocked jailbreak attempts ÷ engaged conversations × 1,000',
    source: 'Application Insights · AppEvents (OnErrorLog: ContentFiltered / OpenAIJailBreak)',
    thresholds: { higherIsBetter: false, green: 1, amber: 5 },
    basis:
      'Rated per 1,000 conversations so a busy agent is not penalised for volume. A blocked attempt is a successful defence, but repeated probing needs an owner’s attention.',
    minSample: 20,
    sampleLabel: 'engaged conversations',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'indirect_attacks',
    pillar: 'risk',
    component: 'security',
    name: 'Attacks hidden in documents',
    plain: 'Malicious instructions found inside knowledge sources',
    unit: 'count',
    definition:
      'Responses blocked because a document or web page the agent read contained an indirect prompt attack (error sub-code OpenAIndirectAttack). Points to a knowledge source that needs review.',
    formula: 'count of OnErrorLog with OpenAIndirectAttack',
    source: 'Application Insights · AppEvents (OnErrorLog: ContentFiltered / OpenAIndirectAttack)',
    thresholds: { higherIsBetter: false, green: 0, amber: 2 },
    basis: 'Any occurrence means grounded content is unsafe or a false positive that blocks users; both need the owner to review the source.',
    minSample: 1,
    sampleLabel: 'engaged conversations',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'content_safety_blocks',
    pillar: 'risk',
    component: 'security',
    name: 'Harmful content blocked',
    plain: 'Conversations where hate, violence, sexual or self-harm content was filtered',
    unit: '%',
    definition:
      'Share of engaged conversations where the Responsible AI filter blocked harmful content (OpenAIHate, OpenAIViolence, OpenAISexual, OpenAISelfHarm or an unclassified ContentFiltered).',
    formula: 'conversations with a harmful-content block ÷ engaged conversations × 100',
    source: 'Application Insights · AppEvents (OnErrorLog: ContentFiltered sub-codes)',
    thresholds: { higherIsBetter: false, green: 1, amber: 3 },
    basis: 'Occasional false positives are normal; a sustained rate above 1–3% suggests misuse or an over-sensitive topic.',
    minSample: 5,
    sampleLabel: 'engaged conversations',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'dlp_violations',
    pillar: 'risk',
    component: 'data',
    name: 'Data policy blocks',
    plain: 'Actions stopped by a Power Platform data (DLP) policy',
    unit: 'count',
    definition: 'Times the agent tried to use a connector or action that a data loss prevention policy blocks (error code DataLossPreventionViolation).',
    formula: 'count of OnErrorLog with DataLossPreventionViolation',
    source: 'Application Insights · AppEvents (OnErrorLog)',
    thresholds: { higherIsBetter: false, green: 0, amber: 2 },
    basis: 'The policy worked, but the agent design is attempting something the organisation does not allow.',
    minSample: 1,
    sampleLabel: 'engaged conversations',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'sensitive_data_exposure',
    pillar: 'risk',
    component: 'data',
    name: 'Sensitive data in conversations',
    plain: 'Personal, card or credential data seen in prompts or answers',
    unit: 'count',
    definition: 'Prompts or responses containing sensitive information types (PII, card data, credentials).',
    formula: 'count of sensitive-information-type matches in agent interactions',
    source: 'Microsoft Purview DSPM for AI (not yet connected)',
    thresholds: { higherIsBetter: false, green: 0, amber: 2 },
    availability: 'not-available',
    appliesTo: ['all'],
  },
  {
    id: 'unapproved_tool_calls',
    pillar: 'risk',
    component: 'behaviour',
    name: 'Unapproved tool calls',
    plain: 'Calls to systems not on the agent’s allowed list',
    unit: 'count',
    definition: 'Calls to connectors or APIs that are not on the agent’s allowed list in the AI inventory (e.g. an HR agent calling Salesforce).',
    formula: 'tool calls where target ∉ inventory.allowedConnectors',
    source: 'Tool-call telemetry (OpenTelemetry tracing) + AI inventory allowedConnectors',
    thresholds: { higherIsBetter: false, green: 0, amber: 0 },
    availability: 'not-available',
    appliesTo: ['use-case'],
  },

  // ------------------------------------------------------------------ COST
  {
    id: 'copilot_credits',
    pillar: 'cost',
    component: 'usage',
    name: 'Copilot Credits used (estimate)',
    plain: 'Estimated Copilot Studio billing units consumed',
    unit: 'credits',
    definition:
      'Estimated Copilot Credits: answered user messages × credits per response for the agent’s design (Microsoft rate card: classic answer 1, generative answer 2, agent action 5, tenant graph grounding 10).',
    formula: 'answered messages × inventory.creditsPerResponse (default 2)',
    source: 'Application Insights turns × Copilot Studio billing rate card. Authoritative figure: Power Platform admin center → Copilot Credit consumption.',
    thresholds: null,
    availability: 'live',
    appliesTo: ['copilot-studio'],
  },
  {
    id: 'token_consumption',
    pillar: 'cost',
    component: 'usage',
    name: 'Tokens used',
    plain: 'Model input + output tokens',
    unit: 'tokens',
    definition: 'Input + output tokens consumed by model calls made by the agent.',
    formula: 'sum(gen_ai.usage.input_tokens + gen_ai.usage.output_tokens)',
    source: 'Application Insights · AppDependencies (OpenTelemetry gen_ai.* attributes; Foundry / SDK agents)',
    thresholds: null,
    availability: 'conditional',
    appliesTo: ['foundry'],
  },
  {
    id: 'spend',
    pillar: 'cost',
    component: 'spend',
    name: 'Spend vs budget',
    plain: 'Estimated spend as a share of the budget for this period',
    unit: '%',
    definition: 'Estimated spend in the period as a share of the agent’s monthly budget, pro-rated to the reporting period.',
    formula: 'estimated spend ÷ (monthly budget × days ÷ 30) × 100',
    source: 'Estimated spend ÷ inventory.monthlyBudgetUsd',
    thresholds: { higherIsBetter: false, green: 80, amber: 100 },
    basis: 'Above 80% of the pro-rated budget gives early warning; above 100% the agent is over budget.',
    availability: 'conditional',
    appliesTo: ['all'],
  },
  {
    id: 'cost_per_conversation',
    pillar: 'cost',
    component: 'unit',
    name: 'Cost per conversation',
    plain: 'Average estimated cost of one conversation',
    unit: 'usd',
    definition: 'Estimated spend divided by engaged conversations. Useful for comparing agents and building business cases.',
    formula: 'estimated spend ÷ engaged conversations',
    source: 'Derived',
    thresholds: null,
    availability: 'conditional',
    appliesTo: ['all'],
  },
];

// Compliance checks are automatic: they compare telemetry with the AI inventory.
const COMPLIANCE_CHECKS = [
  { id: 'registered', name: 'Registered in AI inventory', definition: 'Agent seen in telemetry has a matching AI inventory record.' },
  { id: 'owners', name: 'Business and technical owner assigned', definition: 'Both owner fields are populated (placeholders do not count).' },
  { id: 'risk_tier', name: 'Risk tier assigned', definition: 'Inventory record carries a risk tier (Low / Medium / High).' },
  { id: 'approved', name: 'Approved before production use', definition: 'Production traffic only from agents whose inventory status is "Approved".' },
  { id: 'telemetry', name: 'Sending telemetry', definition: 'Agent sent runtime telemetry within the reporting period.' },
];

const SEVERITY = { unknown: 0, green: 1, amber: 2, red: 3 };

function worstStatus(...statuses) {
  return statuses.flat().reduce((w, s) => (SEVERITY[s] > SEVERITY[w] ? s : w), 'unknown');
}

function rate(metric, value) {
  const t = metric.thresholds;
  if (!t || value === null || value === undefined || Number.isNaN(value)) return 'unknown';
  if (t.higherIsBetter) return value >= t.green ? 'green' : value >= t.amber ? 'amber' : 'red';
  return value <= t.green ? 'green' : value <= t.amber ? 'amber' : 'red';
}

const UNIT_SUFFIX = { '%': '%', s: 's', per1k: ' per 1k' };

function thresholdText(metric) {
  const t = metric.thresholds;
  if (!t) return 'For information (no rating)';
  const u = UNIT_SUFFIX[metric.unit] || '';
  if (t.higherIsBetter) return `Healthy ≥ ${t.green}${u} · Watch ≥ ${t.amber}${u} · Action below`;
  if (t.green === t.amber) return `Healthy ≤ ${t.green}${u} · Action above`;
  return `Healthy ≤ ${t.green}${u} · Watch ≤ ${t.amber}${u} · Action above`;
}

function formatValue(value, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (unit === '%') return `${Math.round(value * 10) / 10}%`;
  if (unit === 's') return `${Math.round(value * 10) / 10}s`;
  if (unit === 'tokens' || unit === 'credits' || unit === 'count') return Math.round(value).toLocaleString('en-US');
  if (unit === 'usd') return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 3 : 2 })}`;
  if (unit === 'per1k') return `${Math.round(value * 10) / 10} per 1k`;
  return String(Math.round(value * 100) / 100);
}

/** Applies a metric to an agent and returns the evidence row used by the UI. */
function evaluate(metricId, { value = null, sample = null, display = null, note = null, available = true, status = null } = {}) {
  const metric = METRICS.find((m) => m.id === metricId);
  if (!metric) throw new Error(`Unknown metric ${metricId}`);
  const base = {
    id: metric.id,
    name: metric.name,
    plain: metric.plain,
    pillar: metric.pillar,
    component: metric.component,
    description: metric.definition,
    threshold: thresholdText(metric),
    source: metric.source,
    informational: !metric.thresholds,
  };
  if (metric.availability === 'not-available' || !available) {
    return { ...base, measured: false, value: 'Not available', status: 'unknown', why: note || 'No automatic data source connected yet' };
  }
  if (metric.minSample && sample !== null && sample < metric.minSample) {
    return {
      ...base,
      measured: false,
      value: sample === 0 ? '—' : display ?? formatValue(value, metric.unit),
      status: 'unknown',
      why: `Too little activity to judge (${sample} ${metric.sampleLabel || 'events'}; need ${metric.minSample})`,
    };
  }
  return {
    ...base,
    measured: true,
    rawValue: value,
    value: display ?? formatValue(value, metric.unit),
    status: status || rate(metric, value),
    why: note || (sample !== null ? `Based on ${Number(sample).toLocaleString('en-US')} ${metric.sampleLabel || 'events'}` : ''),
  };
}

/** Public, UI-friendly version of the library (served with every payload). */
function publicLibrary() {
  return {
    pillars: PILLARS,
    healthComponents: HEALTH_COMPONENTS,
    metrics: METRICS.map((m) => ({
      id: m.id,
      pillar: m.pillar,
      component: m.component,
      name: m.name,
      plain: m.plain,
      definition: m.definition,
      formula: m.formula,
      source: m.source,
      threshold: thresholdText(m),
      thresholds: m.thresholds,
      unit: m.unit,
      basis: m.basis || null,
      availability: m.availability,
      appliesTo: m.appliesTo,
      minSample: m.minSample || null,
    })),
    compliance: COMPLIANCE_CHECKS,
  };
}

module.exports = {
  METRICS,
  PILLARS,
  HEALTH_COMPONENTS,
  COMPLIANCE_CHECKS,
  evaluate,
  worstStatus,
  formatValue,
  publicLibrary,
};
