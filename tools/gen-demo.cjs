/**
 * Generates src/demoData.js — a synthetic portfolio used ONLY when the user
 * clicks "Show demo data". It runs the real API logic over synthetic
 * telemetry, so demo statuses follow exactly the same rules as live data.
 * Deterministic (seeded): the same figures on every run.
 *
 *   node tools/gen-demo.cjs        (or: npm run demo:generate)
 */
const fs = require('fs');
const path = require('path');
const { buildAgent, fillSeries, sortAgents, prettyName } = require('../api/shared/build-agent');
const { publicLibrary } = require('../api/shared/metrics-registry');
const { normalise } = require('../api/shared/inventory');

const REF_END = Date.parse('2026-10-29T02:00:00.000Z'); // shifted to "now" in the browser
const EXTENDED = 90;
const CONFIG = { slowReplySeconds: 30, creditPriceUsd: 0.01, defaultCreditsPerResponse: 2, modelPrices: {} };

// Saved profiles (optional in the real app). Agents without one are shown with their telemetry name.
const PROFILES = [
  { id: 'cr1a2_hrPolicyAssistant', displayName: 'HR Policy Assistant', purpose: 'Answers employee questions on HR policies, leave and benefits eligibility.',
    department: 'Human Resources', location: 'US', businessOwner: 'HR Operations Lead', technicalOwner: 'HR Systems Engineer',
    riskTier: 'Medium', approvalStatus: 'Approved', productionSince: '2026-06-01', monthlyBudgetUsd: 80, creditsPerResponse: 2 },
  { id: 'cr1a2_invoiceTriage', displayName: 'Invoice Triage Agent', purpose: 'Classifies inbound vendor invoices and routes exceptions to Accounts Payable.',
    department: 'Finance', location: 'India', businessOwner: 'AP Process Owner', technicalOwner: 'Finance Automation Lead',
    riskTier: 'High', approvalStatus: 'Approved', productionSince: '2026-05-10', monthlyBudgetUsd: 70, creditsPerResponse: 5 },
  { id: 'cr1a2_benefitsEnrollment', displayName: 'Benefits Enrollment Helper', purpose: 'Guides employees through annual benefits enrollment.',
    department: 'Human Resources', location: 'US', businessOwner: 'Total Rewards Manager', technicalOwner: 'HR Systems Engineer',
    riskTier: 'Medium', approvalStatus: 'Approved', productionSince: '2026-09-20', monthlyBudgetUsd: 40, creditsPerResponse: 2 },
  { id: 'cr1a2_salesProposal', displayName: 'Sales Proposal Drafter', purpose: 'Drafts first-pass client proposals from approved templates.',
    department: 'Sales & Marketing', location: 'US', businessOwner: 'Sales Enablement Director', technicalOwner: 'CRM Platform Owner',
    riskTier: 'Medium', approvalStatus: 'Approved', productionSince: '2026-08-14', monthlyBudgetUsd: 35, creditsPerResponse: 2 },
  { id: 'cr1a2_underwritingIntake', displayName: 'Underwriting Intake Agent', purpose: 'Collects and validates submission data for commercial underwriting.',
    department: 'Underwriting', location: 'UK', businessOwner: 'Underwriting Ops Head', technicalOwner: 'Underwriting Tech Lead',
    riskTier: 'High', approvalStatus: 'Approved', productionSince: '2026-04-03', monthlyBudgetUsd: 50, creditsPerResponse: 2 },
  { id: 'it-service-desk-agent', displayName: 'IT Service Desk Agent', purpose: 'Resolves common IT tickets and password / access requests.',
    department: 'Enterprise', location: 'Global', businessOwner: 'IT Service Manager', technicalOwner: 'Enterprise AI Platform', platform: 'Azure AI Foundry',
    riskTier: 'Medium', approvalStatus: 'Approved', productionSince: '2026-03-10', monthlyBudgetUsd: 25 },
  { id: 'cr1a2_contractClauseReviewer', displayName: 'Contract Clause Reviewer', purpose: 'Highlights non-standard clauses in third-party contracts.',
    department: 'Legal', location: 'US', businessOwner: 'Associate General Counsel', technicalOwner: 'Legal Tech Lead',
    riskTier: 'High', approvalStatus: 'Approved', productionSince: '2026-08-30', monthlyBudgetUsd: 30 },
].map(normalise);

