/**
 * AI system inventory adapter.
 *
 * Derek: "Agent name, purpose, biz and tech owners, and in production
 * information can be obtained from an AI system inventory."
 *
 * Source priority:
 *   1. INVENTORY_URL  – JSON endpoint of the system of record (SharePoint list via
 *                       Graph, Dataverse, OneTrust, ServiceNow…). Called server-side
 *                       with a managed-identity token when INVENTORY_SCOPE is set.
 *   2. agent-inventory.json – bundled stand-in used until the registry is connected.
 *                       Flagged as such on the Data Checks tab.
 *
 * The endpoint must return either an array of records or { value: [...] } (Graph/Dataverse style).
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
  allowedConnectors: ['allowedConnectors', 'AllowedConnectors'],
  tags: ['tags', 'Tags'],
};

function pick(record, aliases) {
  const src = record.fields || record; // Graph list items keep data under .fields
  for (const key of aliases) if (src[key] !== undefined && src[key] !== null && src[key] !== '') return src[key];
  return undefined;
}

function normalise(record) {
  const out = {};
  for (const [field, aliases] of Object.entries(FIELD_MAP)) out[field] = pick(record, aliases);
  for (const listField of ['aliases', 'allowedConnectors', 'tags']) {
    if (typeof out[listField] === 'string') out[listField] = out[listField].split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    out[listField] = out[listField] || [];
  }
  if (out.monthlyBudgetUsd !== undefined) out.monthlyBudgetUsd = Number(out.monthlyBudgetUsd);
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
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`Inventory source returned HTTP ${response.status}`);
    const body = await response.json();
    const records = Array.isArray(body) ? body : body.value || body.items || [];
    return { source: 'registry', sourceLabel: new URL(url).host, records: records.map(normalise) };
  }
  const file = path.join(__dirname, 'agent-inventory.json');
  const records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  return { source: 'file', sourceLabel: 'agent-inventory.json (stand-in)', records: records.map(normalise) };
}

/** Case-insensitive match on id, display name or any alias. */
function matchInventory(records, agentId) {
  const key = String(agentId || '').toLowerCase();
  return records.find((r) =>
    [r.id, r.displayName, ...(r.aliases || [])].filter(Boolean).some((v) => String(v).toLowerCase() === key)
  );
}

module.exports = { loadInventory, matchInventory };
