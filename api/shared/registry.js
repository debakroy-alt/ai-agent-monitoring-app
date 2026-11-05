/**
 * Connected-agents registry — the single source of truth for WHICH agents the
 * dashboard monitors and their profile (name, purpose, department, owners,
 * risk tier, approval, budget…).
 *
 * Only agents in this registry are counted and shown as "connected". Agents
 * that send telemetry but are not in the registry are listed as "discovered"
 * on the Manage agents page, where they can be connected with one click.
 *
 * Storage (one small JSON document):
 *   1. REGISTRY_BLOB_SAS_URL – URL of a blob with a SAS token (read/write/create).
 *                              Simplest option; no role assignment needed.
 *   2. REGISTRY_BLOB_URL     – plain blob URL; the API signs in with the same identity it
 *                              uses for Log Analytics (needs "Storage Blob Data Contributor").
 *   3. Local file            – api/data/connected-agents.json (or REGISTRY_FILE). For local
 *                              development only: Azure-hosted functions run from a read-only
 *                              package, so changes would not be saved there.
 *
 * Writes use optimistic concurrency (ETag / If-Match) so two people saving at
 * the same time cannot silently overwrite each other.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCAL_FILE = process.env.REGISTRY_FILE || path.join(__dirname, '..', 'data', 'connected-agents.json');
const BLOB_VERSION = '2021-08-06';
const RUNNING_IN_AZURE = !!process.env.WEBSITE_INSTANCE_ID;

const RISK_TIERS = ['Low', 'Medium', 'High'];
const BILLING_MODELS = ['copilot-credits', 'm365-copilot', 'tokens'];
const isPlaceholder = (v) => typeof v === 'string' && /^REPLACE_WITH/i.test(v.trim());

function storageInfo() {
  if (process.env.REGISTRY_BLOB_SAS_URL) {
    const u = new URL(process.env.REGISTRY_BLOB_SAS_URL);
    return { type: 'blob', auth: 'sas', label: `Azure Blob · ${u.host}${u.pathname}`, persistent: true };
  }
  if (process.env.REGISTRY_BLOB_URL) {
    const u = new URL(process.env.REGISTRY_BLOB_URL);
    return { type: 'blob', auth: 'identity', label: `Azure Blob · ${u.host}${u.pathname}`, persistent: true };
  }
  return {
    type: 'file',
    label: `Local file · ${path.basename(LOCAL_FILE)}`,
    persistent: !RUNNING_IN_AZURE,
    warning: RUNNING_IN_AZURE
      ? 'Connected agents are stored in a local file, which Azure does not keep. Set REGISTRY_BLOB_SAS_URL to store them permanently.'
      : null,
  };
}

class RegistryError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------------ storage
async function blobHeaders(credential, extra = {}) {
  const h = { 'x-ms-version': BLOB_VERSION, ...extra };
  if (!process.env.REGISTRY_BLOB_SAS_URL) {
    if (!credential) throw new RegistryError('No identity available to access the registry blob.');
    const { token } = await credential.getToken('https://storage.azure.com/.default');
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}
const blobUrl = () => process.env.REGISTRY_BLOB_SAS_URL || process.env.REGISTRY_BLOB_URL;

async function readRaw(credential) {
  const info = storageInfo();
  if (info.type === 'blob') {
    const res = await fetch(blobUrl(), { headers: await blobHeaders(credential), signal: AbortSignal.timeout(15000) });
    if (res.status === 404) return { doc: null, etag: null };
    if (!res.ok) throw new RegistryError(`Registry blob returned HTTP ${res.status}${res.status === 403 ? ' (check the SAS token or the Storage Blob Data Contributor role)' : ''}`);
    return { doc: JSON.parse((await res.text()) || 'null'), etag: res.headers.get('etag') };
  }
  if (!fs.existsSync(LOCAL_FILE)) return { doc: null, etag: null };
  const text = fs.readFileSync(LOCAL_FILE, 'utf8');
  return { doc: JSON.parse(text || 'null'), etag: crypto.createHash('sha1').update(text).digest('hex') };
}

async function writeRaw(doc, etag, credential) {
  const body = JSON.stringify(doc, null, 2);
  const info = storageInfo();
  if (info.type === 'blob') {
    const headers = await blobHeaders(credential, {
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': 'application/json',
      ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
    });
    const res = await fetch(blobUrl(), { method: 'PUT', headers, body, signal: AbortSignal.timeout(15000) });
    if (res.status === 412 || res.status === 409) return false; // someone else saved first
    if (!res.ok) throw new RegistryError(`Saving the registry failed (HTTP ${res.status})`);
    return true;
  }
  const current = fs.existsSync(LOCAL_FILE) ? crypto.createHash('sha1').update(fs.readFileSync(LOCAL_FILE, 'utf8')).digest('hex') : null;
  if (current !== etag) return false;
  try {
    fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
    const tmp = `${LOCAL_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, LOCAL_FILE);
  } catch (e) {
    throw new RegistryError(
      RUNNING_IN_AZURE
        ? 'Cannot save: the API runs from a read-only package in Azure. Set REGISTRY_BLOB_SAS_URL (see CHANGES.md).'
        : `Cannot save the registry file: ${e.message}`
    );
  }
  return true;
}

// -------------------------------------------------------------- validation
const str = (v, max = 200) => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().slice(0, max);
  return s && !isPlaceholder(s) ? s : undefined;
};
const list = (v, max = 20) =>
  [...new Set((Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[;,\n]/) : []).map((x) => str(x, 200)).filter(Boolean))].slice(0, max);
const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) || Number(v) < 0 ? undefined : Number(v));

/** Cleans user input into a registry record. Throws RegistryError(400) when invalid. */
function sanitise(input) {
  const r = {
    id: str(input.id, 200),
    displayName: str(input.displayName, 120),
    aliases: list(input.aliases),
    purpose: str(input.purpose, 500),
    department: str(input.department, 80),
    location: str(input.location, 80),
    businessOwner: str(input.businessOwner, 120),
    technicalOwner: str(input.technicalOwner, 120),
    platform: str(input.platform, 80) || 'Microsoft Copilot Studio',
    riskTier: RISK_TIERS.find((t) => t.toLowerCase() === String(input.riskTier || '').toLowerCase()),
    approvalStatus: str(input.approvalStatus, 40),
    productionSince: /^\d{4}-\d{2}-\d{2}$/.test(String(input.productionSince || '')) ? input.productionSince : undefined,
    monthlyBudgetUsd: num(input.monthlyBudgetUsd),
    billingModel: BILLING_MODELS.includes(input.billingModel) ? input.billingModel : undefined,
    creditsPerResponse: num(input.creditsPerResponse),
    allowedConnectors: list(input.allowedConnectors),
    notes: str(input.notes, 1000),
  };
  if (!r.id) throw new RegistryError('Telemetry ID is required — the agent name or schema name as it appears in Application Insights.', 400);
  r.aliases = r.aliases.filter((a) => a.toLowerCase() !== r.id.toLowerCase());
  if (!r.displayName) r.displayName = r.aliases[0] || r.id;
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined));
}

