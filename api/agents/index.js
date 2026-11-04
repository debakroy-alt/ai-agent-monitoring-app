/**
 * GET /api/agents?days=7[&fresh=1]
 *
 * Reads Copilot Studio (and Foundry / OpenTelemetry) runtime telemetry from
 * Log Analytics (workspace-based Application Insights), merges it with the AI
 * inventory, applies the metrics library, and returns one payload for the
 * whole dashboard.
 *
 * No value that drives a red / amber / green status is entered manually.
 *
 * Identity stability (fixes "the agents shown keep changing"):
 *   - Every conversation is mapped to ONE agent deterministically (sorted sets,
 *     no take_any), and bot display names are mapped to their schema name.
 *   - Every known name (schema, display name, aliases) is mapped to the
 *     inventory key inside KQL, so all queries agree on the same agent IDs.
 *   - All queries share one fixed [start, end] window instead of ago().
 *   - Results are sorted deterministically (status, volume, name).
 */
const { DefaultAzureCredential } = require('@azure/identity');
const { publicLibrary } = require('../shared/metrics-registry');
const { loadInventory, matchInventory, buildAliasMap } = require('../shared/inventory');
const { buildAgent, fillSeries, sortAgents, DEFAULT_CONFIG } = require('../shared/build-agent');

const ALLOWED_DAYS = [1, 7, 30, 90];
const CACHE_MS = Number(process.env.CACHE_SECONDS || 60) * 1000;

function readConfig() {
  const modelPrices = {};
  try {
    Object.assign(modelPrices, JSON.parse(process.env.MODEL_PRICES_JSON || '{}'));
  } catch {
    /* ignore malformed JSON; defaults apply */
  }
  // Backwards compatible single price list (USD per 1K tokens) applies to any model without a specific price.
  if (process.env.PRICE_INPUT_PER_1K_USD && process.env.PRICE_OUTPUT_PER_1K_USD) {
    modelPrices[''] = { in: Number(process.env.PRICE_INPUT_PER_1K_USD) * 1000, out: Number(process.env.PRICE_OUTPUT_PER_1K_USD) * 1000 };
  }
  return {
    slowReplySeconds: Number(process.env.SLOW_REPLY_SECONDS || process.env.TIMEOUT_SECONDS || DEFAULT_CONFIG.slowReplySeconds),
    creditPriceUsd: Number(process.env.COPILOT_CREDIT_PRICE_USD || DEFAULT_CONFIG.creditPriceUsd),
    defaultCreditsPerResponse: Number(process.env.DEFAULT_CREDITS_PER_RESPONSE || DEFAULT_CONFIG.defaultCreditsPerResponse),
    modelPrices,
  };
}

const credential = new DefaultAzureCredential();
const cache = new Map(); // days -> { at, body }

// ------------------------------------------------------------------ KQL
const kqlString = (s) => `'${String(s).replace(/[\r\n\t]/g, ' ').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function aliasTable(aliasMap) {
  const rows = [...aliasMap.entries()].map(([k, v]) => `${kqlString(k)}, ${kqlString(v)}`);
  return `datatable(AliasKey:string, Canonical:string)[${rows.join(',\n  ')}]`;
}

// Error codes from the Copilot Studio error-code reference.
const CODES = {
  jailbreak: ['openaijailbreak', 'jailbreak'],
  indirect: ['openaindirectattack', 'openaiindirectattack'],
  harmful: ['openaihate', 'openaisexual', 'openaiviolence', 'openaiselfharm'],
  dlp: ['datalosspreventionviolation'],
  dependency: [
    'flowactiontimedout', 'flowactionbadrequest', 'flowactionexception', 'connectorrequestfailure',
    'connectoroperationnotfound', 'connectorpowerfxerror', 'aimodelactionbadrequest', 'aimodelactionrequesttimeout',
    'bingsearchfailed', 'connectedagentbotnotfound', 'connectedagentbotnotpublished', 'connectedagentauthmismatch',
    'connectedagentgptcomponentnotfound', 'connectedagentchainingnotsupported', 'dataversefileattachment429',
    'asyncresponsepayloadtoolarge', 'aipluginoperationnotfound', 'bindingkeynotfounderror',
  ],
};
const dyn = (list) => `dynamic([${list.map((c) => `"${c}"`).join(', ')}])`;

/**
 * Shared prelude. Resolves every conversation to exactly one agent:
 *   1. topic schema prefix (stable, survives renames), else
 *   2. the bot name on its messages, mapped to the schema seen with that name elsewhere, else
 *   3. the bot name itself;
 * then maps that name (or the bot name) to the inventory key.
 */
const prelude = (w) => String.raw`
let StartTime = datetime(${w.start});
let EndTime = datetime(${w.end});
let Alias = ${w.alias};
let Base = AppEvents
    | where TimeGenerated between (StartTime .. EndTime)
    | extend
        ConversationId = tostring(Properties["conversationId"]),
        RecipientName  = tostring(Properties["recipientName"]),
        FromName       = tostring(Properties["fromName"]),
        TopicId        = tostring(Properties["TopicId"]),
        TopicName      = tostring(Properties["TopicName"]),
        DesignMode     = tostring(Properties["DesignMode"]),
        ChannelId      = tostring(Properties["channelId"])
    | where isnotempty(ConversationId);
