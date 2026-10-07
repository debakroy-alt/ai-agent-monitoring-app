import { AzureCliCredential } from '@azure/identity';

const workspaceId = process.env.LOG_ANALYTICS_WORKSPACE_ID;

if (!workspaceId) {
  console.error('LOG_ANALYTICS_WORKSPACE_ID is not set.');
  process.exit(1);
}

const credential = new AzureCliCredential();

const token = await credential.getToken('https://api.loganalytics.io/.default');

const query = `
AppEvents
| where TimeGenerated between (ago(30d) .. now())
| summarize
    EventCount = count(),
    Conversations = dcount(tostring(Properties["conversationId"]))
`;

const response = await fetch(
  `https://api.loganalytics.azure.com/v1/workspaces/${workspaceId}/query`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  }
);

const result = await response.json();

if (!response.ok) {
  console.error('Query failed:', JSON.stringify(result, null, 2));
  process.exit(1);
}

const table = result.tables?.[0];

if (!table || !table.rows?.length) {
  console.error('The query returned no table rows.');
  process.exit(1);
}

const row = Object.fromEntries(
  table.columns.map((column, index) => [column.name, table.rows[0][index]])
);

console.log('Node workspace query succeeded.');
console.log(row);
