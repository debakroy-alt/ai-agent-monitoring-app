/**
 * Generates src/demoData.js — a synthetic portfolio used ONLY when the user
 * clicks "Show demo data". It runs the real API logic over synthetic
 * telemetry, so demo statuses follow exactly the same rules as live statuses.
 * Deterministic (seeded) — the same agents and figures on every run.
 *
 *   node tools/gen-demo.cjs        (or: npm run demo:generate)
 */
const fs = require('fs');
const path = require('path');
const { buildAgent, buildDiscovered, fillSeries, sortAgents } = require('../api/shared/build-agent');
const { publicLibrary } = require('../api/shared/metrics-registry');
const { normalise } = require('../api/shared/inventory');

const REF_END = Date.parse('2026-10-29T02:00:00.000Z'); // shifted to "now" in the browser
const CONFIG = { slowReplySeconds: 30, creditPriceUsd: 0.01, defaultCreditsPerResponse: 2, modelPrices: {} };

const CONNECTED = [
  { id: 'hr-policy-assistant', displayName: 'HR Policy Assistant', purpose: 'Answers employee questions on HR policies, leave and benefits eligibility.',
    department: 'Human Resources', location: 'US', businessOwner: 'HR Operations Lead', technicalOwner: 'HR Systems Engineer', platform: 'Microsoft Copilot Studio',
    riskTier: 'Medium', approvalStatus: 'Approved', productionSince: '2026-06-01', monthlyBudgetUsd: 80, creditsPerResponse: 2, allowedConnectors: ['Workday', 'SharePoint'] },
  { id: 'invoice-triage-agent', displayName: 'Invoice Triage Agent', purpose: 'Classifies inbound vendor invoices and routes exceptions to Accounts Payable.',
    department: 'Finance', location: 'India', businessOwner: 'AP Process Owner', technicalOwner: 'Finance Automation Lead', platform: 'Microsoft Copilot Studio',
    riskTier: 'High', approvalStatus: 'Approved', productionSince: '2026-05-10', monthlyBudgetUsd: 70, creditsPerResponse: 5, allowedConnectors: ['SAP', 'Outlook'] },
  { id: 'benefits-enrollment-helper', displayName: 'Benefits Enrollment Helper', purpose: 'Guides employees through annual benefits enrollment.',
    department: 'Human Resources', location: 'US', businessOwner: 'Total Rewards Manager', technicalOwner: 'HR Systems Engineer', platform: 'Microsoft Copilot Studio',
    riskTier: 'Medium', approvalStatus: 'Approved', productionSince: '2026-09-20', monthlyBudgetUsd: 40, creditsPerResponse: 2, allowedConnectors: ['Workday'] },
  { id: 'sales-proposal-drafter', displayName: 'Sales Proposal Drafter', purpose: 'Drafts first-pass client proposals from approved templates.',
    department: 'Sales & Marketing', location: 'US', businessOwner: 'Sales Enablement Director', technicalOwner: 'CRM Platform Owner', platform: 'Microsoft Copilot Studio',
    riskTier: 'Medium', approvalStatus: 'Approved', productionSince: '2026-08-14', monthlyBudgetUsd: 35, creditsPerResponse: 2, allowedConnectors: ['Salesforce', 'SharePoint'] },
  { id: 'underwriting-intake-agent', displayName: 'Underwriting Intake Agent', purpose: 'Collects and validates submission data for commercial underwriting.',
    department: 'Underwriting', location: 'UK', businessOwner: 'Underwriting Ops Head', technicalOwner: 'Underwriting Tech Lead', platform: 'Microsoft Copilot Studio',
    riskTier: 'High', approvalStatus: 'Approved', productionSince: '2026-04-03', monthlyBudgetUsd: 50, creditsPerResponse: 2, allowedConnectors: ['Guidewire'] },
  { id: 'it-service-desk-agent', displayName: 'IT Service Desk Agent', purpose: 'Resolves common IT tickets and password / access requests.',
    department: 'Enterprise', location: 'Global', businessOwner: 'IT Service Manager', technicalOwner: 'Enterprise AI Platform', platform: 'Azure AI Foundry',
    riskTier: 'Medium', approvalStatus: 'Approved', productionSince: '2026-03-10', monthlyBudgetUsd: 25, allowedConnectors: ['ServiceNow', 'Entra ID'] },
  { id: 'enterprise-knowledge-search', displayName: 'Enterprise Knowledge Search', purpose: 'Firm-wide question answering over policies and knowledge articles.',
    department: 'Enterprise', location: 'Global', businessOwner: 'Knowledge Management Lead', technicalOwner: 'Enterprise AI Platform', platform: 'Azure AI Foundry',
    riskTier: 'Medium', approvalStatus: 'Approved', productionSince: '2026-02-17', monthlyBudgetUsd: 35, allowedConnectors: ['SharePoint'] },
  { id: 'expense-audit-copilot', displayName: 'Expense Audit Copilot', purpose: 'Flags out-of-policy expense claims for reviewer attention.',
    department: 'Finance', location: 'US', businessOwner: 'Controller', platform: 'Microsoft Copilot Studio',
    riskTier: 'High', approvalStatus: 'Approved', productionSince: '2026-07-01', billingModel: 'm365-copilot', allowedConnectors: ['Concur'] },
  { id: 'press-coverage-summariser', displayName: 'Press Coverage Summariser', purpose: 'Produces media coverage summaries for the communications team.',
    department: 'Sales & Marketing', location: 'US', businessOwner: 'Communications Lead', technicalOwner: 'Digital Platform Engineer', platform: 'Microsoft Copilot Studio',
    riskTier: 'Low', approvalStatus: 'In review', monthlyBudgetUsd: 15, creditsPerResponse: 2, allowedConnectors: ['SharePoint'] },
  { id: 'contract-clause-reviewer', displayName: 'Contract Clause Reviewer', purpose: 'Highlights non-standard clauses in third-party contracts.',
    department: 'Legal', location: 'US', businessOwner: 'Associate General Counsel', technicalOwner: 'Legal Tech Lead', platform: 'Microsoft Copilot Studio',
    riskTier: 'High', approvalStatus: 'Approved', productionSince: '2026-08-30', monthlyBudgetUsd: 30, allowedConnectors: ['SharePoint'] },
].map(normalise);

