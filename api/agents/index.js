/**
 * GET /api/agents?days=7
 *
 * Reads Copilot Studio runtime telemetry from Log Analytics (workspace-based
 * Application Insights), merges it with the AI inventory, applies the metrics
 * library, and returns one payload for the whole dashboard.
 *
 * No value that drives a red / amber / green status is entered manually.
 */
const { DefaultAzureCredential } = require('@azure/identity');
const { evaluate, worstStatus, publicLibrary, COMPLIANCE_CHECKS } = require('../shared/metrics-registry');
const { loadInventory, matchInventory } = require('../shared/inventory');

const ALLOWED_DAYS = [1, 7, 30, 90];
const TIMEOUT_SECONDS = Number(process.env.TIMEOUT_SECONDS || 30);
const PRICE_IN_PER_1K = process.env.PRICE_INPUT_PER_1K_USD ? Number(process.env.PRICE_INPUT_PER_1K_USD) : null;
const PRICE_OUT_PER_1K = process.env.PRICE_OUTPUT_PER_1K_USD ? Number(process.env.PRICE_OUTPUT_PER_1K_USD) : null;

const credential = new DefaultAzureCredential();

// ------------------------------------------------------------------ KQL
// Shared prelude: resolves every conversation to one agent id.
// Precedence: bot name on inbound messages -> bot name on outbound messages -> topic schema prefix.
const prelude = (days) => String.raw`
let lookback = ${days}d;
let Base = AppEvents
    | where TimeGenerated > ago(lookback)
    | extend
        ConversationId = tostring(Properties["conversationId"]),
        RecipientName  = tostring(Properties["recipientName"]),
        FromName       = tostring(Properties["fromName"]),
        TopicId        = tostring(Properties["TopicId"]),
        DesignMode     = tostring(Properties["DesignMode"]),
        ChannelId      = tostring(Properties["channelId"]),
        ErrorCode      = tostring(Properties["ErrorCodeText"])
    | where isnotempty(ConversationId);
let AgentMap = Base
    | extend AgentFromTopicId = extract(@"^(.+?)\.topic\.", 1, TopicId)
    | extend Candidate = case(
        Name == "BotMessageReceived" and isnotempty(RecipientName), RecipientName,
        Name == "BotMessageSend" and isnotempty(FromName), FromName,
        isnotempty(AgentFromTopicId), AgentFromTopicId,
        "")
    | where isnotempty(Candidate)
    | summarize AgentId = take_any(Candidate) by ConversationId;
let Events = Base | join kind=inner AgentMap on ConversationId;
`;

