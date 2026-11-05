/**
 * Turns aggregated telemetry rows + an (optional) agent profile into the agent
 * object the dashboard renders. Shared by the live API and the demo generator.
 */
const { evaluate, worstStatus, COMPLIANCE_CHECKS } = require('./metrics-registry');

const DEFAULT_CONFIG = {
  slowReplySeconds: 30,
  creditPriceUsd: 0.01, // Copilot Studio pay-as-you-go: $0.01 per Copilot Credit
  defaultCreditsPerResponse: 2, // generative answer rate
  modelPrices: {},
};

/** USD per 1M tokens (Azure OpenAI Global Standard). Confirm for your region or override with MODEL_PRICES_JSON. */
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

/**
 * Readable name from a Copilot Studio schema name, used until a display name is saved.
 *   sps_dailyCyberPrivacyBriefing → Daily Cyber Privacy Briefing
 *   cr4f2_OneTrustTPCRMAgent      → One Trust TPCRM Agent
 */
function prettyName(id) {
  let s = String(id || '').trim();
  const m = s.match(/^[a-z0-9]{2,8}_(.+)$/);
  if (m) s = m[1];
  if (/\s/.test(s)) return s;
  s = s
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(id);
}

function daysSince(dateString, now) {
  if (!dateString) return null;
  const t = new Date(dateString).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 86400000));
}

/**
 * @param dataDays     the window the numbers actually cover (may be longer than the selected period)
 * @param selectedDays the reporting period the user picked
 */