// perDay = engaged conversations on a weekday. Rates are per engaged conversation.
const PROFILES = {
  'hr-policy-assistant': { perDay: 28, turns: 3.1, unanswered: 0.004, resolve: 0.91, err: 0.007, dep: 0.003, esc: 0.03, p50: 2.6, p95: 6.1, slow: 0.004, jail1k: 0, harm: 0.002 },
  'invoice-triage-agent': { perDay: 22, turns: 2.6, unanswered: 0.022, resolve: 0.76, err: 0.074, dep: 0.061, esc: 0.05, p50: 3.8, p95: 9.2, slow: 0.012, jail1k: 0, harm: 0, codes: ['FlowActionTimedOut', 'ConnectorRequestFailure'] },
  'benefits-enrollment-helper': { perDay: 16, turns: 4.2, unanswered: 0.007, resolve: 0.88, err: 0.014, dep: 0.006, esc: 0.04, p50: 6.2, p95: 14.6, slow: 0.031, jail1k: 0, harm: 0.002, codes: ['SystemError'] },
  'sales-proposal-drafter': { perDay: 12, turns: 3.8, unanswered: 0.006, resolve: 0.86, err: 0.015, dep: 0.004, esc: 0.03, p50: 3.7, p95: 8.8, slow: 0.009, jail1k: 3.5, harm: 0.018, codes: ['ContentFiltered'] },
  'underwriting-intake-agent': { perDay: 18, turns: 3.4, unanswered: 0.009, resolve: 0.87, err: 0.019, dep: 0.008, esc: 0.02, p50: 4.1, p95: 9.6, slow: 0.01, jail1k: 9, harm: 0.006, indirect: 0.02, codes: ['ContentFiltered'] },
  'it-service-desk-agent': { perDay: 34, turns: 2.8, unanswered: 0.003, resolve: 0.92, err: 0.009, dep: 0.004, esc: 0.03, p50: 2.1, p95: 4.9, slow: 0.002, jail1k: 0, harm: 0.001, model: 'gpt-4o-mini', inTok: 2100, outTok: 420 },
  'enterprise-knowledge-search': { perDay: 52, turns: 2.2, unanswered: 0.008, resolve: 0.9, err: 0.012, dep: 0.03, esc: 0.01, p50: 3.3, p95: 7.7, slow: 0.006, jail1k: 1.6, harm: 0.002, indirect: 0.06, model: 'gpt-4o', inTok: 3600, outTok: 650, codes: ['ContentFiltered'] },
  'expense-audit-copilot': { perDay: 11, turns: 2.9, unanswered: 0.003, resolve: 0.93, err: 0.004, dep: 0.002, esc: 0.02, p50: 2.3, p95: 5.3, slow: 0.003, jail1k: 0, harm: 0 },
  'press-coverage-summariser': { perDay: 4, turns: 3.3, unanswered: 0.004, resolve: 0.9, err: 0.011, dep: 0, esc: 0.02, p50: 3, p95: 7.2, slow: 0.004, jail1k: 0, harm: 0, codes: ['SystemError'] },
  // discovered (not connected)
  cr4f2_contractbot: { perDay: 2.2, turns: 3, unanswered: 0.04, resolve: 0.68, err: 0.065, dep: 0.04, esc: 0.06, p50: 5, p95: 12, slow: 0.018, jail1k: 0, harm: 0, testOnly: true, botName: 'Contract Bot' },
  cr7a1_travelbookingbot: { perDay: 6, turns: 3.5, unanswered: 0.01, resolve: 0.85, err: 0.01, dep: 0.01, esc: 0.03, p50: 3, p95: 7, slow: 0.005, jail1k: 0, harm: 0, botName: 'Travel Booking Helper' },
};