const QUERIES = {
  summary: (d) => prelude(d) + String.raw`
Events
| summarize
    TopicEnds = countif(Name == "TopicEnd"),
    Errors = countif(Name == "OnErrorLog"),
    ProdEvents = countif(DesignMode =~ "False"),
    TestEvents = countif(DesignMode =~ "True"),
    Channel = take_anyif(ChannelId, isnotempty(ChannelId)),
    First = min(TimeGenerated), Last = max(TimeGenerated)
    by AgentId, ConversationId
| summarize
    Conversations = count(),
    CompletedConversations = countif(TopicEnds > 0 and Errors == 0),
    FailedConversations = countif(Errors > 0),
    ErrorEvents = sum(Errors),
    ProductionConversations = countif(ProdEvents > 0),
    TestConversations = countif(TestEvents > 0),
    Channels = make_set(Channel, 10),
    FirstSeen = min(First), LastSeen = max(Last)
    by AgentId`,

  turns: (d) => prelude(d) + String.raw`
Events
| where Name in ("BotMessageReceived", "BotMessageSend")
| project AgentId, ConversationId, Name, TimeGenerated
| sort by ConversationId asc, TimeGenerated asc
| extend NextName = next(Name), NextConv = next(ConversationId), NextTime = next(TimeGenerated)
| where Name == "BotMessageReceived"
| extend Answered = NextConv == ConversationId and NextName == "BotMessageSend"
| extend LatencySec = iff(Answered, datetime_diff('millisecond', NextTime, TimeGenerated) / 1000.0, real(null))
| summarize
    UserTurns = count(),
    AnsweredTurns = countif(Answered),
    SlowTurns = countif(Answered and LatencySec > ${TIMEOUT_SECONDS}),
    P95LatencySec = percentile(LatencySec, 95),
    P50LatencySec = percentile(LatencySec, 50)
    by AgentId`,

  series: (d) => prelude(d) + String.raw`
Events
| summarize Errors = countif(Name == "OnErrorLog"), Ends = countif(Name == "TopicEnd")
    by AgentId, ConversationId, Bucket = bin(TimeGenerated, ${d === 1 ? '1h' : '1d'})
| summarize Conversations = count(), Failed = countif(Errors > 0), Completed = countif(Ends > 0 and Errors == 0)
    by AgentId, Bucket
| order by Bucket asc`,

  risk: (d) => prelude(d) + String.raw`
Events
| where Name == "OnErrorLog"
| extend Code = tolower(ErrorCode)
| extend IsInjection = Code contains "jailbreak" or Code contains "indirectattack" or Code contains "promptinjection",
         IsContent = Code contains "contentfilter" or Code contains "hate" or Code contains "violence"
                     or Code contains "sexual" or Code contains "selfharm" or Code contains "contentmoderat"
| summarize
    InjectionAttempts = countif(IsInjection),
    ContentBlockedConversations = dcountif(ConversationId, IsContent),
    TopErrorCodes = make_set_if(ErrorCode, isnotempty(ErrorCode), 5)
    by AgentId`,

  // Optional: only returns rows for agents instrumented with OpenTelemetry gen_ai.* (e.g. Foundry).
  cost: (d) => String.raw`
union isfuzzy=true
    (AppDependencies | where TimeGenerated > ago(${d}d)),
    (datatable(TimeGenerated:datetime, Properties:dynamic, AppRoleName:string, Success:bool)[])
| extend AgentId = coalesce(tostring(Properties["gen_ai.agent.name"]), tostring(Properties["gen_ai.agent.id"])),
         InTok = tolong(Properties["gen_ai.usage.input_tokens"]),
         OutTok = tolong(Properties["gen_ai.usage.output_tokens"]),
         Model = tostring(Properties["gen_ai.request.model"])
| where isnotempty(AgentId) and (isnotnull(InTok) or isnotnull(OutTok))
| summarize InputTokens = sum(InTok), OutputTokens = sum(OutTok), ModelCalls = count(),
            FailedCalls = countif(Success == false), Models = make_set(Model, 5)
    by AgentId`,
};