let ConvKeys = Base
    | extend Schema = extract(@"^(.+?)\.topic\.", 1, TopicId),
             BotName = case(Name == "BotMessageReceived", RecipientName, Name == "BotMessageSend", FromName, "")
    | summarize Schemas = make_set_if(Schema, isnotempty(Schema), 8), Names = make_set_if(BotName, isnotempty(BotName), 8) by ConversationId
    | extend Schema = tostring(array_sort_asc(Schemas)[0]), BotName = tostring(array_sort_asc(Names)[0])
    | where isnotempty(Schema) or isnotempty(BotName);
let NamePairs = ConvKeys
    | where isnotempty(Schema) and isnotempty(BotName)
    | summarize n = count() by BotName, Schema;
let NameToSchema = NamePairs
    | join kind=inner (NamePairs | summarize maxN = max(n) by BotName) on BotName
    | where n == maxN
    | summarize Learned = make_set(Schema, 8) by BotName
    | project BotName, LearnedSchema = tostring(array_sort_asc(Learned)[0]);
let AgentMap = ConvKeys
    | join kind=leftouter NameToSchema on BotName
    | extend RawKey = coalesce(Schema, LearnedSchema, BotName)
    | extend k1 = tolower(RawKey), k2 = tolower(BotName)
    | join kind=leftouter (Alias | project k1 = tolower(AliasKey), C1 = Canonical) on k1
    | join kind=leftouter (Alias | project k2 = tolower(AliasKey), C2 = Canonical) on k2
    | extend AgentId = coalesce(C1, C2, RawKey)
    | project ConversationId, AgentId, RawKey, ConvBotName = BotName;
let Events = Base | join kind=inner AgentMap on ConversationId;
let Conv = Events
    | extend ErrBlob = iff(Name == "OnErrorLog", tolower(tostring(Properties)), "")
    | extend IsJail = ErrBlob has_any (${dyn(CODES.jailbreak)}),
             IsIndirect = ErrBlob has_any (${dyn(CODES.indirect)}),
             IsHarmCode = ErrBlob has_any (${dyn(CODES.harmful)}),
             IsDlp = ErrBlob has_any (${dyn(CODES.dlp)}),
             IsDep = ErrBlob has_any (${dyn(CODES.dependency)}),
             IsFiltered = ErrBlob has "contentfiltered",
             IsEsc = TopicId has "Escalate" or TopicId has "Fallback" or TopicName in~ ("Escalate", "Fallback")
    | extend IsHarm = IsHarmCode or (IsFiltered and not(IsJail) and not(IsIndirect))
    | extend IsSafety = IsJail or IsIndirect or IsHarm or IsDlp
    | summarize
        UserMsgs = countif(Name == "BotMessageReceived"),
        BotMsgs = countif(Name == "BotMessageSend"),
        HealthErrors = countif(Name == "OnErrorLog" and not(IsSafety)),
        DepErrors = countif(Name == "OnErrorLog" and IsDep),
        Jail = countif(IsJail), Indirect = countif(IsIndirect), Harm = countif(IsHarm), Dlp = countif(IsDlp),
        Esc = countif(IsEsc),
        Errors = countif(Name == "OnErrorLog"),
        TestEvents = countif(DesignMode =~ "True"),
        Channel = take_anyif(ChannelId, isnotempty(ChannelId)),
        First = min(TimeGenerated), Last = max(TimeGenerated)
        by AgentId, ConversationId, RawKey, ConvBotName
    | extend Safety = Jail + Indirect + Harm + Dlp;
`;

const QUERIES = {
  summary: (w) => prelude(w) + String.raw`
