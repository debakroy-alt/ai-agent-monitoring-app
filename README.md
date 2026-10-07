# AI Agent Runtime Assurance

A polished, executive-first monitoring dashboard for AI agents. The UI dynamically renders any number of agents and uses four honest states: Healthy, Watch, Action required, and Not monitored.

## Included
- Responsive React/Vite frontend
- Executive portfolio and agent drill-down
- Health, risk, cost, threshold, and telemetry-coverage views
- Safe demo fallback if the API is unavailable
- Azure Static Web Apps configuration
- Azure Functions API placeholder

## Run locally
```bash
npm install
npm run dev
```

## Build check
```bash
npm run build
npm run preview
```

## Push to GitHub
Create an empty repository, then run:
```bash
git init
git add .
git commit -m "Initial AI agent assurance dashboard"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

## Deploy using Azure Static Web Apps
In Azure Portal, create **Static Web App**, choose GitHub and this repository, and use:
- Build preset: React
- App location: `/`
- API location: `api`
- Output location: `dist`

Azure creates a GitHub Actions workflow. Future pushes to `main` redeploy the application.

## Connect live telemetry
The app first calls `GET /api/agents`. If that fails, it intentionally loads `src/demoData.js` and labels the experience **Demo data**.

Implement the server-side adapter in `api/agents/index.js` and return:
```json
{"mode":"live","agents":[{"id":"stable-id","name":"Agent name","provider":"Microsoft Copilot Studio","environment":"Demo","updated":"2 min ago","volume":100,"trend":[10,20,18],"statuses":{"overall":"green","health":"green","risk":"unknown","cost":"unknown"},"metrics":{"health":[],"risk":[],"cost":[]}}]}
```

### First telemetry tasks
1. Run a KQL query that lists candidate values in `customDimensions` for both agents.
2. Choose the field that uniquely and consistently identifies an agent.
3. Create one aggregation query per pillar/time window, grouped by that field.
4. Transform query results into the contract above.
5. Store read credentials only in Azure application settings or an approved secret store.

### Important access note
The Copilot Studio/Application Insights connection string is an instrumentation path for sending telemetry. Do not embed it in the frontend or assume it grants query access. Validate an approved server-side read method before enabling live mode.

## Adding more agents
No frontend change is required. The API must return an additional item in `agents`. For automatic discovery, group telemetry by a stable agent identifier rather than maintaining a hardcoded list.

## Demo checklist
- Verify the top-right badge says Demo data or Live telemetry as expected.
- Open both agent cards and each Health/Risk/Cost tab.
- Confirm gray data is described as unavailable, never healthy.
- Test at a client-presentation screen resolution.
- Keep the demo fallback enabled until the live read path is proven reliable.
