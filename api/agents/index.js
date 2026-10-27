const { DefaultAzureCredential } = require('@azure/identity');

const severityRank = { unknown: 0, green: 1, amber: 2, red: 3 };

function worstStatus(...statuses) {
  return statuses.reduce(
    (worst, current) => (severityRank[current] > severityRank[worst] ? current : worst),
    'unknown'
  );
}

function errorRateStatus(conversations, errorRate) {
  if (conversations < 5) return 'unknown';
  if (errorRate >= 10) return 'red';
  if (errorRate >= 5) return 'amber';
  return 'green';
}

function responseStatus(conversations, responseRate) {
  if (conversations < 5) return 'unknown';
  if (responseRate < 90) return 'red';
  if (responseRate < 95) return 'amber';
  return 'green';
}

function formatAge(timestamp) {
  const milliseconds = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} day(s) ago`;
}

module.exports = async function (context) {
  try {
    const workspaceId = process.env.LOG_ANALYTICS_WORKSPACE_ID;
    if (!workspaceId) {
      throw new Error('LOG_ANALYTICS_WORKSPACE_ID is not configured.');
    }

    const requestedDays = Number(process.env.TELEMETRY_LOOKBACK_DAYS || 30);
    const lookbackDays = Math.min(Math.max(requestedDays, 1), 90);
    const credential = new DefaultAzureCredential();
    const token = await credential.getToken('https://api.loganalytics.io/.default');

    const query = `
let ConversationAgentMap =
    AppEvents
    | where TimeGenerated between (ago(${lookbackDays}d) .. now())
    | extend
        ConversationId = tostring(Properties["conversationId"]),
        RecipientName = tostring(Properties["recipientName"]),
        TopicId = tostring(Properties["TopicId"])
    | extend AgentFromTopicId = extract(@"^(.+?)\.topic\.", 1, TopicId)
    | extend CandidateAgentId = case(
        isnotempty(RecipientName), RecipientName,
        isnotempty(AgentFromTopicId), AgentFromTopicId,
        ""
    )
    | where isnotempty(ConversationId) and isnotempty(CandidateAgentId)
    | summarize AgentId = take_any(CandidateAgentId) by ConversationId;
let ConversationHealth =
    AppEvents
    | where TimeGenerated between (ago(${lookbackDays}d) .. now())
    | extend ConversationId = tostring(Properties["conversationId"])
    | where isnotempty(ConversationId)
    | join kind=inner ConversationAgentMap on ConversationId
    | summarize
        MessagesReceived = countif(Name == "BotMessageReceived"),
        MessagesSent = countif(Name == "BotMessageSend"),
        TopicEnds = countif(Name == "TopicEnd"),
        ErrorEvents = countif(Name == "OnErrorLog"),
        FirstEvent = min(TimeGenerated),
        LastEvent = max(TimeGenerated)
        by AgentId, ConversationId
    | extend
        HasResponse = MessagesSent > 0,
        HasTopicEnd = TopicEnds > 0,
        HasError = ErrorEvents > 0;
ConversationHealth
| summarize
    Conversations = count(),
    ConversationsWithResponse = countif(HasResponse),
    ConversationsWithTopicEnd = countif(HasTopicEnd),
    AffectedConversations = countif(HasError),
    ErrorEvents = sum(ErrorEvents),
    MessagesReceived = sum(MessagesReceived),
    MessagesSent = sum(MessagesSent),
    FirstSeen = min(FirstEvent),
    LastSeen = max(LastEvent)
    by AgentId
| extend
    ResponseRatePercent = round(
        100.0 * todouble(ConversationsWithResponse) / todouble(Conversations), 2
    ),
    TopicEndCoveragePercent = round(
        100.0 * todouble(ConversationsWithTopicEnd) / todouble(Conversations), 2
    ),
    ConversationErrorRatePercent = round(
        100.0 * todouble(AffectedConversations) / todouble(Conversations), 2
    )
| order by LastSeen desc
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
      throw new Error(
        result?.error?.message || `Log Analytics returned HTTP ${response.status}`
      );
    }

    const table = result.tables?.[0];
    if (!table) throw new Error('Log Analytics returned no result table.');

    const rawRows = table.rows.map((row) =>
      Object.fromEntries(table.columns.map((column, index) => [column.name, row[index]]))
    );

    const agents = rawRows.map((row) => {
      const conversations = Number(row.Conversations || 0);
      const responseRate = Number(row.ResponseRatePercent || 0);
      const errorRate = Number(row.ConversationErrorRatePercent || 0);
      const response = responseStatus(conversations, responseRate);
      const errors = errorRateStatus(conversations, errorRate);
      const health = worstStatus(response, errors);
      const risk = errors;
      const cost = 'unknown';
      const overall = worstStatus(health, risk);

      return {
        id: row.AgentId,
        name: row.AgentId,
        purpose: 'Purpose is not available from runtime telemetry.',
        provider: 'Microsoft Copilot Studio',
        environment: 'Design mode telemetry',
        updated: formatAge(row.LastSeen),
        volume: conversations,
        trend: [
          Number(row.MessagesReceived || 0),
          Number(row.MessagesSent || 0),
          Number(row.ErrorEvents || 0),
        ],
        statuses: { overall, health, risk, cost },
        metrics: {
          health: [
            {
              name: 'Response coverage',
              value: `${responseRate}%`,
              status: response,
              why:
                conversations < 5
                  ? 'Insufficient sample size'
                  : 'Conversations containing at least one agent response',
              threshold: 'Green >= 95%; red < 90%',
            },
            {
              name: 'Topic-end coverage',
              value: `${Number(row.TopicEndCoveragePercent || 0)}%`,
              status: conversations < 5 ? 'unknown' : 'amber',
              why: 'Observed coverage only; not treated as task success',
              threshold: 'Informational metric',
            },
          ],
          risk: [
            {
              name: 'Conversation error rate',
              value: `${errorRate}%`,
              status: errors,
              why: `${Number(row.AffectedConversations || 0)} conversations contained OnErrorLog`,
              threshold: 'Amber >= 5%; red >= 10%',
            },
            {
              name: 'Error events',
              value: String(Number(row.ErrorEvents || 0)),
              status: errors,
              why: 'Aggregated OnErrorLog events; raw messages are not exposed',
              threshold: 'Status follows conversation error rate',
            },
          ],
          cost: [
            {
              name: 'Token consumption',
              value: 'Not available',
              status: 'unknown',
              why: 'Token telemetry is not present in the current feed',
              threshold: 'No threshold',
            },
          ],
        },
      };
    });

    context.res = {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: {
        mode: 'live',
        lookbackDays,
        generatedAt: new Date().toISOString(),
        agentCount: agents.length,
        agents,
      },
    };
  } catch (error) {
    context.log.error('Live telemetry query failed.', error);
    context.res = {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: {
        mode: 'error',
        message: 'Live telemetry could not be retrieved.',
        technicalDetail:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
    };
  }
};
