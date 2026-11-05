/**
 * Optional AI system inventory (system of record) used to pre-fill agent
 * profiles when connecting an agent, and to fill gaps in a connected agent's
 * profile. It never decides WHICH agents are shown — the connected-agents
 * registry does (see registry.js).
 *
 *   INVENTORY_URL   – JSON endpoint (SharePoint list via Graph, Dataverse, OneTrust, ServiceNow…)
 *                     returning an array or { value: [...] }.
 *   INVENTORY_SCOPE – optional token scope for the API identity.
 *
 * There is deliberately no bundled stand-in file: in live mode everything shown
 * is live (the old agent-inventory.json template records were being displayed
 * as if they were real agents).
 */
const { isPlaceholder } = require('./registry');

const FIELD_MAP = {
  id: ['id', 'agentId', 'AgentId', 'schemaName'],
  aliases: ['aliases', 'telemetryIds'],
  displayName: ['displayName', 'name', 'Title', 'title'],
  purpose: ['purpose', 'Purpose', 'description', 'Description'],
  department: ['department', 'Department', 'businessUnit', 'BusinessUnit'],
  location: ['location', 'Location', 'region', 'Region'],
  businessOwner: ['businessOwner', 'BusinessOwner'],
  technicalOwner: ['technicalOwner', 'TechnicalOwner', 'systemOwner'],
  platform: ['platform', 'Platform'],
  riskTier: ['riskTier', 'RiskTier', 'risk_tier'],
  approvalStatus: ['approvalStatus', 'ApprovalStatus', 'governanceStatus'],
  productionSince: ['productionSince', 'ProductionSince', 'goLiveDate'],
  monthlyBudgetUsd: ['monthlyBudgetUsd', 'MonthlyBudgetUsd', 'budget'],
  billingModel: ['billingModel', 'BillingModel'],
  creditsPerResponse: ['creditsPerResponse', 'CreditsPerResponse'],
  allowedConnectors: ['allowedConnectors', 'AllowedConnectors'],
};

const clean = (v) => (v === undefined || v === null || v === '' || isPlaceholder(v) ? undefined : v);

function pick(record, aliases) {
  const src = record.fields || record; // Graph list items keep data under .fields
  for (const key of aliases) {
    const v = clean(src[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Normalises any inventory or registry record to the canonical profile shape. */
function normalise(record) {
  const out = {};
  for (const [field, aliases] of Object.entries(FIELD_MAP)) out[field] = pick(record, aliases);
  for (const listField of ['aliases', 'allowedConnectors']) {
    if (typeof out[listField] === 'string') out[listField] = out[listField].split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    out[listField] = (out[listField] || []).filter((v) => !isPlaceholder(v));
  }
  for (const n of ['monthlyBudgetUsd', 'creditsPerResponse']) {
    if (out[n] !== undefined) {
      out[n] = Number(out[n]);
      if (!Number.isFinite(out[n])) out[n] = undefined;
    }
  }
  out.key = out.id || out.aliases[0] || out.displayName;
  return out;
}

async function loadInventory(credential) {
  const url = process.env.INVENTORY_URL;
  if (!url) return { source: 'none', sourceLabel: 'Not connected (optional)', records: [] };
  const headers = { Accept: 'application/json' };
  if (process.env.INVENTORY_SCOPE) {
    const token = await credential.getToken(process.env.INVENTORY_SCOPE);
    headers.Authorization = `Bearer ${token.token}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Inventory source returned HTTP ${response.status}`);
  const body = await response.json();
  const records = Array.isArray(body) ? body : body.value || body.items || [];
  return { source: 'registry', sourceLabel: new URL(url).host, records: records.map(normalise).filter((r) => r.key) };
}

/** Every name that identifies a profile → its stable key. First record wins on a clash. */
function buildAliasMap(records) {
  const map = new Map();
  const clashes = [];
  for (const r of records) {
    for (const name of [r.key, r.id, r.displayName, ...(r.aliases || [])].filter(Boolean)) {
      const k = String(name).trim().toLowerCase();
      if (!k) continue;
      if (map.has(k) && map.get(k) !== r.key) clashes.push(name);
      else if (!map.has(k)) map.set(k, r.key);
    }
  }
  return { map, clashes };
}

/** Case-insensitive match on key, id, display name or any alias. */
function matchInventory(records, agentKey) {
  const key = String(agentKey || '').toLowerCase();
  return records.find((r) =>
    [r.key, r.id, r.displayName, ...(r.aliases || [])].filter(Boolean).some((v) => String(v).toLowerCase() === key)
  );
}

/** Registry values win; inventory only fills gaps. */
function mergeProfile(registryRecord, inventoryRecord) {
  const reg = normalise(registryRecord);
  if (!inventoryRecord) return { ...reg, notes: registryRecord.notes };
  const out = { ...inventoryRecord };
  for (const [k, v] of Object.entries(reg)) {
    if (Array.isArray(v) ? v.length : v !== undefined) out[k] = v;
  }
  out.aliases = [...new Set([...(reg.aliases || []), ...(inventoryRecord.aliases || [])])];
  out.key = reg.key;
  out.notes = registryRecord.notes;
  return out;
}

module.exports = { loadInventory, matchInventory, buildAliasMap, normalise, mergeProfile, isPlaceholder };
