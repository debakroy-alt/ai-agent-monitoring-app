/**
 * GET /api/agents?days=7[&fresh=1]
 *
 * Every agent that sends telemetry to Application Insights is monitored
 * automatically — nothing has to be "connected" first.
 *
 *   - Agents are found in the extended window (EXTENDED_LOOKBACK_DAYS, default 90 days),
 *     so an agent never disappears just because it was quiet in the selected period.
 *   - Figures use the selected period. If an agent had no activity in that period, its
 *     figures fall back to the extended window and are labelled as such (widened: true).
 *   - Saved profiles (name, department, owners, budget…) are optional and only add context.
 *   - Agents the user removed are listed separately (removed) and can be restored.
 *
 * Everything returned is live. No demo or template data is ever mixed in.
 */
const { DefaultAzureCredential } = require('@azure/identity');
const { publicLibrary } = require('../shared/metrics-registry');
const { loadInventory, matchInventory, buildAliasMap, mergeProfile, normalise } = require('../shared/inventory');
const { loadRegistry } = require('../shared/registry');
const { buildAgent, fillSeries, sortAgents, prettyName, DEFAULT_CONFIG } = require('../shared/build-agent');

const ALLOWED_DAYS = [1, 7, 30, 90];
const EXTENDED_DAYS = Math.max(90, Number(process.env.EXTENDED_LOOKBACK_DAYS || 90));
const CACHE_MS = Number(process.env.CACHE_SECONDS || 60) * 1000;

function readConfig() {
  const modelPrices = {};
  try {
    Object.assign(modelPrices, JSON.parse(process.env.MODEL_PRICES_JSON || '{}'));
  } catch {
    /* malformed JSON: defaults apply */
  }
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
const cache = new Map();

// ------------------------------------------------------------------ KQL
const kqlString = (s) => `'${String(s).replace(/[\r\n\t]/g, ' ').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function aliasTable(aliasMap) {
  const rows = [...aliasMap.entries()].map(([k, v]) => `${kqlString(k)}, ${kqlString(v)}`);
  return `datatable(AliasKey:string, Canonical:string)[${rows.join(',\n  ')}]`;
}

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
 * Shared prelude. Resolves every conversation to exactly one agent, then classifies it:
 *   - chat conversation: the user sent at least one "message" activity
 *   - automatic run:     no user message, but the agent was triggered (event/invoke activity)
 *                        or ran a real topic / hit an error (e.g. scheduled or event-triggered agents)
 *   - greeting only:     neither of the above (not counted as activity)
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
        ChannelId      = tostring(Properties["channelId"]),
        ActivityType   = tolower(coalesce(tostring(Properties["activityType"]), tostring(Properties["type"])))
    | where isnotempty(ConversationId)
    | extend IsMessage = isempty(ActivityType) or ActivityType == "message"
    | extend IsUserMsg = Name == "BotMessageReceived" and IsMessage,
             IsBotMsg  = Name == "BotMessageSend" and IsMessage,
             IsTrigger = Name == "BotMessageReceived" and ActivityType in ("event", "invoke"),
             IsRealTopic = isnotempty(TopicId)
                 and not(TopicId has "ConversationStart" or TopicId has "Greeting" or TopicName in~ ("Conversation Start", "ConversationStart", "Greeting"));
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
        UserMsgs = countif(IsUserMsg),
        BotMsgs = countif(IsBotMsg),
        Triggers = countif(IsTrigger),
        RealTopics = countif(IsRealTopic),
        HealthErrors = countif(Name == "OnErrorLog" and not(IsSafety)),
        DepErrors = countif(Name == "OnErrorLog" and IsDep),
        Jail = countif(IsJail), Indirect = countif(IsIndirect), Harm = countif(IsHarm), Dlp = countif(IsDlp),
        Esc = countif(IsEsc),
        Errors = countif(Name == "OnErrorLog"),
        TestEvents = countif(DesignMode =~ "True"),
        Channel = take_anyif(ChannelId, isnotempty(ChannelId)),
        First = min(TimeGenerated), Last = max(TimeGenerated)
        by AgentId, ConversationId, RawKey, ConvBotName
    | extend Safety = Jail + Indirect + Harm + Dlp
    | extend IsChat = UserMsgs > 0
    | extend IsAuto = not(IsChat) and (Triggers > 0 or RealTopics > 0 or Errors > 0)
    | extend IsRun = IsChat or IsAuto
    | extend IsResolved = IsRun and HealthErrors == 0 and Esc == 0 and Safety == 0 and (BotMsgs > 0 or not(IsChat));
`;

const QUERIES = {
  summary: (w) => prelude(w) + String.raw`
Conv
| summarize
    Conversations = count(),
    Engaged = countif(IsRun),
    AutoRuns = countif(IsAuto),
    Resolved = countif(IsResolved),
    HealthFailed = countif(IsRun and HealthErrors > 0),
    DependencyFailed = countif(IsRun and DepErrors > 0),
    Escalated = countif(IsRun and Esc > 0),
    Jailbreaks = sum(Jail), IndirectAttacks = sum(Indirect), DlpBlocks = sum(Dlp),
    HarmfulConversations = countif(IsRun and Harm > 0),
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
| where IsRun
| summarize
    Conversations = count(),
    Failed = countif(HealthErrors > 0),
    Blocked = countif(Safety > 0),
    Completed = countif(IsResolved)
    by AgentId, Bucket = bin(First, ${w.days === 1 ? '1h' : '1d'})
| order by AgentId asc, Bucket asc`,
  turns: (w) => prelude(w) + String.raw`
Events
| where IsUserMsg or IsBotMsg
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

/** Log Analytics returns `dynamic` columns (arrays) as JSON text. */
function parseCell(value, type) {
  if (type !== 'dynamic' || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stageError(stage, message) {
  const e = new Error(`${stage}: ${message}`);
  e.stage = stage;
  return e;
}

async function runQuery(workspaceId, token, query, name) {
  let response;
  try {
    response = await fetch(`https://api.loganalytics.azure.com/v1/workspaces/${workspaceId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait=120' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(130000),
    });
  } catch (e) {
    throw stageError(`query "${name}"`, e.name === 'TimeoutError' ? 'timed out' : e.message);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const inner = result?.error?.innererror?.message || result?.error?.details?.[0]?.innererror?.message;
    throw stageError(`query "${name}"`, `${result?.error?.message || `HTTP ${response.status}`}${inner ? ` — ${inner}` : ''}`);
  }
  const table = result.tables?.[0];
  if (!table) return [];
  return table.rows.map((row) => Object.fromEntries(table.columns.map((c, i) => [c.name, parseCell(row[i], c.type)])));
}