async function runQuery(workspaceId, token, query) {
  const response = await fetch(`https://api.loganalytics.azure.com/v1/workspaces/${workspaceId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error?.message || `Log Analytics returned HTTP ${response.status}`);
  const table = result.tables?.[0];
  if (!table) return [];
  return table.rows.map((row) => Object.fromEntries(table.columns.map((c, i) => [c.name, row[i]])));
}

const byAgent = (rows) => Object.fromEntries(rows.map((r) => [r.AgentId, r]));
const pct = (num, den) => (den > 0 ? (100 * num) / den : null);

function formatAge(ts) {
  if (!ts) return 'never';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} day(s) ago`;
}

function daysSince(dateString) {
  if (!dateString) return null;
  const t = new Date(dateString).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

// -------------------------------------------------------- per-agent build
function buildAgent({ row, turns, series, risk, cost, inv, days }) {
  const conversations = Number(row.Conversations || 0);
  const userTurns = Number(turns?.UserTurns || 0);
  const answered = Number(turns?.AnsweredTurns || 0);

  // HEALTH ------------------------------------------------------------
  const health = [
    evaluate('agent_availability', { value: pct(answered, userTurns), sample: userTurns }),
    evaluate('task_completion', { value: pct(row.CompletedConversations, conversations), sample: conversations }),
    evaluate('p95_latency', { value: turns?.P95LatencySec ?? null, sample: answered,
      note: turns?.P50LatencySec != null ? `Median ${Math.round(turns.P50LatencySec * 10) / 10}s · ${answered} answered turns` : null }),
    evaluate('timeout_rate', { value: pct(turns?.SlowTurns || 0, answered), sample: answered,
      note: `${turns?.SlowTurns || 0} replies slower than ${TIMEOUT_SECONDS}s` }),
    evaluate('failed_execution_rate', { value: pct(row.FailedConversations, conversations), sample: conversations,
      note: `${row.FailedConversations || 0} of ${conversations} conversations recorded an error` }),
    evaluate('avg_retries', {}),
    cost
      ? evaluate('dependency_availability', {
          value: pct(cost.ModelCalls - cost.FailedCalls, cost.ModelCalls), sample: cost.ModelCalls,
          note: 'Model calls only (from gen_ai telemetry)' })
      : evaluate('dependency_availability', { available: false,
          note: 'Copilot Studio does not emit dependency calls to Application Insights' }),
  ];

  // RISK --------------------------------------------------------------
  const injections = Number(risk?.InjectionAttempts || 0);
  const riskMetrics = [
    evaluate('prompt_injection_attempts', { value: injections, sample: conversations,
      note: `${injections} blocked attempt(s) in ${days === 1 ? '24 hours' : `${days} days`}` }),
    evaluate('content_safety_blocks', { value: pct(risk?.ContentBlockedConversations || 0, conversations), sample: conversations,
      note: `${risk?.ContentBlockedConversations || 0} conversation(s) filtered` }),
    evaluate('sensitive_data_exposure', { note: 'Requires Microsoft Purview DSPM for AI connection' }),
    evaluate('unapproved_tool_calls', {
      note: inv?.allowedConnectors?.length
        ? `Allowed list defined (${inv.allowedConnectors.join(', ')}); call telemetry not yet available`
        : 'Define allowedConnectors in the AI inventory, then connect dependency telemetry' }),
  ];

  // COST --------------------------------------------------------------
  let costMetrics;
  let spendUsd = null;
  let tokens = null;
  if (cost) {
    tokens = Number(cost.InputTokens || 0) + Number(cost.OutputTokens || 0);
    if (PRICE_IN_PER_1K !== null && PRICE_OUT_PER_1K !== null) {
      spendUsd = (Number(cost.InputTokens || 0) / 1000) * PRICE_IN_PER_1K + (Number(cost.OutputTokens || 0) / 1000) * PRICE_OUT_PER_1K;
    }
    const budget = inv?.monthlyBudgetUsd ? (inv.monthlyBudgetUsd * days) / 30 : null;
    costMetrics = [
      evaluate('token_consumption', { value: tokens,
        note: `${Number(cost.InputTokens || 0).toLocaleString('en-US')} in · ${Number(cost.OutputTokens || 0).toLocaleString('en-US')} out · ${cost.ModelCalls} model calls` }),
      spendUsd !== null && budget
        ? evaluate('spend', { value: pct(spendUsd, budget), note: `$${spendUsd.toFixed(2)} of $${budget.toFixed(2)} pro-rated budget` })
        : evaluate('spend', { available: false,
            note: spendUsd === null ? 'Set PRICE_INPUT_PER_1K_USD / PRICE_OUTPUT_PER_1K_USD' : 'No monthlyBudgetUsd in the AI inventory' }),
    ];
  } else {
    costMetrics = [
      evaluate('token_consumption', { available: false, note: 'Copilot Studio does not publish token usage to Application Insights' }),
      evaluate('spend', { available: false, note: 'Requires token telemetry (Foundry / gateway) — pending PurpleStratus access' }),
    ];
  }

  const statuses = {
    health: worstStatus(health.map((m) => m.status)),
    risk: worstStatus(riskMetrics.map((m) => m.status)),
    cost: worstStatus(costMetrics.map((m) => m.status)),
  };
  statuses.overall = worstStatus(statuses.health, statuses.risk, statuses.cost);

  // COMPLIANCE (automatic: telemetry vs inventory) ---------------------
  const isProduction = Number(row.ProductionConversations || 0) > 0;
  const compliance = COMPLIANCE_CHECKS.map((check) => {
    let pass;
    let detail;
    switch (check.id) {
      case 'registered':
        pass = !!inv; detail = inv ? 'Inventory record found' : 'No inventory record matches this telemetry id'; break;
      case 'owners':
        pass = !!(inv?.businessOwner && inv?.technicalOwner); detail = pass ? `${inv.businessOwner} / ${inv.technicalOwner}` : 'Owner missing'; break;
      case 'risk_tier':
        pass = !!inv?.riskTier; detail = inv?.riskTier || 'Not assigned'; break;
      case 'approved':
        pass = !isProduction || /approved/i.test(inv?.approvalStatus || '');
        detail = isProduction ? `Production traffic · status: ${inv?.approvalStatus || 'none'}` : 'No production traffic'; break;
      case 'telemetry':
        pass = conversations > 0; detail = `Last event ${formatAge(row.LastSeen)}`; break;
      default:
        pass = true;
    }
    return { id: check.id, name: check.name, pass, detail };
  });
  const compliant = compliance.every((c) => c.pass);

  const alerts = [...health, ...riskMetrics, ...costMetrics]
    .filter((m) => m.status === 'red' || m.status === 'amber')
    .map((m) => ({ metric: m.name, pillar: m.pillar, status: m.status, value: m.value }));

  const productionDays = daysSince(inv?.productionSince);

  return {
    id: row.AgentId,
    name: inv?.displayName || row.AgentId,
    purpose: inv?.purpose || 'Not registered in the AI inventory — purpose unknown.',
    department: inv?.department || 'Unassigned',
    location: inv?.location || 'Unassigned',
    businessOwner: inv?.businessOwner || null,
    technicalOwner: inv?.technicalOwner || null,
    platform: inv?.platform || 'Microsoft Copilot Studio',
    riskTier: inv?.riskTier || null,
    approvalStatus: inv?.approvalStatus || null,
    registered: !!inv,
    environment: isProduction ? 'Production' : conversations > 0 ? 'Test' : 'No traffic',
    channels: row.Channels || [],
    productionDays,
    lastSeen: row.LastSeen,
    updated: formatAge(row.LastSeen),
    volume: conversations,
    userTurns,
    errorEvents: Number(row.ErrorEvents || 0),
    topErrorCodes: risk?.TopErrorCodes || [],
    tokens,
    spendUsd,
    series: series.map((s) => ({
      t: s.Bucket,
      conversations: Number(s.Conversations || 0),
      failed: Number(s.Failed || 0),
      completed: Number(s.Completed || 0),
    })),
    statuses,
    compliant,
    compliance,
    alerts,
    metrics: { health, risk: riskMetrics, cost: costMetrics },
  };
}

// ---------------------------------------------------------------- handler
module.exports = async function (context, req) {
  const started = Date.now();
  try {
    const workspaceId = process.env.LOG_ANALYTICS_WORKSPACE_ID;
    if (!workspaceId) throw new Error('LOG_ANALYTICS_WORKSPACE_ID is not configured.');

    const requested = Number(req?.query?.days || process.env.TELEMETRY_LOOKBACK_DAYS || 7);
    const days = ALLOWED_DAYS.includes(requested) ? requested : 7;

    const { token } = await credential.getToken('https://api.loganalytics.io/.default');
    const q = (name) => runQuery(workspaceId, token, QUERIES[name](days));

    const [summary, turns, series, risk, costResult, inventory] = await Promise.all([
      q('summary'),
      q('turns'),
      q('series'),
      q('risk'),
      q('cost').then((rows) => ({ ok: true, rows }), (e) => ({ ok: false, rows: [], error: e.message })),
      loadInventory(credential).catch((e) => ({ source: 'error', sourceLabel: e.message, records: [] })),
    ]);

    const turnsBy = byAgent(turns);
    const riskBy = byAgent(risk);
    const costBy = byAgent(costResult.rows);
    const seriesBy = series.reduce((acc, r) => ((acc[r.AgentId] ||= []).push(r), acc), {});

    const agents = summary
      .map((row) =>
        buildAgent({
          row,
          turns: turnsBy[row.AgentId],
          series: seriesBy[row.AgentId] || [],
          risk: riskBy[row.AgentId],
          cost: costBy[row.AgentId],
          inv: matchInventory(inventory.records, row.AgentId),
          days,
        })
      )
      .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

    // Registered agents with no telemetry in the period are still shown (grey) so gaps are visible.
    const seen = new Set(agents.flatMap((a) => [a.id.toLowerCase(), a.name.toLowerCase()]));
    const silent = inventory.records
      .filter((r) => ![r.id, r.displayName, ...(r.aliases || [])].filter(Boolean).some((v) => seen.has(String(v).toLowerCase())))
      .filter((r) => r.id && !String(r.id).startsWith('REPLACE_WITH'))
      .map((inv) => buildAgent({ row: { AgentId: inv.id, Conversations: 0 }, turns: null, series: [], risk: null, cost: null, inv, days }));

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: {
        mode: 'live',
        lookbackDays: days,
        generatedAt: new Date().toISOString(),
        queryMs: Date.now() - started,
        sources: {
          telemetry: 'Application Insights (Log Analytics workspace)',
          inventory: inventory.source,
          inventoryLabel: inventory.sourceLabel,
          inventoryRecords: inventory.records.length,
          costTelemetry: costResult.ok ? (costResult.rows.length ? 'connected' : 'no gen_ai token data') : 'unavailable',
          pricing: PRICE_IN_PER_1K !== null && PRICE_OUT_PER_1K !== null ? 'configured' : 'not configured',
          timeoutSeconds: TIMEOUT_SECONDS,
        },
        library: publicLibrary(),
        agents: [...agents, ...silent],
      },
    };
  } catch (error) {
    context.log.error('Live telemetry query failed.', error);
    context.res = {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: {
        mode: 'error',
        message: 'Live telemetry could not be retrieved.',
        technicalDetail: process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
    };
  }
};
