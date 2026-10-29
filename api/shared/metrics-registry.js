/**
 * Metrics library — single source of truth for every metric on the dashboard.
 *
 * Derek's ask: a common library that is maintained once, where each agent
 * "picks" the metrics that apply to it. Change a threshold here and every
 * agent, tile and drill-down picks it up. Nothing here is entered per agent
 * by hand; values are calculated from telemetry at request time.
 *
 * availability:
 *   'live'          – calculated today from Copilot Studio -> Application Insights
 *   'conditional'   – calculated only when the source is connected (e.g. token telemetry)
 *   'not-available' – defined, but no automatic source exists yet (shown grey, never green)
 *
 * thresholds:
 *   higherIsBetter: true  -> green if value >= green, amber if value >= amber, else red
 *   higherIsBetter: false -> green if value <= green, amber if value <= amber, else red
 */

const PILLARS = {
  health: {
    name: 'Health',
    definition:
      'Operational reliability: availability, completion, latency, errors/retries and dependency health. ' +
      'Health status = the worst measured component (one red component makes Health red).',
  },
  risk: {
    name: 'Risk',
    definition:
      'Common runtime risk signals that apply to every agent (baseline). Use-case specific rules ' +
      '(e.g. an HR agent may only call Workday) are added per agent through "appliesTo" tags.',
  },
  cost: {
    name: 'Cost',
    definition: 'Token consumption and spend, compared with the agent budget held in the AI inventory.',
  },
};

// Health components follow Derek's formula:
// Operational Health = Availability + Completion + Latency + Error/Retry + Dependency Health
const HEALTH_COMPONENTS = {
  availability: 'Availability',
  completion: 'Completion',
  latency: 'Latency',
  errors: 'Error / Retry',
  dependency: 'Dependency health',
};