// Behaviour. perDay = runs on a weekday; quietDays = no activity in the most recent N days.
const BEHAVIOUR = {
  cr1a2_hrPolicyAssistant: { perDay: 28, turns: 3.1, unanswered: 0.004, resolve: 0.91, err: 0.007, dep: 0.003, esc: 0.03, p50: 2.6, p95: 6.1, slow: 0.004, jail1k: 0, harm: 0.002 },
  cr1a2_invoiceTriage: { perDay: 22, turns: 2.6, unanswered: 0.022, resolve: 0.76, err: 0.074, dep: 0.061, esc: 0.05, p50: 3.8, p95: 9.2, slow: 0.012, jail1k: 0, harm: 0, codes: ['FlowActionTimedOut', 'ConnectorRequestFailure'] },
  cr1a2_benefitsEnrollment: { perDay: 16, turns: 4.2, unanswered: 0.007, resolve: 0.88, err: 0.014, dep: 0.006, esc: 0.04, p50: 6.2, p95: 14.6, slow: 0.031, jail1k: 0, harm: 0.002, codes: ['SystemError'] },
  cr1a2_salesProposal: { perDay: 12, turns: 3.8, unanswered: 0.006, resolve: 0.86, err: 0.015, dep: 0.004, esc: 0.03, p50: 3.7, p95: 8.8, slow: 0.009, jail1k: 3.5, harm: 0.018, codes: ['ContentFiltered'] },
  cr1a2_underwritingIntake: { perDay: 18, turns: 3.4, unanswered: 0.009, resolve: 0.87, err: 0.019, dep: 0.008, esc: 0.02, p50: 4.1, p95: 9.6, slow: 0.01, jail1k: 9, harm: 0.006, indirect: 0.02, codes: ['ContentFiltered'] },
  'it-service-desk-agent': { perDay: 34, turns: 2.8, unanswered: 0.003, resolve: 0.92, err: 0.009, dep: 0.004, esc: 0.03, p50: 2.1, p95: 4.9, slow: 0.002, jail1k: 0, harm: 0.001, model: 'gpt-4o-mini', inTok: 2100, outTok: 420 },
  cr1a2_contractClauseReviewer: { perDay: 3, turns: 3, unanswered: 0.01, resolve: 0.9, err: 0.01, dep: 0.01, esc: 0.02, p50: 4, p95: 8.5, slow: 0.005, jail1k: 0, harm: 0, quietDays: 12 },
  // No saved profile — shown automatically from telemetry:
  sps_dailyCyberPrivacyBriefing: { perDay: 1, auto: true, resolve: 0.95, err: 0.03, dep: 0.03, esc: 0, jail1k: 0, harm: 0, weekendToo: true },
  sps_pressCoverageSummariser: { perDay: 4, turns: 3.3, unanswered: 0.004, resolve: 0.9, err: 0.011, dep: 0, esc: 0.02, p50: 3, p95: 7.2, slow: 0.004, jail1k: 0, harm: 0, codes: ['SystemError'] },
  sps_TestAgent1: { perDay: 2.2, turns: 3, unanswered: 0.04, resolve: 0.68, err: 0.065, dep: 0.04, esc: 0.06, p50: 5, p95: 12, slow: 0.018, jail1k: 0, harm: 0, testOnly: true, codes: ['FlowActionTimedOut'] },
  // Removed from monitoring by the user:
  cr7a1_oldTravelBot: { perDay: 1, turns: 3, unanswered: 0.01, resolve: 0.85, err: 0.01, dep: 0.01, esc: 0.03, p50: 3, p95: 7, slow: 0.005, jail1k: 0, harm: 0 },
};
const REMOVED = ['cr7a1_oldTravelBot'];

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

function bucketLoad(t, days, p) {
  const d = new Date(t);
  const weekend = [0, 6].includes(d.getUTCDay()) && !p.weekendToo;
  if (days === 1) {
    if (p.auto) return d.getUTCHours() === 6 ? 1 : 0; // one scheduled run a day
    const h = d.getUTCHours();
    return ((weekend ? 0.15 : 1) * (h >= 4 && h <= 16 ? 1 : 0.08)) / 13;
  }
  return weekend ? 0.15 : 1;
}