function buildAgent({ key, row = {}, turns = null, series = [], costRows = [], profile = null, days, selectedDays = days, now = Date.now(), config = {} }) {
  const cfg = { ...DEFAULT_CONFIG, ...config, modelPrices: { ...DEFAULT_MODEL_PRICES, ...(config.modelPrices || {}) } };
  const inv = profile || {};
  const conversations = num(row.Conversations);
  const runs = num(row.Engaged); // chats with a user message + trigger-started runs
  const autoRuns = num(row.AutoRuns);
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
    evaluate('agent_availability', {
      value: pct(answered, userTurns), sample: userTurns,
      note: userTurns ? `${fmt(userTurns - answered)} of ${fmt(userTurns)} user messages got no reply` : autoRuns ? 'Automatic runs only — no chat messages to answer' : null,
    }),
    evaluate('task_completion', {
      value: pct(num(row.Resolved), runs), sample: runs,
      note: `${fmt(row.Resolved)} of ${fmt(runs)} runs resolved${autoRuns ? ` (${fmt(autoRuns)} automatic)` : ''} · ${fmt(row.Escalated)} escalated or fell back`,
    }),
    evaluate('p95_latency', {
      value: turns?.P95LatencySec ?? null, sample: answered,
      note: turns?.P50LatencySec != null ? `Typical (median) reply ${Math.round(turns.P50LatencySec * 10) / 10}s · ${fmt(answered)} answered messages` : null,
    }),
    evaluate('timeout_rate', { value: pct(num(turns?.SlowTurns), answered), sample: answered, note: `${fmt(turns?.SlowTurns)} replies slower than ${cfg.slowReplySeconds}s` }),
    evaluate('failed_execution_rate', { value: pct(num(row.HealthFailed), runs), sample: runs, note: `${fmt(row.HealthFailed)} of ${fmt(runs)} runs recorded an error` }),
    modelCalls > 0 && runs === 0
      ? evaluate('dependency_failure_rate', { value: pct(failedCalls, modelCalls), sample: modelCalls, note: `${failedCalls} of ${modelCalls} model calls failed` })
      : evaluate('dependency_failure_rate', { value: pct(depFailed, runs), sample: runs, note: `${depFailed} run(s) hit a flow, connector or tool failure` }),
    evaluate('avg_retries', {}),
  ];

  // RISK --------------------------------------------------------------
  const jail = num(row.Jailbreaks);
  const indirect = num(row.IndirectAttacks);
  const harmful = num(row.HarmfulConversations);
  const dlp = num(row.DlpBlocks);
  const per1k = runs > 0 ? (1000 * jail) / runs : null;
  const riskMetrics = [
    evaluate('prompt_injection_attempts', {
      value: per1k, sample: runs, display: `${jail} blocked`,
      status: runs > 0 ? (jail === 0 ? 'green' : jail >= 3 && per1k > 10 ? 'red' : 'amber') : null,
      note: `${jail} attempt(s) in ${periodText} = ${per1k === null ? '—' : Math.round(per1k * 10) / 10} per 1,000 runs`,
    }),
    evaluate('indirect_attacks', { value: indirect, sample: runs, note: indirect ? 'Review the knowledge sources this agent reads' : `None in ${periodText}` }),
    evaluate('content_safety_blocks', { value: pct(harmful, runs), sample: runs, note: `${harmful} run(s) filtered` }),
    evaluate('dlp_violations', { value: dlp, sample: runs, note: dlp ? 'Agent attempted actions blocked by a DLP policy' : `None in ${periodText}` }),
    evaluate('sensitive_data_exposure', { note: 'Requires Microsoft Purview DSPM for AI connection' }),
    evaluate('unapproved_tool_calls', {
      note: inv.allowedConnectors?.length
        ? `Allowed list recorded (${inv.allowedConnectors.join(', ')}); tool-call telemetry not yet available`
        : 'Record allowed connectors on the agent profile, then connect tool-call telemetry',
    }),
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
      costMetrics.push(evaluate('token_consumption', {
        value: tokens, note: `${fmt(inTok)} in · ${fmt(outTok)} out · ${fmt(modelCalls)} model calls` + (unpriced.length ? ` · no price for ${unpriced.join(', ')}` : ''),
      }));
    } else {
      costMetrics.push(evaluate('token_consumption', { available: false, note: 'No gen_ai token telemetry received for this agent' }));
    }
  } else if (billingModel === 'm365-copilot') {
    billing = 'included';
    spendUsd = 0;
    costMetrics.push(evaluate('copilot_credits', { value: 0, display: 'Included', note: 'Employee use by Microsoft 365 Copilot-licensed users is not charged (fair-use limits apply)' }));
  } else {
    billing = 'credits';
    const perResponse = inv.creditsPerResponse ?? cfg.defaultCreditsPerResponse;
    const responses = answered + autoRuns;
    credits = responses * perResponse;
    spendUsd = credits * cfg.creditPriceUsd;
    costMetrics.push(evaluate('copilot_credits', {
      value: credits,
      note: `${fmt(answered)} chat replies + ${fmt(autoRuns)} automatic runs × ${perResponse} credits · ≈ $${spendUsd.toFixed(2)} at $${cfg.creditPriceUsd}/credit`,
    }));
  }

  const budget = inv.monthlyBudgetUsd ? (inv.monthlyBudgetUsd * days) / 30 : null;
  if (billing === 'included') {
    costMetrics.push(evaluate('spend', { value: 0, display: 'Included', status: 'green', note: 'Covered by Microsoft 365 Copilot licences' }));
  } else if (runs === 0 && !tokens) {
    costMetrics.push(evaluate('spend', { available: false, note: 'No activity in the period' }));
  } else if (spendUsd === null) {
    costMetrics.push(evaluate('spend', { available: false, note: 'No priced usage data for this agent yet' }));
  } else if (!budget) {
    costMetrics.push(evaluate('spend', { available: false, note: `≈ $${spendUsd.toFixed(2)} spent; set a monthly budget on the agent profile to rate Cost` }));
  } else {
    costMetrics.push(evaluate('spend', { value: pct(spendUsd, budget), note: `≈ $${spendUsd.toFixed(2)} of $${budget.toFixed(2)} budget for ${periodText}` }));
  }
  costMetrics.push(
    spendUsd !== null && runs > 0
      ? evaluate('cost_per_conversation', { value: spendUsd / runs, note: `${fmt(runs)} runs` })
      : evaluate('cost_per_conversation', { available: false, note: spendUsd === null ? 'Needs priced usage data' : 'No runs in the period' })
  );

  const statuses = {
    health: worstStatus(health.map((m) => m.status)),
    risk: worstStatus(riskMetrics.map((m) => m.status)),
    cost: worstStatus(costMetrics.filter((m) => !m.informational).map((m) => m.status)),
  };
  statuses.overall = worstStatus(statuses.health, statuses.risk, statuses.cost);
  if (statuses.overall === 'green' && statuses.health === 'unknown') statuses.overall = 'unknown';

  // AI POLICY ----------------------------------------------------------
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
  const telemetryName = botNames.find((n) => n.toLowerCase() !== String(key).toLowerCase());
  return {
    id: key,
    name: inv.displayName || telemetryName || prettyName(key),
    hasProfile: !!profile,
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
    dataDays: days,
    selectedDays,
    widened: days !== selectedDays,
    volume: runs,
    autoRuns,
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
      engaged: runs,
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
      id: key,
      displayName: inv.displayName || '',
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
function sortAgents(agents) {
  return agents.sort(
    (a, b) => STATUS_RANK[a.statuses.overall] - STATUS_RANK[b.statuses.overall] || b.volume - a.volume || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

module.exports = { buildAgent, fillSeries, sortAgents, priceFor, prettyName, DEFAULT_MODEL_PRICES, DEFAULT_CONFIG };