const METRICS = [
  // ---------------------------------------------------------------- HEALTH
  {
    id: 'agent_availability',
    pillar: 'health',
    component: 'availability',
    name: 'Agent availability',
    unit: '%',
    definition: 'Share of user messages that received an agent reply.',
    formula: 'answered user turns ÷ user turns × 100',
    source: 'Application Insights · AppEvents (BotMessageReceived → BotMessageSend)',
    thresholds: { higherIsBetter: true, green: 99, amber: 95 },
    minSample: 10,
    sampleLabel: 'user turns',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'task_completion',
    pillar: 'health',
    component: 'completion',
    name: 'Successful task completion',
    unit: '%',
    definition: 'Conversations that reached the end of a topic without recording an error.',
    formula: 'conversations with TopicEnd and no OnErrorLog ÷ conversations × 100',
    source: 'Application Insights · AppEvents (TopicEnd, OnErrorLog)',
    thresholds: { higherIsBetter: true, green: 90, amber: 75 },
    minSample: 5,
    sampleLabel: 'conversations',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'p95_latency',
    pillar: 'health',
    component: 'latency',
    name: 'P95 end-to-end latency',
    unit: 's',
    definition: '95th percentile time between a user message and the next agent reply.',
    formula: 'percentile(reply time − message time, 95)',
    source: 'Application Insights · AppEvents (BotMessageReceived → BotMessageSend)',
    thresholds: { higherIsBetter: false, green: 10, amber: 20 },
    minSample: 10,
    sampleLabel: 'answered turns',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'timeout_rate',
    pillar: 'health',
    component: 'latency',
    name: 'Timeout rate',
    unit: '%',
    definition: 'Share of answered user messages where the reply took longer than the timeout limit.',
    formula: 'answered turns slower than TIMEOUT_SECONDS ÷ answered turns × 100',
    source: 'Application Insights · AppEvents',
    thresholds: { higherIsBetter: false, green: 2, amber: 5 },
    minSample: 10,
    sampleLabel: 'answered turns',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'failed_execution_rate',
    pillar: 'health',
    component: 'errors',
    name: 'Failed execution rate',
    unit: '%',
    definition: 'Share of conversations that recorded at least one runtime error.',
    formula: 'conversations with OnErrorLog ÷ conversations × 100',
    source: 'Application Insights · AppEvents (OnErrorLog)',
    thresholds: { higherIsBetter: false, green: 2, amber: 5 },
    minSample: 5,
    sampleLabel: 'conversations',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'avg_retries',
    pillar: 'health',
    component: 'errors',
    name: 'Average retries per execution',
    unit: '',
    definition: 'Average number of automatic retries per agent run.',
    formula: 'retry events ÷ executions',
    source: 'Not emitted by Copilot Studio. Available from Foundry / SDK agents instrumented with OpenTelemetry.',
    thresholds: { higherIsBetter: false, green: 0.2, amber: 0.5 },
    minSample: 5,
    availability: 'not-available',
    appliesTo: ['all'],
  },
  {
    id: 'dependency_availability',
    pillar: 'health',
    component: 'dependency',
    name: 'Dependency / API availability',
    unit: '%',
    definition: 'Share of connector, flow and API calls made by the agent that succeeded.',
    formula: 'successful dependency calls ÷ dependency calls × 100',
    source: 'Application Insights · AppDependencies (requires SDK/OpenTelemetry instrumentation; Copilot Studio does not emit these)',
    thresholds: { higherIsBetter: true, green: 99, amber: 95 },
    minSample: 10,
    sampleLabel: 'dependency calls',
    availability: 'conditional',
    appliesTo: ['all'],
  },

  // ------------------------------------------------------------------ RISK
  {
    id: 'prompt_injection_attempts',
    pillar: 'risk',
    component: 'security',
    name: 'Prompt injection / jailbreak attempts',
    unit: '',
    definition: 'Messages blocked by platform guardrails as jailbreak or indirect prompt-injection attempts.',
    formula: 'count of OnErrorLog where error code contains Jailbreak / IndirectAttack',
    source: 'Application Insights · AppEvents (OnErrorLog.ErrorCodeText)',
    thresholds: { higherIsBetter: false, green: 0, amber: 2 },
    minSample: 1,
    sampleLabel: 'conversations',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'content_safety_blocks',
    pillar: 'risk',
    component: 'security',
    name: 'Content safety blocks',
    unit: '%',
    definition: 'Share of conversations where harmful content (hate, violence, sexual, self-harm) was filtered.',
    formula: 'conversations with content-filter error ÷ conversations × 100',
    source: 'Application Insights · AppEvents (OnErrorLog.ErrorCodeText)',
    thresholds: { higherIsBetter: false, green: 1, amber: 3 },
    minSample: 5,
    sampleLabel: 'conversations',
    availability: 'live',
    appliesTo: ['all'],
  },
  {
    id: 'sensitive_data_exposure',
    pillar: 'risk',
    component: 'data',
    name: 'Sensitive data exposure',
    unit: '',
    definition: 'Prompts or responses containing sensitive information types (PII, card data, credentials).',
    formula: 'count of DLP / sensitive-info matches in agent interactions',
    source: 'Microsoft Purview DSPM for AI (not yet connected)',
    thresholds: { higherIsBetter: false, green: 0, amber: 2 },
    availability: 'not-available',
    appliesTo: ['all'],
  },
  {
    id: 'unapproved_tool_calls',
    pillar: 'risk',
    component: 'behaviour',
    name: 'Unapproved tool / API calls',
    unit: '',
    definition: 'Calls to connectors or APIs that are not on the agent’s allowed list in the AI inventory (e.g. an HR agent calling Salesforce).',
    formula: 'dependency calls where target ∉ inventory.allowedConnectors',
    source: 'AppDependencies + AI inventory allowedConnectors (use-case specific)',
    thresholds: { higherIsBetter: false, green: 0, amber: 0 },
    availability: 'not-available',
    appliesTo: ['use-case'],
  },

  // ------------------------------------------------------------------ COST
  {
    id: 'token_consumption',
    pillar: 'cost',
    component: 'usage',
    name: 'Token consumption',
    unit: 'tokens',
    definition: 'Input + output tokens consumed by model calls made by the agent.',
    formula: 'sum(gen_ai.usage.input_tokens + gen_ai.usage.output_tokens)',
    source: 'Application Insights · AppDependencies (OpenTelemetry gen_ai.* attributes; Foundry agents)',
    thresholds: null,
    availability: 'conditional',
    appliesTo: ['all'],
  },
  {
    id: 'spend',
    pillar: 'cost',
    component: 'spend',
    name: 'Spend vs budget',
    unit: '%',
    definition: 'Estimated spend in the period as a share of the agent’s pro-rated monthly budget.',
    formula: '(input tokens × input price + output tokens × output price) ÷ (monthly budget × days ÷ 30) × 100',
    source: 'Token telemetry × price list (env) ÷ inventory.monthlyBudgetUsd',
    thresholds: { higherIsBetter: false, green: 80, amber: 100 },
    availability: 'conditional',
    appliesTo: ['all'],
  },
];

