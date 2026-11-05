/**
 * Agent settings store.
 *
 * Every agent that sends telemetry is monitored AUTOMATICALLY. This store only keeps:
 *   agents  – optional profiles (display name, purpose, department, owners, risk tier,
 *             approval, budget…) and agents added by hand before they send telemetry
 *   removed – telemetry IDs the user chose to stop monitoring (can be restored)
 *
 * Storage (one small JSON document):
 *   1. REGISTRY_BLOB_SAS_URL – blob URL with a SAS token (read/write/create). Recommended in Azure.
 *   2. REGISTRY_BLOB_URL     – plain blob URL; the API identity needs "Storage Blob Data Contributor".
 *   3. Local file            – api/data/connected-agents.json (or REGISTRY_FILE). If that folder is
 *                              read-only (Azure runs the API from a package), the system temp folder
 *                              is used instead — changes then work but are lost when the API restarts.
 *
 * Writes use optimistic concurrency (ETag / If-Match) so simultaneous saves can't overwrite each other.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PRIMARY_FILE = process.env.REGISTRY_FILE || path.join(__dirname, '..', 'data', 'connected-agents.json');
const TEMP_FILE = path.join(os.tmpdir(), 'ai-agent-dashboard', 'connected-agents.json');
const BLOB_VERSION = '2021-08-06';

const RISK_TIERS = ['Low', 'Medium', 'High'];
const BILLING_MODELS = ['copilot-credits', 'm365-copilot', 'tokens'];
const isPlaceholder = (v) => typeof v === 'string' && /^REPLACE_WITH/i.test(v.trim());

class RegistryError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------ local file
let localFile = null; // chosen on first use
function canWrite(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const probe = `${file}.probe`;
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
function chooseLocalFile() {
  if (localFile) return localFile;
  if (canWrite(PRIMARY_FILE)) localFile = PRIMARY_FILE;
  else {
    localFile = TEMP_FILE;
    // Seed the temp copy from the packaged file, if one was deployed.
    if (!fs.existsSync(TEMP_FILE) && fs.existsSync(PRIMARY_FILE)) {
      fs.mkdirSync(path.dirname(TEMP_FILE), { recursive: true });
      fs.copyFileSync(PRIMARY_FILE, TEMP_FILE);
    }
  }
  return localFile;
}

function storageInfo() {
  if (process.env.REGISTRY_BLOB_SAS_URL || process.env.REGISTRY_BLOB_URL) {
    const u = new URL(process.env.REGISTRY_BLOB_SAS_URL || process.env.REGISTRY_BLOB_URL);
    return { type: 'blob', label: `Azure Blob · ${u.host}${u.pathname}`, persistent: true };
  }
  const file = chooseLocalFile();
  const temp = file === TEMP_FILE;
  return {
    type: 'file',
    label: `${temp ? 'Temporary file' : 'Local file'} · ${path.basename(file)}`,
    persistent: !temp,
    warning: temp
      ? 'Agent profiles and removals are saved in a temporary file and will be lost when the API restarts. Set REGISTRY_BLOB_SAS_URL to keep them. (Monitoring itself is not affected.)'
      : null,
  };
}

// ------------------------------------------------------------------ storage
async function blobHeaders(credential, extra = {}) {
  const h = { 'x-ms-version': BLOB_VERSION, ...extra };
  if (!process.env.REGISTRY_BLOB_SAS_URL) {
    const { token } = await credential.getToken('https://storage.azure.com/.default');
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}
const blobUrl = () => process.env.REGISTRY_BLOB_SAS_URL || process.env.REGISTRY_BLOB_URL;
const hash = (text) => crypto.createHash('sha1').update(text).digest('hex');

async function readRaw(credential) {
  if (storageInfo().type === 'blob') {
    const res = await fetch(blobUrl(), { headers: await blobHeaders(credential), signal: AbortSignal.timeout(15000) });
    if (res.status === 404) return { doc: null, etag: null };
    if (!res.ok) throw new RegistryError(`Agent settings storage returned HTTP ${res.status}${res.status === 403 ? ' (check the SAS token or role assignment)' : ''}`);
    return { doc: JSON.parse((await res.text()) || 'null'), etag: res.headers.get('etag') };
  }
  const file = chooseLocalFile();
  if (!fs.existsSync(file)) return { doc: null, etag: null };
  const text = fs.readFileSync(file, 'utf8');
  return { doc: JSON.parse(text || 'null'), etag: hash(text) };
}

async function writeRaw(doc, etag, credential) {
  const body = JSON.stringify(doc, null, 2);
  if (storageInfo().type === 'blob') {
    const headers = await blobHeaders(credential, {
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': 'application/json',
      ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
    });
    const res = await fetch(blobUrl(), { method: 'PUT', headers, body, signal: AbortSignal.timeout(15000) });
    if (res.status === 412 || res.status === 409) return false;
    if (!res.ok) throw new RegistryError(`Saving agent settings failed (HTTP ${res.status})`);
    return true;
  }
  const file = chooseLocalFile();
  const current = fs.existsSync(file) ? hash(fs.readFileSync(file, 'utf8')) : null;
  if (current !== etag) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (e) {
    throw new RegistryError(`Cannot save agent settings: ${e.message}`);
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
    platform: str(input.platform, 80),
    riskTier: RISK_TIERS.find((t) => t.toLowerCase() === String(input.riskTier || '').toLowerCase()),
    approvalStatus: str(input.approvalStatus, 40),
    productionSince: /^\d{4}-\d{2}-\d{2}$/.test(String(input.productionSince || '')) ? input.productionSince : undefined,
    monthlyBudgetUsd: num(input.monthlyBudgetUsd),
    billingModel: BILLING_MODELS.includes(input.billingModel) ? input.billingModel : undefined,
    creditsPerResponse: num(input.creditsPerResponse),
    allowedConnectors: list(input.allowedConnectors),
  };
  if (!r.id) throw new RegistryError('Telemetry ID is required — the agent’s schema name as it appears in Application Insights.', 400);
  r.aliases = r.aliases.filter((a) => a.toLowerCase() !== r.id.toLowerCase());
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
}

const namesOf = (r) => [r.id, r.displayName, ...(r.aliases || [])].filter(Boolean).map((n) => n.toLowerCase());
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function normaliseDoc(doc) {
  return {
    agents: Array.isArray(doc?.agents) ? doc.agents.filter((a) => a && a.id && !isPlaceholder(a.id)) : [],
    removed: Array.isArray(doc?.removed) ? doc.removed.filter(Boolean) : [],
  };
}

// ------------------------------------------------------------------ API
async function loadRegistry(credential) {
  const { doc, etag } = await readRaw(credential);
  return { ...normaliseDoc(doc), etag, updatedAt: doc?.updatedAt || null, storage: storageInfo() };
}

async function updateRegistry(credential, mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { doc, etag } = await readRaw(credential);
    const state = normaliseDoc(doc);
    const result = mutate(state);
    const next = { version: 2, updatedAt: new Date().toISOString(), agents: state.agents, removed: state.removed };
    if (await writeRaw(next, etag, credential)) return result;
  }
  throw new RegistryError('Someone else changed the agent settings at the same time. Please try again.', 409);
}

/** Create or update an agent profile. Also brings a removed agent back. */
function saveProfile(state, input) {
  const rec = sanitise(input);
  const idx = state.agents.findIndex((a) => same(a.id, rec.id));
  const mine = new Set(namesOf(rec));
  const clash = state.agents.find((a, i) => i !== idx && namesOf(a).some((n) => mine.has(n)));
  if (clash) throw new RegistryError(`A name or alias is already used by “${clash.displayName || clash.id}”.`, 409);
  const now = new Date().toISOString();
  const saved = idx >= 0 ? { ...rec, createdAt: state.agents[idx].createdAt, updatedAt: now } : { ...rec, createdAt: now, updatedAt: now };
  if (idx >= 0) state.agents[idx] = saved;
  else state.agents.push(saved);
  state.removed = state.removed.filter((r) => !same(r, rec.id));
  return saved;
}

/** Stop monitoring an agent. Its telemetry is not touched; it can be restored. */
function removeAgent(state, id) {
  if (!id) throw new RegistryError('Agent id is required.', 400);
  if (!state.removed.some((r) => same(r, id))) state.removed.push(id);
  return id;
}

function restoreAgent(state, id) {
  if (!state.removed.some((r) => same(r, id))) throw new RegistryError('That agent is not removed.', 404);
  state.removed = state.removed.filter((r) => !same(r, id));
  return id;
}

/** Deletes a stored profile entirely (used for hand-added agents that never sent telemetry). */
function deleteProfile(state, id) {
  state.agents = state.agents.filter((a) => !same(a.id, id));
  return id;
}

module.exports = { loadRegistry, updateRegistry, saveProfile, removeAgent, restoreAgent, deleteProfile, sanitise, storageInfo, RegistryError, isPlaceholder };
