// Runs api/agents/index.js with mocked Azure identity + Log Analytics to (1) test it, (2) build src/demoData.js
const Module = require('module');
const path = require('path');
const fs = require('fs');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === '@azure/identity') return { DefaultAzureCredential: class { async getToken() { return { token: 'x' }; } } };
  return origLoad.call(this, req, ...rest);
};
process.env.LOG_ANALYTICS_WORKSPACE_ID = 'demo';
process.env.INVENTORY_URL = 'https://inventory.demo/agents';
process.env.PRICE_INPUT_PER_1K_USD = '0.0025';
process.env.PRICE_OUTPUT_PER_1K_USD = '0.01';

const NOW = new Date('2026-10-29T02:00:00Z').getTime();
Date.now = () => NOW;

// spec per agent: daily convs, turnsPerConv, answer%, completion%, fail%, p95, slow%, injections/30d, content%, prod, tokens/conv
const SPECS = [
  ['hr-policy-assistant', 22, 3.1, 99.6, 93, 0.8, 6.2, 0.4, 0, 0.2, true, 0],
  ['benefits-enrollment-helper', 14, 4.2, 99.3, 91, 1.4, 14.8, 3.1, 0, 0.3, true, 0],
  ['invoice-triage-agent', 18, 2.6, 97.8, 81, 7.4, 9.1, 1.2, 0, 0, true, 0],
  ['expense-audit-copilot', 9, 2.9, 99.8, 95, 0.5, 5.4, 0.3, 0, 0, true, 0],
  ['sales-proposal-drafter', 11, 3.8, 99.4, 90, 1.6, 8.7, 0.9, 1, 1.9, true, 0],
  ['media-pr-report-generator', 3, 3.3, 99.5, 92, 1.1, 7.2, 0.5, 0, 0, false, 0],
  ['underwriting-intake-agent', 16, 3.4, 99.1, 90, 1.9, 9.8, 1.0, 9, 0.6, true, 0],
  ['it-service-desk-agent', 30, 2.8, 99.7, 94, 0.9, 4.9, 0.2, 0, 0.1, true, 2400],
  ['enterprise-knowledge-search', 41, 2.2, 99.2, 92, 1.2, 7.9, 0.6, 1, 0.2, true, 5200],
  ['cr4f2_contractbot', 2, 3.0, 96.0, 70, 6.0, 12.0, 2.0, 0, 0, false, 0],
];
const INVENTORY = [
  ['hr-policy-assistant', 'HR Policy Assistant', 'Answers employee questions on HR policies, leave and benefits eligibility.', 'Human Resources', 'US', 'HR Operations Lead', 'HR Systems Engineer', 'Microsoft Copilot Studio', 'Medium', 'Approved', '2026-06-02', 10, ['Workday', 'SharePoint']],
  ['benefits-enrollment-helper', 'Benefits Enrollment Helper', 'Guides employees through annual benefits enrollment.', 'Human Resources', 'US', 'Total Rewards Manager', 'HR Systems Engineer', 'Microsoft Copilot Studio', 'Medium', 'Approved', '2026-09-20', 10, ['Workday']],
  ['invoice-triage-agent', 'Invoice Triage Agent', 'Classifies inbound vendor invoices and routes exceptions to AP.', 'Finance', 'India', 'AP Process Owner', 'Finance Automation Lead', 'Microsoft Copilot Studio', 'High', 'Approved', '2026-05-11', 15, ['SAP', 'Outlook']],
  ['expense-audit-copilot', 'Expense Audit Copilot', 'Flags out-of-policy expense claims for reviewer attention.', 'Finance', 'US', 'Controller', '', 'Microsoft Copilot Studio', 'High', 'Approved', '2026-07-01', 10, ['Concur']],
  ['sales-proposal-drafter', 'Sales Proposal Drafter', 'Drafts first-pass client proposals from approved templates.', 'Sales & Marketing', 'US', 'Sales Enablement Director', 'CRM Platform Owner', 'Microsoft Copilot Studio', 'Medium', 'Approved', '2026-08-14', 10, ['Salesforce', 'SharePoint']],
  ['media-pr-report-generator', 'Media PR Report Generator', 'Produces media coverage summaries for the PR team.', 'Sales & Marketing', 'US', 'PR Lead', 'Digital Platform Engineer', 'Microsoft Copilot Studio', 'Low', 'In review', null, 5, ['SharePoint']],
  ['underwriting-intake-agent', 'Underwriting Intake Agent', 'Collects and validates submission data for commercial underwriting.', 'Underwriting', 'UK', 'Underwriting Ops Head', 'Underwriting Tech Lead', 'Microsoft Copilot Studio', 'High', 'Approved', '2026-04-03', 15, ['Guidewire']],
  ['it-service-desk-agent', 'IT Service Desk Agent', 'Resolves common IT tickets and password / access requests.', 'Enterprise', 'Global', 'IT Service Manager', 'Enterprise AI Platform', 'Azure AI Foundry', 'Medium', 'Approved', '2026-03-10', 25, ['ServiceNow', 'Entra ID']],
  ['enterprise-knowledge-search', 'Enterprise Knowledge Search', 'Firm-wide question answering over policies and knowledge articles.', 'Enterprise', 'Global', 'Knowledge Management Lead', 'Enterprise AI Platform', 'Azure AI Foundry', 'Medium', 'Approved', '2026-02-17', 25, ['SharePoint']],
  ['contract-clause-reviewer', 'Contract Clause Reviewer', 'Highlights non-standard clauses in third-party contracts.', 'Legal', 'US', 'Associate General Counsel', 'Legal Tech Lead', 'Microsoft Copilot Studio', 'High', 'Approved', '2026-08-30', 10, ['SharePoint']],
].map(([id, displayName, purpose, department, location, businessOwner, technicalOwner, platform, riskTier, approvalStatus, productionSince, monthlyBudgetUsd, allowedConnectors]) =>
  ({ id, displayName, purpose, department, location, businessOwner, technicalOwner, platform, riskTier, approvalStatus, productionSince, monthlyBudgetUsd, allowedConnectors }));

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const jitter = (v, p = 0.25) => v * (1 + (rnd() - 0.5) * 2 * p);