function rng(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) (h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353)), (h = (h << 13) | (h >>> 19));
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const draw = (r, expected) => Math.floor(expected) + (r() < expected - Math.floor(expected) ? 1 : 0);

function bucketLoad(t, days) {
  const d = new Date(t);
  const weekend = [0, 6].includes(d.getUTCDay());
  if (days === 1) {
    const h = d.getUTCHours();
    return ((weekend ? 0.15 : 1) * (h >= 4 && h <= 16 ? 1 : 0.08)) / 13;
  }
  return weekend ? 0.15 : 1;
}

function synthesise(id, p, days) {
  const r = rng(`${id}:${days}`);
  const step = days === 1 ? 3600000 : 86400000;
  const start = REF_END - days * 86400000;
  const tot = { Conversations: 0, Engaged: 0, Resolved: 0, HealthFailed: 0, DependencyFailed: 0, Escalated: 0, Jailbreaks: 0, IndirectAttacks: 0, HarmfulConversations: 0, DlpBlocks: 0, ErrorEvents: 0 };
  const series = [];
  let lastT = null;
  for (let t = Math.floor(start / step) * step; t <= REF_END; t += step) {
    const n = draw(r, p.perDay * bucketLoad(t, days) * (0.85 + r() * 0.3));
    if (!n) continue;
    lastT = t;
    const failed = draw(r, n * p.err * (0.6 + r() * 0.8));
    const dep = Math.min(n, draw(r, n * p.dep * (0.6 + r() * 0.8)));
    const harm = draw(r, n * p.harm);
    const jail = draw(r, (n * p.jail1k) / 1000);
    const indirect = draw(r, (n * (p.indirect || 0)) / 30);
    const blocked = Math.min(n, harm + jail + indirect);
    const esc = draw(r, n * p.esc);
    const completed = Math.max(0, Math.min(n - failed - blocked - esc, Math.round(n * p.resolve * (0.97 + r() * 0.06))));
    tot.Conversations += n + draw(r, n * 0.08);
    tot.Engaged += n;
    tot.Resolved += completed;
    tot.HealthFailed += failed;
    tot.DependencyFailed += dep;
    tot.Escalated += esc;
    tot.Jailbreaks += jail;
    tot.IndirectAttacks += indirect;
    tot.HarmfulConversations += harm;
    tot.ErrorEvents += failed + Math.round(failed * 0.4) + jail + indirect + harm;
    series.push({ Bucket: new Date(t).toISOString(), Conversations: n, Failed: failed, Completed: completed, Blocked: blocked });
  }
  const userTurns = Math.round(tot.Engaged * p.turns);
  const answered = Math.round(userTurns * (1 - p.unanswered));
  const jitter = 0.97 + r() * 0.06;
  const turns = { UserTurns: userTurns, AnsweredTurns: answered, SlowTurns: Math.round(answered * p.slow),
    P95LatencySec: Math.round(p.p95 * jitter * 100) / 100, P50LatencySec: Math.round(p.p50 * jitter * 10) / 10 };
  const row = {
    AgentId: id, ...tot,
    ProductionConversations: p.testOnly ? 0 : tot.Conversations,
    TestConversations: p.testOnly ? tot.Conversations : 0,
    Channels: p.testOnly ? ['pva-studio'] : ['msteams', 'webchat'],
    BotNames: [p.botName || id], RawKeys: [id],
    LastSeen: lastT ? new Date(Math.min(REF_END - 60000 * (2 + Math.floor(r() * 50)), lastT + step - 60000)).toISOString() : null,
    TopErrorCodes: (p.codes || []).map((code, i) => ({ code, count: Math.max(1, Math.round(tot.ErrorEvents / (i + 2))) })),
  };
  const costRows = p.model
    ? [{ AgentId: id, Model: p.model, InputTokens: Math.round(answered * p.inTok), OutputTokens: Math.round(answered * p.outTok),
        ModelCalls: Math.round(answered * 1.5), FailedCalls: Math.round(answered * 1.5 * p.dep * 0.5) }]
    : [];
  return { row, turns, series: fillSeries(series, new Date(start).toISOString(), new Date(REF_END).toISOString(), days), costRows };
}