const namesOf = (r) => [r.id, r.displayName, ...(r.aliases || [])].filter(Boolean).map((n) => n.toLowerCase());

// ------------------------------------------------------------------ API
async function loadRegistry(credential) {
  const { doc, etag } = await readRaw(credential);
  const agents = Array.isArray(doc?.agents) ? doc.agents.filter((a) => a && a.id && !isPlaceholder(a.id)) : [];
  return { agents, etag, updatedAt: doc?.updatedAt || null, storage: storageInfo() };
}

/** Applies `mutate(agents)` with up to 3 optimistic-concurrency retries. */
async function updateRegistry(credential, mutate, user) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { doc, etag } = await readRaw(credential);
    const agents = Array.isArray(doc?.agents) ? doc.agents.map((a) => ({ ...a })) : [];
    const result = mutate(agents);
    const next = { version: 1, updatedAt: new Date().toISOString(), updatedBy: user || 'anonymous', agents };
    if (await writeRaw(next, etag, credential)) return { agents, result };
  }
  throw new RegistryError('Someone else changed the agent list at the same time. Please try again.', 409);
}

function connect(agents, input, { user, allowUpdate }) {
  const rec = sanitise(input);
  const idx = agents.findIndex((a) => a.id.toLowerCase() === rec.id.toLowerCase());
  if (idx >= 0 && !allowUpdate) throw new RegistryError(`“${rec.displayName}” is already connected.`, 409);
  const mine = new Set(namesOf(rec));
  const clash = agents.find((a, i) => i !== idx && namesOf(a).some((n) => mine.has(n)));
  if (clash) throw new RegistryError(`A name or alias is already used by the connected agent “${clash.displayName || clash.id}”.`, 409);
  const now = new Date().toISOString();
  if (idx >= 0) {
    agents[idx] = { ...rec, connectedAt: agents[idx].connectedAt, connectedBy: agents[idx].connectedBy, updatedAt: now, updatedBy: user };
    return agents[idx];
  }
  const created = { ...rec, connectedAt: now, connectedBy: user, updatedAt: now, updatedBy: user };
  agents.push(created);
  return created;
}

function disconnect(agents, id) {
  const idx = agents.findIndex((a) => a.id.toLowerCase() === String(id || '').toLowerCase());
  if (idx < 0) throw new RegistryError('That agent is not connected.', 404);
  return agents.splice(idx, 1)[0];
}

module.exports = { loadRegistry, updateRegistry, connect, disconnect, sanitise, storageInfo, RegistryError, isPlaceholder };