function tables(query) {
  const m = query.match(/lookback = (\d+)d/) || query.match(/ago\((\d+)d\)/); const days = Number(m[1]);
  const scale = days;
  const cols = (rows) => (rows.length ? { tables: [{ columns: Object.keys(rows[0]).map((name) => ({ name })), rows: rows.map((r) => Object.values(r)) }] } : { tables: [{ columns: [], rows: [] }] });
  if (query.includes('union isfuzzy')) {
    return cols(SPECS.filter((s) => s[11]).map((s) => {
      const conv = Math.round(s[1] * scale);
      const tok = conv * s[11];
      return { AgentId: s[0], InputTokens: Math.round(tok * 0.78), OutputTokens: Math.round(tok * 0.22), ModelCalls: conv * 3, FailedCalls: s[0] === 'enterprise-knowledge-search' ? Math.round(conv * 3 * 0.03) : Math.round(conv * 0.02), Models: ['gpt-5.5'] };
    }));
  }
  if (query.includes('InjectionAttempts')) {
    return cols(SPECS.map((s) => ({ AgentId: s[0], InjectionAttempts: Math.round((s[8] * scale) / 30 + (s[8] && scale >= 7 ? 1 : 0)), ContentBlockedConversations: Math.round((s[1] * scale * s[9]) / 100), TopErrorCodes: s[5] > 5 ? ['FlowActionTimedOut', 'ConnectorRequestFailure'] : s[8] ? ['OpenAIJailBreak', 'OpenAIndirectAttack'] : s[5] > 1 ? ['SystemError'] : [] })));
  }
  if (query.includes('Bucket')) {
    const rows = [];
    const buckets = days === 1 ? 24 : days;
    const step = days === 1 ? 3600000 : 86400000;
    const start = Math.floor(NOW / step) * step - (buckets - 1) * step;
    SPECS.forEach((s) => {
      for (let i = 0; i < buckets; i++) {
        const t = new Date(start + i * step);
        const weekend = days !== 1 && [0, 6].includes(t.getUTCDay());
        const per = days === 1 ? s[1] / 24 * (t.getUTCHours() > 3 && t.getUTCHours() < 16 ? 2 : 0.3) : s[1] * (weekend ? 0.25 : 1.2);
        const c = Math.max(0, Math.round(jitter(per, 0.35)));
        const spike = s[0] === 'invoice-triage-agent' && i >= buckets - 3 ? 1.8 : 1;
        const f = Math.min(c, Math.round(c * (s[5] / 100) * spike + (rnd() < 0.15 ? 1 : 0) * (c > 0)));
        rows.push({ AgentId: s[0], Bucket: t.toISOString(), Conversations: c, Failed: f, Completed: Math.max(0, Math.round(c * s[4] / 100) - f) });
      }
    });
    return cols(rows);
  }
  if (query.includes('P95LatencySec')) {
    return cols(SPECS.map((s) => {
      const turns = Math.round(s[1] * scale * s[2]);
      const ans = Math.round(turns * s[3] / 100);
      return { AgentId: s[0], UserTurns: turns, AnsweredTurns: ans, SlowTurns: Math.round(ans * s[7] / 100), P95LatencySec: +jitter(s[6], 0.04).toFixed(2), P50LatencySec: +(s[6] * 0.42).toFixed(2) };
    }));
  }
  // summary
  return cols(SPECS.map((s) => {
    const conv = Math.round(s[1] * scale);
    const failed = Math.round(conv * s[5] / 100);
    const prodConv = s[10] ? Math.round(conv * 0.85) : 0;
    return {
      AgentId: s[0], Conversations: conv, CompletedConversations: Math.round(conv * s[4] / 100) - Math.round(failed * 0.3),
      FailedConversations: failed, ErrorEvents: Math.round(failed * 1.4), ProductionConversations: prodConv, TestConversations: conv - prodConv,
      Channels: s[10] ? ['msteams', 'webchat'] : ['pva-studio'],
      FirstSeen: new Date(NOW - scale * 86400000 + 3600000).toISOString(), LastSeen: new Date(NOW - Math.round(rnd() * 50 + 2) * 60000).toISOString(),
    };
  }));
}