function synthesise(id, p, days) {
  const r = rng(`${id}:${days}`);
  const step = days === 1 ? 3600000 : 86400000;
  const start = REF_END - days * 86400000;
  const quietFrom = REF_END - (p.quietDays || 0) * 86400000;
  const tot = { Conversations: 0, Engaged: 0, AutoRuns: 0, Resolved: 0, HealthFailed: 0, DependencyFailed: 0, Escalated: 0, Jailbreaks: 0, IndirectAttacks: 0, HarmfulConversations: 0, DlpBlocks: 0, ErrorEvents: 0 };
  const series = [];
  let lastT = null;
  for (let t = Math.floor(start / step) * step; t <= REF_END; t += step) {
    if (p.quietDays && t >= quietFrom) continue;
    const n = p.auto && days !== 1 ? draw(r, p.perDay) : draw(r, p.perDay * bucketLoad(t, days, p) * (0.85 + r() * 0.3));
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
    tot.Conversations += n + (p.auto ? 0 : draw(r, n * 0.08));
    tot.Engaged += n;
    if (p.auto) tot.AutoRuns += n;
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
  const userTurns = p.auto ? 0 : Math.round((tot.Engaged - tot.AutoRuns) * p.turns);
  const answered = Math.round(userTurns * (1 - (p.unanswered || 0)));
  const jitter = 0.97 + r() * 0.06;
  const turns = p.auto ? null : { UserTurns: userTurns, AnsweredTurns: answered, SlowTurns: Math.round(answered * p.slow),
    P95LatencySec: Math.round(p.p95 * jitter * 100) / 100, P50LatencySec: Math.round(p.p50 * jitter * 10) / 10 };
  const row = {
    AgentId: id, ...tot,
    ProductionConversations: p.testOnly ? 0 : tot.Conversations,
    TestConversations: p.testOnly ? tot.Conversations : 0,
    Channels: p.testOnly ? ['pva-studio'] : p.auto ? ['directline'] : ['msteams', 'webchat'],
    BotNames: [id], RawKeys: [id],
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
  const agents = [];
  const removed = [];
  for (const [id, p] of Object.entries(BEHAVIOUR)) {
    const ext = synthesise(id, p, EXTENDED);
    if (REMOVED.includes(id)) {
      removed.push({ id, name: prettyName(id), lastSeen: ext.row.LastSeen, runs: ext.row.Engaged });
      continue;
    }
    const per = synthesise(id, p, days);
    const usePeriod = per.row.Conversations > 0 || days === EXTENDED;
    const s = usePeriod ? per : ext;
    const profile = PROFILES.find((x) => x.key === id) || null;
    agents.push(buildAgent({ key: id, row: s.row, turns: s.turns, series: s.series, costRows: s.costRows, profile,
      days: usePeriod ? days : EXTENDED, selectedDays: days, now: REF_END, config: CONFIG }));
  }
  SNAPSHOTS[days] = {
    mode: 'demo', lookbackDays: days, extendedDays: EXTENDED,
    window: { start: new Date(REF_END - days * 86400000).toISOString(), end: new Date(REF_END).toISOString() },
    generatedAt: new Date(REF_END).toISOString(), queryMs: 0,
    sources: {
      telemetry: 'Demo telemetry (synthetic)',
      registry: { type: 'demo', label: 'Demo settings (read-only)', persistent: false },
      savedProfiles: PROFILES.length,
      inventory: 'none', inventoryLabel: 'Not connected (optional)', aliasClashes: [], costTelemetry: 'connected',
      pricing: `Copilot Credits at $${CONFIG.creditPriceUsd}/credit · default model price list`,
      slowReplySeconds: CONFIG.slowReplySeconds, creditsPerResponse: CONFIG.defaultCreditsPerResponse,
    },
    library: publicLibrary(),
    agents: sortAgents(agents),
    removed,
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
    removed: snap.removed.map((d) => ({ ...d, lastSeen: move(d.lastSeen) })),
  };
}
`;
const target = path.join(__dirname, '..', 'src', 'demoData.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out);
console.log(`Wrote ${path.relative(process.cwd(), target)} (${(out.length / 1024).toFixed(0)} KB)`);