const SNAPSHOTS = {};
for (const days of [1, 7, 30, 90]) {
  const start = new Date(REF_END - days * 86400000).toISOString();
  const end = new Date(REF_END).toISOString();
  const connectedIds = new Set(CONNECTED.map((c) => c.key));
  const agents = CONNECTED.map((profile) => {
    const p = PROFILES[profile.key];
    const s = p ? synthesise(profile.key, p, days) : { row: {}, series: fillSeries([], start, end, days), costRows: [] };
    return buildAgent({ key: profile.key, row: s.row, turns: s.turns, series: s.series, costRows: s.costRows, profile, days, now: REF_END, config: CONFIG });
  });
  const discovered = Object.entries(PROFILES)
    .filter(([id]) => !connectedIds.has(id))
    .map(([id, p]) => buildDiscovered({ key: id, row: synthesise(id, p, days).row }))
    .filter((d) => d.allConversations > 0);
  SNAPSHOTS[days] = {
    mode: 'demo', lookbackDays: days, window: { start, end }, generatedAt: end, queryMs: 0,
    sources: {
      telemetry: 'Demo telemetry (synthetic)',
      registry: { type: 'demo', label: 'Demo agent list (read-only)', persistent: false },
      connectedCount: CONNECTED.length,
      inventory: 'none', inventoryLabel: 'Not connected (optional)', aliasClashes: [], costTelemetry: 'connected',
      pricing: `Copilot Credits at $${CONFIG.creditPriceUsd}/credit · default model price list`,
      slowReplySeconds: CONFIG.slowReplySeconds, creditsPerResponse: CONFIG.defaultCreditsPerResponse,
    },
    changesRequireSignIn: false,
    library: publicLibrary(),
    agents: sortAgents(agents),
    discovered,
  };
}

const out = `// AUTO-GENERATED by tools/gen-demo.cjs from the real API logic with synthetic telemetry.
// Used ONLY when the user clicks "Show demo data". Never shown as live. Do not edit by hand.
const SNAPSHOTS = ${JSON.stringify(SNAPSHOTS)};

/** Returns the snapshot for a period with every timestamp shifted so the data looks current. */
export function buildDemoPayload(days) {
  const snap = SNAPSHOTS[days] || SNAPSHOTS[7];
  const shift = Date.now() - Date.parse(snap.generatedAt);
  const move = (iso) => (iso ? new Date(Date.parse(iso) + shift).toISOString() : iso);
  return {
    ...snap,
    generatedAt: move(snap.generatedAt),
    window: { start: move(snap.window.start), end: move(snap.window.end) },
    agents: snap.agents.map((a) => ({ ...a, lastSeen: move(a.lastSeen), series: a.series.map((p) => ({ ...p, t: move(p.t) })) })),
    discovered: snap.discovered.map((d) => ({ ...d, lastSeen: move(d.lastSeen) })),
  };
}
`;
const target = path.join(__dirname, '..', 'src', 'demoData.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out);
console.log(`Wrote ${path.relative(process.cwd(), target)} (${(out.length / 1024).toFixed(0)} KB)`);