Conv
| summarize
    Conversations = count(),
    Engaged = countif(UserMsgs > 0),
    Resolved = countif(UserMsgs > 0 and BotMsgs > 0 and HealthErrors == 0 and Esc == 0 and Safety == 0),
    HealthFailed = countif(UserMsgs > 0 and HealthErrors > 0),
    DependencyFailed = countif(UserMsgs > 0 and DepErrors > 0),
    Escalated = countif(UserMsgs > 0 and Esc > 0),
    Jailbreaks = sum(Jail), IndirectAttacks = sum(Indirect), DlpBlocks = sum(Dlp),
    HarmfulConversations = countif(UserMsgs > 0 and Harm > 0),
    ErrorEvents = sum(Errors),
    ProductionConversations = countif(TestEvents == 0),
    TestConversations = countif(TestEvents > 0),
    Channels = make_set_if(Channel, isnotempty(Channel), 10),
    BotNames = make_set_if(ConvBotName, isnotempty(ConvBotName), 5),
    RawKeys = make_set(RawKey, 5),
    FirstSeen = min(First), LastSeen = max(Last)
    by AgentId`,
  series: (w) => prelude(w) + String.raw`
Conv
| where UserMsgs > 0
| summarize
    Conversations = count(),
    Failed = countif(HealthErrors > 0),
    Blocked = countif(Safety > 0),
    Completed = countif(BotMsgs > 0 and HealthErrors == 0 and Esc == 0 and Safety == 0)
    by AgentId, Bucket = bin(First, ${w.days === 1 ? '1h' : '1d'})
| order by AgentId asc, Bucket asc`,
  turns: (w) => prelude(w) + String.raw`
Events
| where Name in ("BotMessageReceived", "BotMessageSend")
| project AgentId, ConversationId, Name, TimeGenerated
| sort by ConversationId asc, TimeGenerated asc, Name asc
| extend NextName = next(Name), NextConv = next(ConversationId), NextTime = next(TimeGenerated)
| where Name == "BotMessageReceived"
| extend Answered = NextConv == ConversationId and NextName == "BotMessageSend"
| extend LatencySec = iff(Answered, datetime_diff('millisecond', NextTime, TimeGenerated) / 1000.0, real(null))
| summarize
    UserTurns = count(),
    AnsweredTurns = countif(Answered),
    SlowTurns = countif(Answered and LatencySec > ${w.slow}),
    P95LatencySec = percentile(LatencySec, 95),
    P50LatencySec = percentile(LatencySec, 50)
    by AgentId`,
  errors: (w) => prelude(w) + String.raw`
Events
| where Name == "OnErrorLog"
| extend ErrorCode = tostring(Properties["ErrorCodeText"])
| where isnotempty(ErrorCode)
| summarize Count = count() by AgentId, ErrorCode`,
  // Only returns rows for agents instrumented with OpenTelemetry gen_ai.* (e.g. Foundry).
  cost: (w) => String.raw`
let StartTime = datetime(${w.start});
let EndTime = datetime(${w.end});
let Alias = ${w.alias};
union isfuzzy=true
    (AppDependencies | where TimeGenerated between (StartTime .. EndTime)),
    (datatable(TimeGenerated:datetime, Properties:dynamic, Success:bool)[])
| extend RawKey = coalesce(tostring(Properties["gen_ai.agent.name"]), tostring(Properties["gen_ai.agent.id"])),
         InTok = tolong(Properties["gen_ai.usage.input_tokens"]),
         OutTok = tolong(Properties["gen_ai.usage.output_tokens"]),
         Model = coalesce(tostring(Properties["gen_ai.response.model"]), tostring(Properties["gen_ai.request.model"]))
| where isnotempty(RawKey) and (isnotnull(InTok) or isnotnull(OutTok))
| extend k1 = tolower(RawKey)
| join kind=leftouter (Alias | project k1 = tolower(AliasKey), C1 = Canonical) on k1
| extend AgentId = coalesce(C1, RawKey)
| summarize InputTokens = sum(InTok), OutputTokens = sum(OutTok), ModelCalls = count(), FailedCalls = countif(Success == false)
    by AgentId, Model`,
};

async function runQuery(workspaceId, token, query) {
  const response = await fetch(`https://api.loganalytics.azure.com/v1/workspaces/${workspaceId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait=120' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(130000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.message || `Log Analytics returned HTTP ${response.status}`);
  const table = result.tables?.[0];
  if (!table) return [];
  return table.rows.map((row) => Object.fromEntries(table.columns.map((c, i) => [c.name, row[i]])));
}

