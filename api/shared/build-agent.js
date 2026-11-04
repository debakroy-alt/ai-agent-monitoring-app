/**
 * Turns aggregated telemetry rows + an inventory record into the agent object
 * the dashboard renders. Shared by the live API (api/agents) and the demo
 * generator (tools/gen-demo.cjs) so demo data always follows the same rules.
 */
const { evaluate, worstStatus, COMPLIANCE_CHECKS } = require('./metrics-registry');

const DEFAULT_CONFIG = {
  slowReplySeconds: 30,
  creditPriceUsd: 0.01, // Copilot Studio pay-as-you-go: $0.01 per Copilot Credit
  defaultCreditsPerResponse: 2, // generative answer rate
  modelPrices: {},
};

/**
 * Default model prices, USD per 1M tokens (Azure OpenAI / Foundry, Global Standard).
 * Prices change often — override with MODEL_PRICES_JSON, e.g.
 *   {"gpt-4o":{"in":2.5,"out":10},"gpt-4.1-mini":{"in":0.4,"out":1.6}}
 * Longest matching prefix wins, so "gpt-4o-mini-2024-07-18" matches "gpt-4o-mini".
 */
const DEFAULT_MODEL_PRICES = {
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4 },
  'gpt-5': { in: 1.25, out: 10 },
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
};

function priceFor(model, prices) {
  const m = String(model || '').toLowerCase();
  const keys = Object.keys(prices).filter((k) => m.startsWith(k.toLowerCase())).sort((a, b) => b.length - a.length);
  return keys.length ? prices[keys[0]] : null;
}

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const pct = (n, d) => (d > 0 ? (100 * n) / d : null);

function daysSince(dateString, now) {
  if (!dateString) return null;
  const t = new Date(dateString).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 86400000));
}

function detectPlatform(inv, costRows) {
  if (inv?.platform) return inv.platform;
  return costRows?.length ? 'Azure AI Foundry' : 'Microsoft Copilot Studio';
}

