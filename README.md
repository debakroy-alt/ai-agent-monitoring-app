# AI Agent Runtime Monitoring — Grant Thornton

A near real-time executive dashboard for AI agents that shows **Health, Risk and Cost** in a single view. Every red, amber or green status is calculated automatically from runtime telemetry and the AI system inventory. Nothing is entered by hand.

## What changed in v2 (based on Derek's email and the 13 Oct review)

| Ask | Where it is |
|---|---|
| Group agents by department, with drill-down; filter by location and other fields | **Agent Portfolio** tab: group by Department / Location / Platform / Environment, plus filters |
| About 8 executive tiles instead of 4: monitored, alerts, out of compliance, high-risk in production, cost | **Executive Overview**: 8 KPI tiles, most of them clickable to open the filtered portfolio |
| Department distribution with drill-down | **Executive Overview** › Departments |
| Health defined as availability, completion, latency, errors/retries and dependency | Health is rebuilt around those 5 components (worst component wins) |
| Thresholds defined | **Metric Library**: one shared set of thresholds for all agents |
| Common risk metrics that apply to every agent, plus use-case rules later | Risk baseline: prompt-injection/jailbreak blocks and content-safety blocks. Data leakage and unapproved tool calls are defined but wait for a data source |
| Cost = token consumption | Read from OpenTelemetry `gen_ai.*` token data (Foundry). Shown grey for Copilot Studio |
| List the metrics behind Health and Risk | **Metric Library** tab, served from `api/shared/metrics-registry.js` |
| One clean view, no hopping between tabs | Each agent card shows Health, Risk and Cost; each one opens the matching evidence |
| No manual data | Values come from telemetry. Agent metadata and compliance checks come from the inventory |
| A metric library that's easy to maintain | Single registry file. Change a threshold once and it applies everywhere |

**Bug fixes:** the API now honours `?days=`. The UI fields (`series`, `errorEvents`, etc.) now match the API response. Calling `setSelected` during render has been removed. Agent ID resolution now reads the bot name only from the correct event type.

## Project layout

```
index.html, vite.config.js, package.json, staticwebapp.config.json
public/fonts/                 GT Walsheim .woff2 files go here (not committed)
src/main.jsx                  UI
src/Help.jsx                  In-app guide ("How it works" / ? button)
src/styles.css                GT theme (dark default + light)
src/demoData.js               Generated demo snapshot. Only loaded on "Show demo data"
api/agents/index.js           GET /api/agents?days=1|7|30|90
api/shared/metrics-registry.js  Metric library: definitions, sources, thresholds
api/shared/inventory.js       AI inventory adapter
api/shared/agent-inventory.json Stand-in inventory until the registry is connected
tools/gen-demo.cjs            Rebuilds demoData.js by running the real API with synthetic telemetry
```

## Configuration (Azure app settings)

| Setting | Required | Purpose |
|---|---|---|
| `LOG_ANALYTICS_WORKSPACE_ID` | yes | Workspace behind the Copilot Studio Application Insights resource |
| `TIMEOUT_SECONDS` | no (30) | A reply slower than this counts as a timeout |
| `INVENTORY_URL` | recommended | JSON endpoint for the AI inventory (SharePoint list via Graph, Dataverse, OneTrust…). Accepts `[...]` or `{ value: [...] }` |
| `INVENTORY_SCOPE` | if the inventory needs auth | Managed-identity scope, e.g. `https://graph.microsoft.com/.default` |
| `PRICE_INPUT_PER_1K_USD` / `PRICE_OUTPUT_PER_1K_USD` | for $ cost | Converts token counts into spend |

The Function's managed identity needs **Log Analytics Reader** on the workspace.

### Inventory fields
`id` (telemetry agent id), `aliases[]`, `displayName`, `purpose`, `department`, `location`, `businessOwner`, `technicalOwner`, `platform`, `riskTier`, `approvalStatus`, `productionSince`, `monthlyBudgetUsd`, `allowedConnectors[]`, `tags[]`. Common alternatives such as `Title`, `BusinessUnit` and `goLiveDate` are mapped automatically.

**First step:** open **Data Checks**. It lists the telemetry IDs that have no inventory record. Copy those IDs into the inventory (`id` or `aliases`), and the department grouping and owner details will appear.

## Run locally
```
npm install
cd api && npm install && cd ..
npm run dev          # UI on :5173, proxies /api to :7071
cd api && func start # Functions API
```
If the API can't be reached, the UI shows an error banner and a **Show demo data** button. Demo data is always clearly labelled.

## Fonts
GT Walsheim is a licensed GT brand font. Place `GTWalsheim-Regular.woff2`, `-Medium.woff2` and `-Bold.woff2` in `public/fonts/`. Don't commit them to a public repo. Without these files, the UI falls back to a locally installed GT Walsheim, then Segoe UI.

## Known data limits (shown in the UI as grey, never green)
- Copilot Studio doesn't publish **token usage** or **dependency calls** to Application Insights. Cost and dependency health for these agents wait on Foundry/PurpleStratus access or a token gateway.
- **Retries**, **sensitive-data exposure** (needs Purview DSPM for AI) and **unapproved tool calls** are defined in the library but don't have a data source yet.
- The injection and content-safety checks match on `OnErrorLog.ErrorCodeText`. Before demoing to the client, confirm the exact codes in your workspace (`AppEvents | where Name == "OnErrorLog" | summarize count() by tostring(Properties.ErrorCodeText)`).