const groupBy = (rows) => rows.reduce((acc, r) => ((acc[r.AgentId] ||= []).push(r), acc), {});
const byAgent = (rows) => Object.fromEntries(rows.map((r) => [r.AgentId, r]));
const asArray = (v) => (Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : [v]);
const lower = (s) => String(s || '').toLowerCase();

/** Runs the full query set for one time window and indexes the results by agent. */
async function queryWindow(workspaceId, token, w) {
  const q = (name) => runQuery(workspaceId, token, QUERIES[name](w), `${name}${w.days === EXTENDED_DAYS && w.extended ? ` (${EXTENDED_DAYS} days)` : ''}`);
  const soft = (p) => p.then((rows) => ({ ok: true, rows }), (e) => ({ ok: false, rows: [], error: e.message }));
  const [summary, turns, series, errors, cost] = await Promise.all([q('summary'), q('turns'), q('series'), soft(q('errors')), soft(q('cost'))]);
  const errorsBy = groupBy(errors.rows);
  const summaryBy = byAgent(summary);
  const rowFor = (key) => {
    const row = { ...(summaryBy[key] || { AgentId: key }) };
    for (const col of ['Channels', 'BotNames', 'RawKeys']) row[col] = asArray(row[col]);
    row.TopErrorCodes = (errorsBy[key] || [])
      .sort((a, b) => b.Count - a.Count || String(a.ErrorCode).localeCompare(String(b.ErrorCode)))
      .slice(0, 6)
      .map((e) => ({ code: e.ErrorCode, count: Number(e.Count) }));
    return row;
  };
  return {
    w,
    keys: new Set([...summary.map((r) => r.AgentId), ...cost.rows.map((r) => r.AgentId)].filter(Boolean)),
    has: (key) => !!summaryBy[key] || cost.rows.some((r) => r.AgentId === key),
    rowFor,
    turnsBy: byAgent(turns),
    seriesBy: groupBy(series),
    costBy: groupBy(cost.rows),
    costOk: cost.ok,
  };
}