function buildAgent({ key, row = {}, turns = null, series = [], costRows = [], inv = null, days, now = Date.now(), config = {} }) {
  const cfg = { ...DEFAULT_CONFIG, ...config, modelPrices: { ...DEFAULT_MODEL_PRICES, ...(config.modelPrices || {}) } };
  const conversations = num(row.Conversations);
  const engaged = num(row.Engaged);
  const userTurns = num(turns?.UserTurns);
  const answered = num(turns?.AnsweredTurns);
  const platform = detectPlatform(inv, costRows);
  const isFoundry = /foundry|sdk|azure ai/i.test(platform);
  const periodText = days === 1 ? 'the last 24 hours' : `the last ${days} days`;

  // HEALTH ------------------------------------------------------------
  const modelCalls = costRows.reduce((s, r) => s + num(r.ModelCalls), 0);
  const failedCalls = costRows.reduce((s, r) => s + num(r.FailedCalls), 0);
  const depFailed = num(row.DependencyFailed);
  const health = [
    evaluate('agent_availability', { value: pct(answered, userTurns), sample: userTurns,
      note: `${(userTurns - answered).toLocaleString('en-US')} of ${userTurns.toLocaleString('en-US')} user messages got no reply` }),
    evaluate('task_completion', { value: pct(num(row.Resolved), engaged), sample: engaged,
      note: `${num(row.Resolved).toLocaleString('en-US')} of ${engaged.toLocaleString('en-US')} engaged conversations resolved · ${num(row.Escalated)} escalated or fell back` }),
    evaluate('p95_latency', { value: turns?.P95LatencySec ?? null, sample: answered,
      note: turns?.P50LatencySec != null ? `Typical (median) reply ${Math.round(turns.P50LatencySec * 10) / 10}s · ${answered.toLocaleString('en-US')} answered messages` : null }),
    evaluate('timeout_rate', { value: pct(num(turns?.SlowTurns), answered), sample: answered,
      note: `${num(turns?.SlowTurns)} replies slower than ${cfg.slowReplySeconds}s` }),
    evaluate('failed_execution_rate', { value: pct(num(row.HealthFailed), engaged), sample: engaged,
      note: `${num(row.HealthFailed)} of ${engaged.toLocaleString('en-US')} engaged conversations recorded an error` }),
    modelCalls > 0 && engaged === 0
      ? evaluate('dependency_failure_rate', { value: pct(failedCalls, modelCalls), sample: modelCalls,
          note: `${failedCalls} of ${modelCalls} model calls failed` })
      : evaluate('dependency_failure_rate', { value: pct(depFailed, engaged), sample: engaged,
          note: `${depFailed} conversation(s) hit a flow, connector or tool failure` }),
    evaluate('avg_retries', {}),
  ];

  // RISK --------------------------------------------------------------
  const jail = num(row.Jailbreaks);
  const indirect = num(row.IndirectAttacks);
  const harmful = num(row.HarmfulConversations);
  const dlp = num(row.DlpBlocks);
  const per1k = engaged > 0 ? (1000 * jail) / engaged : null;
  const riskMetrics = [
    evaluate('prompt_injection_attempts', { value: per1k, sample: engaged,
      display: `${jail} blocked`, note: `${jail} attempt(s) in ${periodText} = ${per1k === null ? '—' : Math.round(per1k * 10) / 10} per 1,000 conversations` }),
    evaluate('indirect_attacks', { value: indirect, sample: engaged,
      note: indirect ? 'Review the knowledge sources this agent reads' : `None in ${periodText}` }),
    evaluate('content_safety_blocks', { value: pct(harmful, engaged), sample: engaged,
      note: `${harmful} conversation(s) filtered` }),
    evaluate('dlp_violations', { value: dlp, sample: engaged, note: dlp ? 'Agent attempted actions blocked by a DLP policy' : `None in ${periodText}` }),
    evaluate('sensitive_data_exposure', { note: 'Requires Microsoft Purview DSPM for AI connection' }),
    evaluate('unapproved_tool_calls', {
      note: inv?.allowedConnectors?.length
        ? `Allowed list defined (${inv.allowedConnectors.join(', ')}); tool-call telemetry not yet available`
        : 'Define allowedConnectors in the AI inventory, then connect tool-call telemetry' }),
  ];

  // COST --------------------------------------------------------------
  let tokens = null;
  let credits = null;
  let spendUsd = null;
  let billing;
  const costMetrics = [];
  const billingModel = (inv?.billingModel || '').toLowerCase();

  if (isFoundry || costRows.length) {
    billing = 'tokens';
    const inTok = costRows.reduce((s, r) => s + num(r.InputTokens), 0);
    const outTok = costRows.reduce((s, r) => s + num(r.OutputTokens), 0);
    let unpriced = [];
    if (costRows.length) {
      tokens = inTok + outTok;
      spendUsd = 0;
      for (const r of costRows) {
        const p = priceFor(r.Model, cfg.modelPrices);
        if (!p) { unpriced.push(r.Model || 'unknown model'); continue; }
        spendUsd += (num(r.InputTokens) / 1e6) * p.in + (num(r.OutputTokens) / 1e6) * p.out;
      }
      if (unpriced.length === costRows.length) spendUsd = null;
      costMetrics.push(evaluate('token_consumption', { value: tokens,
        note: `${inTok.toLocaleString('en-US')} in · ${outTok.toLocaleString('en-US')} out · ${modelCalls.toLocaleString('en-US')} model calls` +
          (unpriced.length ? ` · no price for ${unpriced.join(', ')}` : '') }));
    } else {
      costMetrics.push(evaluate('token_consumption', { available: false, note: 'No gen_ai token telemetry received for this agent' }));
    }
  } else if (billingModel === 'm365-copilot') {
    billing = 'included';
    spendUsd = 0;
    costMetrics.push(evaluate('copilot_credits', { value: 0, display: 'Included',
      note: 'Employee-facing use by Microsoft 365 Copilot-licensed users is not charged (fair-use limits apply)' }));
  } else {
    billing = 'credits';
    const perResponse = inv?.creditsPerResponse ?? cfg.defaultCreditsPerResponse;
    credits = answered * perResponse;
    spendUsd = credits * cfg.creditPriceUsd;
    costMetrics.push(evaluate('copilot_credits', { value: credits, sample: answered,
      note: `${answered.toLocaleString('en-US')} answered messages × ${perResponse} credits · ≈ $${spendUsd.toFixed(2)} at $${cfg.creditPriceUsd}/credit` }));
  }

  const budget = inv?.monthlyBudgetUsd ? (inv.monthlyBudgetUsd * days) / 30 : null;
  if (billing === 'included') {
    costMetrics.push(evaluate('spend', { value: 0, display: 'Included', status: 'green', note: 'Covered by Microsoft 365 Copilot licences' }));
  } else if (engaged === 0 && !tokens) {
    costMetrics.push(evaluate('spend', { available: false, note: 'No activity in the period' }));
  } else if (spendUsd === null) {
    costMetrics.push(evaluate('spend', { available: false, note: 'No priced usage data for this agent yet' }));
  } else if (!budget) {
    costMetrics.push(evaluate('spend', { available: false, note: `≈ $${spendUsd.toFixed(2)} spent; no monthlyBudgetUsd in the AI inventory to compare against` }));
  } else {
    costMetrics.push(evaluate('spend', { value: pct(spendUsd, budget),
      note: `≈ $${spendUsd.toFixed(2)} of $${budget.toFixed(2)} budget for ${periodText}` }));
  }
  costMetrics.push(
    spendUsd !== null && engaged > 0
      ? evaluate('cost_per_conversation', { value: spendUsd / engaged, note: `${engaged.toLocaleString('en-US')} engaged conversations` })
      : evaluate('cost_per_conversation', { available: false, note: spendUsd === null ? 'Needs priced usage data' : 'No conversations in the period' })
  );

  const statuses = {
    health: worstStatus(health.map((m) => m.status)),
    risk: worstStatus(riskMetrics.map((m) => m.status)),
    cost: worstStatus(costMetrics.filter((m) => !m.informational).map((m) => m.status)),
  };
  statuses.overall = worstStatus(statuses.health, statuses.risk, statuses.cost);
  // An agent is only called Healthy when we could actually measure whether it works.
  if (statuses.overall === 'green' && statuses.health === 'unknown') statuses.overall = 'unknown';

  // COMPLIANCE (automatic: telemetry vs inventory) ---------------------
  const isProduction = num(row.ProductionConversations) > 0;
  const compliance = COMPLIANCE_CHECKS.map((check) => {
    let pass;
    let detail;
    switch (check.id) {
      case 'registered':
        pass = !!inv; detail = inv ? 'Inventory record found' : 'No inventory record matches this agent'; break;
      case 'owners': {
        const missing = [!inv?.businessOwner && 'business', !inv?.technicalOwner && 'technical'].filter(Boolean);
        pass = !missing.length; detail = pass ? `${inv.businessOwner} / ${inv.technicalOwner}` : `Missing ${missing.join(' and ')} owner`; break;
      }
      case 'risk_tier':
        pass = !!inv?.riskTier; detail = inv?.riskTier ? `${inv.riskTier} risk` : 'Not assigned'; break;
      case 'approved':
        pass = !isProduction || /^approved$/i.test(String(inv?.approvalStatus || '').trim());
        detail = isProduction ? `Used in production · status: ${inv?.approvalStatus || 'none'}` : 'Not used in production'; break;
      case 'telemetry':
        pass = conversations > 0; detail = conversations > 0 ? 'Telemetry received in the period' : 'No telemetry in the period'; break;
      default:
        pass = true;
    }
    return { id: check.id, name: check.name, pass, detail };
  });
  const compliant = compliance.every((c) => c.pass);

  const alerts = [...health, ...riskMetrics, ...costMetrics]
    .filter((m) => m.status === 'red' || m.status === 'amber')
    .sort((a, b) => (a.status === 'red' ? -1 : 0) - (b.status === 'red' ? -1 : 0))
    .map((m) => ({ id: m.id, metric: m.name, pillar: m.pillar, status: m.status, value: m.value, threshold: m.threshold }));

  const botNames = (row.BotNames || []).filter(Boolean).sort();
  return {
    id: key,
    name: inv?.displayName || botNames[0] || key,
    telemetryNames: [...new Set([key, ...botNames, ...(row.RawKeys || [])])],
    purpose: inv?.purpose || 'Not registered in the AI inventory — purpose unknown.',
    department: inv?.department || 'Unassigned',
    location: inv?.location || 'Unassigned',
    businessOwner: inv?.businessOwner || null,
    technicalOwner: inv?.technicalOwner || null,
    platform,
    riskTier: inv?.riskTier || null,
    approvalStatus: inv?.approvalStatus || null,
    registered: !!inv,
    environment: isProduction ? 'Production' : conversations > 0 ? 'Test only' : 'No activity',
    channels: row.Channels || [],
    productionDays: daysSince(inv?.productionSince, now),
    lastSeen: row.LastSeen || null,
    volume: engaged,
    allConversations: conversations,
    userTurns,
    errorEvents: num(row.ErrorEvents),
    topErrorCodes: row.TopErrorCodes || [],
    billing,
    tokens,
    credits,
    spendUsd,
    budgetUsd: budget,
    series,
    statuses,
    compliant,
    compliance,
    alerts,
    metrics: { health, risk: riskMetrics, cost: costMetrics },
  };
}

/** Fills missing hourly / daily buckets with zeros so charts have a continuous axis. */
function fillSeries(rows, startIso, endIso, days) {
  const step = days === 1 ? 3600000 : 86400000;
  const start = Math.floor(new Date(startIso).getTime() / step) * step;
  const end = new Date(endIso).getTime();
  const byT = new Map(rows.map((r) => [new Date(r.Bucket).getTime(), r]));
  const out = [];
  for (let t = start; t <= end; t += step) {
    const r = byT.get(t) || {};
    out.push({
      t: new Date(t).toISOString(),
      conversations: num(r.Conversations),
      failed: num(r.Failed),
      completed: num(r.Completed),
      blocked: num(r.Blocked),
    });
  }
  return out;
}

const STATUS_RANK = { red: 0, amber: 1, green: 2, unknown: 3 };
/** Deterministic order: worst status first, then most conversations, then name. */
function sortAgents(agents) {
  return agents.sort(
    (a, b) =>
      STATUS_RANK[a.statuses.overall] - STATUS_RANK[b.statuses.overall] ||
      b.volume - a.volume ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id)
  );
}

module.exports = { buildAgent, fillSeries, sortAgents, priceFor, DEFAULT_MODEL_PRICES, DEFAULT_CONFIG };
