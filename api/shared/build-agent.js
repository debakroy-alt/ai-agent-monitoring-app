/**
 * Turns aggregated telemetry rows + an agent profile into the agent object the
 * dashboard renders. Shared by the live API (api/agents) and the demo generator
 * (tools/gen-demo.cjs) so demo data always follows exactly the same rules.
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
 * Prices change — confirm for your region or override with MODEL_PRICES_JSON, e.g.
 *   {"gpt-4o":{"in":2.5,"out":10}}
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
const arr = (v) => (Array.isArray(v) ? v : []);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

function daysSince(dateString, now) {
  if (!dateString) return null;
  const t = new Date(dateString).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 86400000));
}

function buildAgent({ key, row = {}, turns = null, series = [], costRows = [], profile = null, days, now = Date.now(), config = {} }) {
  const cfg = { ...DEFAULT_CONFIG, ...config, modelPrices: { ...DEFAULT_MODEL_PRICES, ...(config.modelPrices || {}) } };
  const inv = profile || {};
  const conversations = num(row.Conversations);
  const engaged = num(row.Engaged);
  const userTurns = num(turns?.UserTurns);
  const answered = num(turns?.AnsweredTurns);
  const platform = inv.platform || (costRows.length ? 'Azure AI Foundry' : 'Microsoft Copilot Studio');
  const isFoundry = /foundry|sdk|azure ai/i.test(platform);
  const periodText = days === 1 ? 'the last 24 hours' : `the last ${days} days`;

  // HEALTH ------------------------------------------------------------
  const modelCalls = costRows.reduce((s, r) => s + num(r.ModelCalls), 0);
  const failedCalls = costRows.reduce((s, r) => s + num(r.FailedCalls), 0);
  const depFailed = num(row.DependencyFailed);
  const health = [
    evaluate('agent_availability', { value: pct(answered, userTurns), sample: userTurns,
      note: `${fmt(userTurns - answered)} of ${fmt(userTurns)} user messages got no reply` }),
    evaluate('task_completion', { value: pct(num(row.Resolved), engaged), sample: engaged,
      note: `${fmt(row.Resolved)} of ${fmt(engaged)} engaged conversations resolved · ${fmt(row.Escalated)} escalated or fell back` }),
    evaluate('p95_latency', { value: turns?.P95LatencySec ?? null, sample: answered,
      note: turns?.P50LatencySec != null ? `Typical (median) reply ${Math.round(turns.P50LatencySec * 10) / 10}s · ${fmt(answered)} answered messages` : null }),
    evaluate('timeout_rate', { value: pct(num(turns?.SlowTurns), answered), sample: answered,
      note: `${fmt(turns?.SlowTurns)} replies slower than ${cfg.slowReplySeconds}s` }),
    evaluate('failed_execution_rate', { value: pct(num(row.HealthFailed), engaged), sample: engaged,
      note: `${fmt(row.HealthFailed)} of ${fmt(engaged)} engaged conversations recorded an error` }),
    modelCalls > 0 && engaged === 0
      ? evaluate('dependency_failure_rate', { value: pct(failedCalls, modelCalls), sample: modelCalls, note: `${failedCalls} of ${modelCalls} model calls failed` })
      : evaluate('dependency_failure_rate', { value: pct(depFailed, engaged), sample: engaged, note: `${depFailed} conversation(s) hit a flow, connector or tool failure` }),
    evaluate('avg_retries', {}),
  ];

  // RISK --------------------------------------------------------------
  const jail = num(row.Jailbreaks);
  const indirect = num(row.IndirectAttacks);
  const harmful = num(row.HarmfulConversations);
  const dlp = num(row.DlpBlocks);
  const per1k = engaged > 0 ? (1000 * jail) / engaged : null;
  const riskMetrics = [
    evaluate('prompt_injection_attempts', { value: per1k, sample: engaged, display: `${jail} blocked`,
      status: engaged > 0 ? (jail === 0 ? 'green' : jail >= 3 && per1k > 10 ? 'red' : 'amber') : null,
      note: `${jail} attempt(s) in ${periodText} = ${per1k === null ? '—' : Math.round(per1k * 10) / 10} per 1,000 conversations` }),
    evaluate('indirect_attacks', { value: indirect, sample: engaged, note: indirect ? 'Review the knowledge sources this agent reads' : `None in ${periodText}` }),
    evaluate('content_safety_blocks', { value: pct(harmful, engaged), sample: engaged, note: `${harmful} conversation(s) filtered` }),
    evaluate('dlp_violations', { value: dlp, sample: engaged, note: dlp ? 'Agent attempted actions blocked by a DLP policy' : `None in ${periodText}` }),
    evaluate('sensitive_data_exposure', { note: 'Requires Microsoft Purview DSPM for AI connection' }),
    evaluate('unapproved_tool_calls', {
      note: inv.allowedConnectors?.length
        ? `Allowed list recorded (${inv.allowedConnectors.join(', ')}); tool-call telemetry not yet available`
        : 'Record allowed connectors on the agent profile, then connect tool-call telemetry' }),
  ];

  // COST --------------------------------------------------------------
  let tokens = null;
  let credits = null;
  let spendUsd = null;
  let billing;
  const costMetrics = [];
  const billingModel = String(inv.billingModel || '').toLowerCase();

  if (billingModel !== 'm365-copilot' && (isFoundry || billingModel === 'tokens' || costRows.length)) {
    billing = 'tokens';
    const inTok = costRows.reduce((s, r) => s + num(r.InputTokens), 0);
    const outTok = costRows.reduce((s, r) => s + num(r.OutputTokens), 0);
    const unpriced = [];
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
        note: `${fmt(inTok)} in · ${fmt(outTok)} out · ${fmt(modelCalls)} model calls` + (unpriced.length ? ` · no price for ${unpriced.join(', ')}` : '') }));
    } else {
      costMetrics.push(evaluate('token_consumption', { available: false, note: 'No gen_ai token telemetry received for this agent' }));
    }
  } else if (billingModel === 'm365-copilot') {
    billing = 'included';
    spendUsd = 0;
    costMetrics.push(evaluate('copilot_credits', { value: 0, display: 'Included',
      note: 'Employee use by Microsoft 365 Copilot-licensed users is not charged (fair-use limits apply)' }));
  } else {
    billing = 'credits';
    const perResponse = inv.creditsPerResponse ?? cfg.defaultCreditsPerResponse;
    credits = answered * perResponse;
    spendUsd = credits * cfg.creditPriceUsd;
    costMetrics.push(evaluate('copilot_credits', { value: credits,
      note: `${fmt(answered)} answered messages × ${perResponse} credits · ≈ $${spendUsd.toFixed(2)} at $${cfg.creditPriceUsd}/credit` }));
  }

  const budget = inv.monthlyBudgetUsd ? (inv.monthlyBudgetUsd * days) / 30 : null;
  if (billing === 'included') {
    costMetrics.push(evaluate('spend', { value: 0, display: 'Included', status: 'green', note: 'Covered by Microsoft 365 Copilot licences' }));
  } else if (engaged === 0 && !tokens) {
    costMetrics.push(evaluate('spend', { available: false, note: 'No activity in the period' }));
  } else if (spendUsd === null) {
    costMetrics.push(evaluate('spend', { available: false, note: 'No priced usage data for this agent yet' }));
  } else if (!budget) {
    costMetrics.push(evaluate('spend', { available: false, note: `≈ $${spendUsd.toFixed(2)} spent; no monthly budget on the agent profile to compare against` }));
  } else {
    costMetrics.push(evaluate('spend', { value: pct(spendUsd, budget), note: `≈ $${spendUsd.toFixed(2)} of $${budget.toFixed(2)} budget for ${periodText}` }));
  }
  costMetrics.push(
    spendUsd !== null && engaged > 0
      ? evaluate('cost_per_conversation', { value: spendUsd / engaged, note: `${fmt(engaged)} engaged conversations` })
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

  // AI POLICY (automatic: telemetry vs profile) ------------------------
  const isProduction = num(row.ProductionConversations) > 0;
  const compliance = COMPLIANCE_CHECKS.map((check) => {
    let pass;
    let detail;
    switch (check.id) {
      case 'profile': {
        const missing = [!inv.purpose && 'purpose', !inv.department && 'department'].filter(Boolean);
        pass = !missing.length; detail = pass ? inv.department : `Missing ${missing.join(' and ')}`; break;
      }
      case 'owners': {
        const missing = [!inv.businessOwner && 'business', !inv.technicalOwner && 'technical'].filter(Boolean);
        pass = !missing.length; detail = pass ? `${inv.businessOwner} / ${inv.technicalOwner}` : `Missing ${missing.join(' and ')} owner`; break;
      }
      case 'risk_tier':
        pass = !!inv.riskTier; detail = inv.riskTier ? `${inv.riskTier} risk` : 'Not assigned'; break;
      case 'approved':
        pass = !isProduction || /^approved$/i.test(String(inv.approvalStatus || '').trim());
        detail = isProduction ? `Used in production · status: ${inv.approvalStatus || 'none'}` : 'Not used in production'; break;
      default:
        pass = true;
    }
    return { id: check.id, name: check.name, pass, detail };
  });

  const alerts = [...health, ...riskMetrics, ...costMetrics]
    .filter((m) => m.status === 'red' || m.status === 'amber')
    .sort((a, b) => (a.status === 'red' ? 0 : 1) - (b.status === 'red' ? 0 : 1))
    .map((m) => ({ id: m.id, metric: m.name, pillar: m.pillar, status: m.status, value: m.value, threshold: m.threshold }));

  const botNames = arr(row.BotNames).filter(Boolean).sort();
  return {
    id: key,
    connected: true,
    name: inv.displayName || botNames[0] || key,
    telemetryNames: [...new Set([key, ...botNames, ...arr(row.RawKeys)])].filter(Boolean),
    purpose: inv.purpose || null,
    department: inv.department || 'Unassigned',
    location: inv.location || 'Unassigned',
    businessOwner: inv.businessOwner || null,
    technicalOwner: inv.technicalOwner || null,
    platform,
    riskTier: inv.riskTier || null,
    approvalStatus: inv.approvalStatus || null,
    environment: isProduction ? 'Production' : conversations > 0 ? 'Test only' : 'No activity',
    channels: arr(row.Channels),
    productionDays: daysSince(inv.productionSince, now),
    lastSeen: row.LastSeen || null,
    volume: engaged,
    allConversations: conversations,
    userTurns,
    errorEvents: num(row.ErrorEvents),
    topErrorCodes: arr(row.TopErrorCodes),
    billing,
    tokens,
    credits,
    spendUsd,
    budgetUsd: budget,
    raw: {
      engaged,
      resolved: num(row.Resolved),
      healthFailed: num(row.HealthFailed),
      dependencyFailed: depFailed,
      userTurns,
      answered,
      slow: num(turns?.SlowTurns),
      p95: turns?.P95LatencySec ?? null,
      jailbreaks: jail,
      indirect,
      harmful,
      dlp,
    },
    series,
    statuses,
    compliant: compliance.every((c) => c.pass),
    compliance,
    alerts,
    metrics: { health, risk: riskMetrics, cost: costMetrics },
    profile: {
      id: inv.id || key,
      displayName: inv.displayName || null,
      aliases: inv.aliases || [],
      purpose: inv.purpose || '',
      department: inv.department || '',
      location: inv.location || '',
      businessOwner: inv.businessOwner || '',
      technicalOwner: inv.technicalOwner || '',
      platform: inv.platform || '',
      riskTier: inv.riskTier || '',
      approvalStatus: inv.approvalStatus || '',
      productionSince: inv.productionSince || '',
      monthlyBudgetUsd: inv.monthlyBudgetUsd ?? '',
      billingModel: inv.billingModel || '',
      creditsPerResponse: inv.creditsPerResponse ?? '',
      allowedConnectors: inv.allowedConnectors || [],
      notes: inv.notes || '',
    },
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
    out.push({ t: new Date(t).toISOString(), conversations: num(r.Conversations), failed: num(r.Failed), completed: num(r.Completed), blocked: num(r.Blocked) });
  }
  return out;
}

const STATUS_RANK = { red: 0, amber: 1, green: 2, unknown: 3 };
/** Deterministic order: worst status first, then most conversations, then name. */
function sortAgents(agents) {
  return agents.sort(
    (a, b) => STATUS_RANK[a.statuses.overall] - STATUS_RANK[b.statuses.overall] || b.volume - a.volume || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

/** Summary of an agent that sends telemetry but is not connected. */
function buildDiscovered({ key, row = {}, suggestion = null }) {
  const names = [...new Set([...arr(row.BotNames), ...arr(row.RawKeys)].filter(Boolean))];
  return {
    id: key,
    name: suggestion?.displayName || arr(row.BotNames)[0] || key,
    names,
    conversations: num(row.Engaged),
    allConversations: num(row.Conversations),
    environment: num(row.ProductionConversations) > 0 ? 'Production' : 'Test only',
    lastSeen: row.LastSeen || null,
    suggestion: suggestion
      ? { ...suggestion, key: undefined }
      : { id: key, displayName: arr(row.BotNames)[0] || key, aliases: names.filter((n) => n.toLowerCase() !== String(key).toLowerCase()) },
  };
}

module.exports = { buildAgent, buildDiscovered, fillSeries, sortAgents, priceFor, DEFAULT_MODEL_PRICES, DEFAULT_CONFIG };