const groupBy = (rows) => rows.reduce((acc, r) => ((acc[r.AgentId] ||= []).push(r), acc), {});
const byAgent = (rows) => Object.fromEntries(rows.map((r) => [r.AgentId, r]));

async function buildPayload(days) {
  const started = Date.now();
  const workspaceId = process.env.LOG_ANALYTICS_WORKSPACE_ID;
  if (!workspaceId) throw new Error('LOG_ANALYTICS_WORKSPACE_ID is not configured.');
  const config = readConfig();

  const inventory = await loadInventory(credential).catch((e) => ({ source: 'error', sourceLabel: e.message, records: [] }));
  const { map: aliasMap, clashes } = buildAliasMap(inventory.records);

  // One fixed window for every query (minute precision), so all figures describe the same period.
  const endMs = Math.floor(Date.now() / 60000) * 60000;
  const w = {
    days,
    start: new Date(endMs - days * 86400000).toISOString(),
    end: new Date(endMs).toISOString(),
    alias: aliasTable(aliasMap),
    slow: config.slowReplySeconds,
  };

  const { token } = await credential.getToken('https://api.loganalytics.io/.default');
  const q = (name) => runQuery(workspaceId, token, QUERIES[name](w));
  const soft = (p) => p.then((rows) => ({ ok: true, rows }), (e) => ({ ok: false, rows: [], error: e.message }));
  const [summary, turns, series, errors, costResult] = await Promise.all([q('summary'), q('turns'), q('series'), soft(q('errors')), soft(q('cost'))]);

  const turnsBy = byAgent(turns);
  const seriesBy = groupBy(series);
  const errorsBy = groupBy(errors.rows);
  const costBy = groupBy(costResult.rows);
  const now = endMs;

  const keys = new Set([...summary.map((r) => r.AgentId), ...Object.keys(costBy)]);
  const summaryBy = byAgent(summary);
  const agents = [...keys].map((key) => {
    const row = summaryBy[key] || { AgentId: key };
    row.TopErrorCodes = (errorsBy[key] || [])
      .sort((a, b) => b.Count - a.Count || a.ErrorCode.localeCompare(b.ErrorCode))
      .slice(0, 6)
      .map((e) => ({ code: e.ErrorCode, count: Number(e.Count) }));
    return buildAgent({
      key,
      row,
      turns: turnsBy[key],
      series: fillSeries(seriesBy[key] || [], w.start, w.end, days),
      costRows: costBy[key] || [],
      inv: matchInventory(inventory.records, key),
      days,
      now,
      config,
    });
  });

  // Registered agents with no telemetry in the period are still shown (grey) so gaps are visible.
  const seen = new Set(agents.map((a) => a.id.toLowerCase()));
  const silent = inventory.records
    .filter((r) => !seen.has(String(r.key).toLowerCase()))
    .map((inv) => buildAgent({ key: inv.key, row: {}, series: fillSeries([], w.start, w.end, days), inv, days, now, config }));

  return {
    mode: 'live',
    lookbackDays: days,
    window: { start: w.start, end: w.end },
    generatedAt: new Date(endMs).toISOString(),
    queryMs: Date.now() - started,
    sources: {
      telemetry: 'Application Insights (Log Analytics workspace)',
      inventory: inventory.source,
      inventoryLabel: inventory.sourceLabel,
      inventoryRecords: inventory.records.length,
      aliasClashes: clashes,
      costTelemetry: costResult.ok ? (costResult.rows.length ? 'connected' : 'no gen_ai token data') : 'unavailable',
      pricing: `Copilot Credits at $${config.creditPriceUsd}/credit · ${Object.keys(config.modelPrices).length ? 'custom' : 'default'} model price list`,
      slowReplySeconds: config.slowReplySeconds,
      creditsPerResponse: config.defaultCreditsPerResponse,
    },
    library: publicLibrary(),
    agents: sortAgents([...agents, ...silent]),
  };
}

// ---------------------------------------------------------------- handler
module.exports = async function (context, req) {
  const requested = Number(req?.query?.days || process.env.TELEMETRY_LOOKBACK_DAYS || 7);
  const days = ALLOWED_DAYS.includes(requested) ? requested : 7;
  const fresh = req?.query?.fresh === '1';
  try {
    const hit = cache.get(days);
    let body;
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) {
      body = { ...hit.body, cached: true };
    } else {
      body = await buildPayload(days);
      cache.set(days, { at: Date.now(), body });
    }
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body,
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

// Exposed for tests.
module.exports.QUERIES = QUERIES;
module.exports.aliasTable = aliasTable;
module.exports.kqlString = kqlString;