// Compliance checks are automatic: they compare telemetry with the AI inventory.
const COMPLIANCE_CHECKS = [
  { id: 'registered', name: 'Registered in AI inventory', definition: 'Agent seen in telemetry has a matching AI inventory record.' },
  { id: 'owners', name: 'Business and technical owner assigned', definition: 'Both owner fields are populated in the inventory.' },
  { id: 'risk_tier', name: 'Risk tier assigned', definition: 'Inventory record carries a risk tier (Low / Medium / High).' },
  { id: 'approved', name: 'Governance approval', definition: 'Production traffic only from agents whose inventory status is "Approved".' },
  { id: 'telemetry', name: 'Telemetry connected', definition: 'Agent sent runtime telemetry within the reporting period.' },
];

const SEVERITY = { unknown: 0, green: 1, amber: 2, red: 3 };

function worstStatus(...statuses) {
  return statuses.flat().reduce((w, s) => (SEVERITY[s] > SEVERITY[w] ? s : w), 'unknown');
}

function rate(statusFor, value) {
  const t = statusFor.thresholds;
  if (!t || value === null || value === undefined || Number.isNaN(value)) return 'unknown';
  if (t.higherIsBetter) return value >= t.green ? 'green' : value >= t.amber ? 'amber' : 'red';
  return value <= t.green ? 'green' : value <= t.amber ? 'amber' : 'red';
}

function thresholdText(metric) {
  const t = metric.thresholds;
  if (!t) return 'Informational';
  const u = metric.unit === '%' ? '%' : metric.unit === 's' ? 's' : '';
  if (t.higherIsBetter) return `Green ≥ ${t.green}${u} · Amber ≥ ${t.amber}${u} · Red below`;
  if (t.green === t.amber) return `Green ≤ ${t.green}${u} · Red above`;
  return `Green ≤ ${t.green}${u} · Amber ≤ ${t.amber}${u} · Red above`;
}

/** Applies a metric to an agent and returns the evidence row used by the UI. */
function evaluate(metricId, { value = null, sample = null, display = null, note = null, available = true } = {}) {
  const metric = METRICS.find((m) => m.id === metricId);
  if (!metric) throw new Error(`Unknown metric ${metricId}`);
  const base = {
    id: metric.id,
    name: metric.name,
    pillar: metric.pillar,
    component: metric.component,
    description: metric.definition,
    threshold: thresholdText(metric),
    source: metric.source,
  };
  if (metric.availability === 'not-available' || !available) {
    return { ...base, value: 'Not available', status: 'unknown', why: note || 'No automatic data source connected yet' };
  }
  if (metric.minSample && sample !== null && sample < metric.minSample) {
    return {
      ...base,
      value: display ?? formatValue(value, metric.unit),
      status: 'unknown',
      why: `Insufficient sample (${sample} ${metric.sampleLabel || 'events'}; need ${metric.minSample})`,
    };
  }
  return {
    ...base,
    rawValue: value,
    value: display ?? formatValue(value, metric.unit),
    status: rate(metric, value),
    why: note || (sample !== null ? `Based on ${Number(sample).toLocaleString('en-US')} ${metric.sampleLabel || 'events'}` : ''),
  };
}

function formatValue(value, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (unit === '%') return `${Math.round(value * 10) / 10}%`;
  if (unit === 's') return `${Math.round(value * 10) / 10}s`;
  if (unit === 'tokens') return Number(value).toLocaleString('en-US');
  return String(Math.round(value * 100) / 100);
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
      definition: m.definition,
      formula: m.formula,
      source: m.source,
      threshold: thresholdText(m),
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
  publicLibrary,
};
