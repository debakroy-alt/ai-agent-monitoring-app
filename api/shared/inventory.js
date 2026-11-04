/**
 * AI system inventory adapter.
 *
 * Agent name, purpose, business and technical owners, risk tier, approval and
 * production information come from the AI system inventory.
 *
 * Source priority:
 *   1. INVENTORY_URL  – JSON endpoint of the system of record (SharePoint list via
 *                       Graph, Dataverse, OneTrust, ServiceNow…). Called server-side
 *                       with a managed-identity token when INVENTORY_SCOPE is set.
 *   2. agent-inventory.json – bundled stand-in used until the registry is connected.
 *                       Flagged as such on the Data sources tab.
 *
 * The endpoint must return either an array of records or { value: [...] } (Graph/Dataverse style).
 *
 * Every record gets a stable `key`. All telemetry names that belong to the same
 * agent (schema name, display name, aliases) are mapped to that key inside the
 * KQL queries, so one agent can never appear twice or swap identity between
 * refreshes.
 */
const path = require('path');
const fs = require('fs');

const FIELD_MAP = {
  // canonical field  : accepted aliases from common inventory systems
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
  tags: ['tags', 'Tags'],
};

/** Values such as "REPLACE_WITH_BUSINESS_OWNER" are template placeholders, not data. */
const isPlaceholder = (v) => typeof v === 'string' && /^REPLACE_WITH/i.test(v.trim());
const clean = (v) => (v === undefined || v === null || v === '' || isPlaceholder(v) ? undefined : v);

function pick(record, aliases) {
  const src = record.fields || record; // Graph list items keep data under .fields
  for (const key of aliases) {
    const v = clean(src[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function normalise(record) {
  const out = {};
  for (const [field, aliases] of Object.entries(FIELD_MAP)) out[field] = pick(record, aliases);
  for (const listField of ['aliases', 'allowedConnectors', 'tags']) {
    if (typeof out[listField] === 'string') out[listField] = out[listField].split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    out[listField] = (out[listField] || []).filter((v) => !isPlaceholder(v));
  }
  for (const n of ['monthlyBudgetUsd', 'creditsPerResponse']) {
    if (out[n] !== undefined) {
      out[n] = Number(out[n]);
      if (!Number.isFinite(out[n])) out[n] = undefined;
    }
  }
  // Stable key: inventory id, else first alias, else display name.
  out.key = out.id || out.aliases[0] || out.displayName;
  return out;
}

async function loadInventory(credential) {
  const url = process.env.INVENTORY_URL;
  if (url) {
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
  const file = path.join(__dirname, 'agent-inventory.json');
  const records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  return { source: 'file', sourceLabel: 'agent-inventory.json (stand-in)', records: records.map(normalise).filter((r) => r.key) };
}

/**
 * Every name that identifies an inventory record → its stable key.
 * Lower-cased; first record wins on a clash (clashes are reported on Data sources).
 */
function buildAliasMap(records) {
  const map = new Map();
  const clashes = [];
  for (const r of records) {
    for (const name of [r.id, r.displayName, ...(r.aliases || [])].filter(Boolean)) {
      const k = String(name).trim().toLowerCase();
      if (!k) continue;
      if (map.has(k) && map.get(k) !== r.key) clashes.push(name);
      else map.set(k, r.key);
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

module.exports = { loadInventory, matchInventory, buildAliasMap, normalise, isPlaceholder };
