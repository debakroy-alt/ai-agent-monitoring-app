cat > api/agents/index.js <<'EOF'
const { DefaultAzureCredential } = require('@azure/identity');

module.exports = async function (context) {
  try {
    const workspaceId = process.env.LOG_ANALYTICS_WORKSPACE_ID;

    if (!workspaceId) {
      context.res = {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          mode: 'error',
          message: 'LOG_ANALYTICS_WORKSPACE_ID is not configured.',
        },
      };

      return;
    }

    const rawLookbackDays = Number(
      process.env.TELEMETRY_LOOKBACK_DAYS || 30
    );

    const lookbackDays = Math.min(
      Math.max(rawLookbackDays, 1),
      90
    );

    const credential = new DefaultAzureCredential();

    const token = await credential.getToken(
      'https://api.loganalytics.io/.default'
    );

    const query = `
let ConversationAgentMap =
    AppEvents
    | where TimeGenerated between (
        ago(${lookbackDays}d) .. now()
    )
    | extend
        ConversationId =
            tostring(Properties["conversationId"]),
        RecipientName =
            tostring(Properties["recipientName"]),
        TopicId =
            tostring(Properties["TopicId"])
    | extend
        AgentFromTopicId =
            extract(
                @"^(.+?)\\.topic\\.",
                1,
                TopicId
            )
    | extend
        CandidateAgentId =
            case(
                isnotempty(RecipientName),
                RecipientName,
                isnotempty(AgentFromTopicId),
                AgentFromTopicId,
                ""
            )
    | where
        isnotempty(ConversationId)
        and isnotempty(CandidateAgentId)
    | summarize
        AgentId = take_any(CandidateAgentId)
        by ConversationId;

AppEvents
| where TimeGenerated between (
    ago(${lookbackDays}d) .. now()
)
| extend
    ConversationId =
        tostring(Properties["conversationId"])
| where isnotempty(ConversationId)
| join kind=inner
    ConversationAgentMap
    on ConversationId
| summarize
    EventCount = count(),
    Conversations = dcount(ConversationId),
    MessagesReceived =
        countif(Name == "BotMessageReceived"),
    MessagesSent =
        countif(Name == "BotMessageSend"),
    TopicStarts =
        countif(Name == "TopicStart"),
    TopicEnds =
        countif(Name == "TopicEnd"),
    ErrorEvents =
        countif(Name == "OnErrorLog"),
    AffectedConversations =
        dcountif(
            ConversationId,
            Name == "OnErrorLog"
        ),
    FirstSeen = min(TimeGenerated),
    LastSeen = max(TimeGenerated)
    by AgentId
| extend
    ResponseCoveragePercent =
        round(
            100.0
            * todouble(MessagesSent > 0),
            2
        ),
    ConversationErrorRatePercent =
        round(
            100.0
            * todouble(AffectedConversations)
            / todouble(Conversations),
            2
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
        result?.error?.message ||
          `Log Analytics returned HTTP ${response.status}`
      );
    }

    const table = result.tables?.[0];

    if (!table) {
      throw new Error(
        'Log Analytics returned no result table.'
      );
    }

    const rows = table.rows.map((row) =>
      Object.fromEntries(
        table.columns.map((column, index) => [
          column.name,
          row[index],
        ])
      )
    );

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
        agentCount: rows.length,
        agents: rows,
      },
    };
  } catch (error) {
    context.log.error(
      'Live telemetry query failed.',
      error
    );

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
          process.env.NODE_ENV === 'development'
            ? error.message
            : undefined,
      },
    };