global.fetch = async (url, opts) => {
  if (url.startsWith('https://inventory.demo')) return { ok: true, json: async () => ({ value: INVENTORY }) };
  const { query } = JSON.parse(opts.body);
  return { ok: true, status: 200, json: async () => tables(query) };
};
const handler = require(path.resolve(__dirname, '../api/agents/index.js'));
(async () => {
  const snaps = {};
  for (const d of [1, 7, 30, 90]) {
    seed = 7 + d;
    const ctx = { log: Object.assign(console.log, { error: console.error }) };
    await handler(ctx, { query: { days: String(d) } });
    if (ctx.res.status !== 200) throw new Error(JSON.stringify(ctx.res.body));
    const b = ctx.res.body;
    b.mode = 'demo'; b.sources.inventoryLabel = 'Demo AI inventory'; b.sources.telemetry = 'Demo telemetry (synthetic)';
    snaps[d] = b;
  }
  const out = `// AUTO-GENERATED by tools/gen-demo.js from the real API logic with synthetic telemetry.
// Used ONLY when the user clicks "Show demo data". Never shown as live.
const SNAPSHOTS = ${JSON.stringify(snaps)};
export function buildDemoPayload(days) {
  const snap = SNAPSHOTS[days] || SNAPSHOTS[7];
  return { ...snap, generatedAt: new Date().toISOString() };
}
`;
  fs.writeFileSync(path.resolve(__dirname, '../src/demoData.js'), out);
  const s7 = snaps[7];
  console.log('agents', s7.agents.length, 'bytes', out.length);
  for (const a of s7.agents) console.log(a.name.padEnd(30), a.department.padEnd(18), a.environment.padEnd(10), a.statuses.overall.padEnd(7), 'H', a.statuses.health, 'R', a.statuses.risk, 'C', a.statuses.cost, 'compliant', a.compliant, a.alerts.map(x=>x.metric+':'+x.status).join('; '));
  console.log(JSON.stringify(s7.sources));
})().catch((e) => { console.error(e); process.exit(1); });