async function buildPayload(days, registry) {
  const started = Date.now();
  const workspaceId = process.env.LOG_ANALYTICS_WORKSPACE_ID;
  if (!workspaceId) throw stageError('configuration', 'LOG_ANALYTICS_WORKSPACE_ID is not set');
  const config = readConfig();

  const inventory = await loadInventory(credential).catch((e) => ({ source: 'error', sourceLabel: e.message, records: [] }));
  const saved = registry.agents.map((r) => normalise(r));
  // Saved profiles first so their names always win; inventory only helps group names.
  const { map: aliasMap, clashes } = buildAliasMap([...saved, ...inventory.records]);
  const alias = aliasTable(aliasMap);

  const endMs = Math.floor(Date.now() / 60000) * 60000;
  const mkWindow = (d, extended = false) => ({
    days: d,
    extended,
    start: new Date(endMs - d * 86400000).toISOString(),
    end: new Date(endMs).toISOString(),
    alias,
    slow: config.slowReplySeconds,
  });

  let token;
  try {
    ({ token } = await credential.getToken('https://api.loganalytics.io/.default'));
  } catch (e) {
    throw stageError('sign-in to Log Analytics', e.message);
  }

  const needExtended = days < EXTENDED_DAYS;
  const [period, extended] = await Promise.all([
    queryWindow(workspaceId, token, mkWindow(days)),
    needExtended ? queryWindow(workspaceId, token, mkWindow(EXTENDED_DAYS, true)) : null,
  ]);
  const wide = extended || period;

  try {
    // Every agent seen in telemetry (extended window) + agents with a saved profile.
    const allKeys = new Map(); // lower -> key
    for (const k of [...wide.keys, ...period.keys]) if (!allKeys.has(lower(k))) allKeys.set(lower(k), k);
    for (const s of saved) if (!allKeys.has(lower(s.key))) allKeys.set(lower(s.key), s.key);
    const removedSet = new Set(registry.removed.map(lower));

    const build = (key) => {
      const profile = mergeProfile(registry.agents.find((a) => lower(a.id) === lower(key)), matchInventory(inventory.records, key));
      const usePeriod = period.has(key) && Number(period.rowFor(key).Conversations || 0) > 0;
      const src = usePeriod || !extended || !extended.has(key) ? period : extended;
      return buildAgent({
        key,
        row: src.rowFor(key),
        turns: src.turnsBy[key],
        series: fillSeries(src.seriesBy[key] || [], src.w.start, src.w.end, src.w.days),
        costRows: src.costBy[key] || [],
        profile,
        days: src.w.days,
        selectedDays: days,
        now: endMs,
        config,
      });
    };

    const agents = [];
    const removed = [];
    for (const key of allKeys.values()) {
      if (removedSet.has(lower(key))) {
        const row = wide.has(key) ? wide.rowFor(key) : {};
        const prof = registry.agents.find((a) => lower(a.id) === lower(key));
        removed.push({ id: key, name: prof?.displayName || asArray(row.BotNames).find((n) => lower(n) !== lower(key)) || prettyName(key), lastSeen: row.LastSeen || null, runs: Number(row.Engaged || 0) });
      } else {
        agents.push(build(key));
      }
    }
    removed.sort((a, b) => a.name.localeCompare(b.name));

    return {
      mode: 'live',
      lookbackDays: days,
      extendedDays: EXTENDED_DAYS,
      window: { start: period.w.start, end: period.w.end },
      generatedAt: new Date(endMs).toISOString(),
      queryMs: Date.now() - started,
      sources: {
        telemetry: 'Application Insights (Log Analytics workspace)',
        registry: registry.storage,
        registryUpdatedAt: registry.updatedAt,
        savedProfiles: registry.agents.length,
        inventory: inventory.source,
        inventoryLabel: inventory.sourceLabel,
        aliasClashes: clashes,
        costTelemetry: period.costOk ? (period.costBy && Object.keys(period.costBy).length ? 'connected' : 'no gen_ai token data') : 'unavailable',
        pricing: `Copilot Credits at $${config.creditPriceUsd}/credit · ${process.env.MODEL_PRICES_JSON ? 'custom' : 'default'} model price list`,
        slowReplySeconds: config.slowReplySeconds,
        creditsPerResponse: config.defaultCreditsPerResponse,
      },
      library: publicLibrary(),
      agents: sortAgents(agents),
      removed,
    };
  } catch (e) {
    throw e.stage ? e : stageError('processing the results', e.message);
  }
}

// ---------------------------------------------------------------- handler
module.exports = async function (context, req) {
  const requested = Number(req?.query?.days || process.env.TELEMETRY_LOOKBACK_DAYS || 7);
  const days = ALLOWED_DAYS.includes(requested) ? requested : 7;
  const fresh = req?.query?.fresh === '1';
  try {
    let registry;
    try {
      registry = await loadRegistry(credential);
    } catch (e) {
      // Settings are optional: never block monitoring because they can't be read.
      context.log.warn?.('Agent settings could not be loaded; continuing without them.', e.message);
      registry = { agents: [], removed: [], etag: 'unavailable', updatedAt: null, storage: { type: 'error', label: 'Unavailable', warning: `Agent settings could not be loaded (${e.message}). All agents are shown without saved profiles.` } };
    }
    const cacheKey = `${days}|${registry.etag || 'empty'}`;
    const hit = cache.get(cacheKey);
    let body;
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) {
      body = { ...hit.body, cached: true };
    } else {
      body = await buildPayload(days, registry);
      for (const k of cache.keys()) if (k.startsWith(`${days}|`)) cache.delete(k);
      cache.set(cacheKey, { at: Date.now(), body });
    }
    context.res = { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body };
  } catch (error) {
    context.log.error('Live telemetry query failed.', error);
    const showDetail = process.env.SHOW_ERROR_DETAILS === 'true' || process.env.NODE_ENV === 'development';
    context.res = {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: {
        mode: 'error',
        message: showDetail ? error.message : `Failed at: ${error.stage || 'unexpected error'}. See the Function logs for details.`,
        stage: error.stage || 'unexpected',
      },
    };
  }
};

module.exports.QUERIES = QUERIES;
module.exports.aliasTable = aliasTable;
module.exports.kqlString = kqlString;
module.exports.parseCell = parseCell;
