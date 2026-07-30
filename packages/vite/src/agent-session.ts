import {
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  isAIAgentToolCall,
  isAIAgentToolResult,
  AIProviderError,
  type AIAgentToolCall,
  type AIAgentToolName,
  type AIAgentToolResult,
  type AIProvider,
  type AIProviderApprovedPatch,
  type AIProviderEvent,
  type AIProviderRequest,
} from "@elfui/devtools-ai";

const MAX_AGENT_TURNS = 8;
const MAX_AGENT_TOOL_CALLS = 20;
const MAX_AGENT_TOOL_CALLS_PER_TURN = 8;
const MAX_AGENT_PROVIDER_CHARACTERS = 512_000;
const MAX_AGENT_TOOL_RESULT_CHARACTERS = 256_000;

export type AIAgentSessionEvent =
  | AIProviderEvent
  | { type: "tool-result"; result: AIAgentToolResult };

export interface AIAgentSessionOptions {
  provider: AIProvider;
  request: Omit<AIProviderRequest, "agent">;
  signal: AbortSignal;
  availableTools: AIAgentToolName[];
  approvedPatches?: AIProviderApprovedPatch[];
  executeTool(call: AIAgentToolCall): Promise<AIAgentToolResult>;
}

const providerError = (code: string, message: string): AIProviderError =>
  new AIProviderError(code, message, false);

const parseToolCall = (
  executionId: string,
  event: Extract<AIProviderEvent, { type: "tool-call" }>,
): AIAgentToolCall => {
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(event.call.arguments) as unknown;
  } catch {
    throw providerError(
      "AI_AGENT_TOOL_CALL_INVALID",
      "AI provider returned tool arguments that are not valid JSON",
    );
  }
  const call = {
    schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
    id: event.call.id,
    executionId,
    name: event.call.name,
    arguments: argumentsValue,
  };
  if (!isAIAgentToolCall(call))
    throw providerError(
      "AI_AGENT_TOOL_CALL_INVALID",
      "AI provider returned a tool call outside the bounded Agent protocol",
    );
  return call;
};

const eventCharacters = (event: AIProviderEvent): number => {
  switch (event.type) {
    case "text-delta":
      return event.text.length;
    case "tool-call":
      return (
        event.call.id.length +
        event.call.name.length +
        event.call.arguments.length
      );
    case "structured-output":
      return JSON.stringify(event.value).length;
    case "completed":
      return 0;
  }
};

export const runAIAgentSession = async function* (
  options: AIAgentSessionOptions,
): AsyncIterable<AIAgentSessionEvent> {
  const callIds = new Set<string>();
  const exchanges: Array<{
    calls: AIAgentToolCall[];
    results: AIAgentToolResult[];
  }> = [];
  let providerCharacters = 0;
  let toolResultCharacters = 0;
  let toolCalls = 0;

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
    const pendingCalls: AIAgentToolCall[] = [];
    let turnCompleted = false;
    for await (const event of options.provider.stream(
      {
        ...options.request,
        agent: {
          turn,
          availableTools: [...options.availableTools],
          approvedPatches: JSON.parse(
            JSON.stringify(options.approvedPatches ?? []),
          ) as AIProviderApprovedPatch[],
          exchanges: JSON.parse(JSON.stringify(exchanges)) as typeof exchanges,
        },
      },
      { signal: options.signal },
    )) {
      if (turnCompleted)
        throw providerError(
          "AI_AGENT_TURN_INVALID",
          "AI provider emitted events after completing an Agent turn",
        );
      providerCharacters += eventCharacters(event);
      if (providerCharacters > MAX_AGENT_PROVIDER_CHARACTERS)
        throw providerError(
          "AI_AGENT_OUTPUT_BUDGET_EXCEEDED",
          "AI provider exceeded the Agent session output budget",
        );
      if (event.type === "tool-call") {
        const call = parseToolCall(options.request.executionId, event);
        if (!options.availableTools.includes(call.name))
          throw providerError(
            "AI_AGENT_TOOL_NOT_AVAILABLE",
            "AI provider requested a tool that is not available in this session",
          );
        if (callIds.has(call.id))
          throw providerError(
            "AI_AGENT_TOOL_CALL_DUPLICATE",
            "AI provider reused an Agent tool call id",
          );
        callIds.add(call.id);
        pendingCalls.push(call);
        toolCalls += 1;
        if (
          pendingCalls.length > MAX_AGENT_TOOL_CALLS_PER_TURN ||
          toolCalls > MAX_AGENT_TOOL_CALLS
        )
          throw providerError(
            "AI_AGENT_TOOL_BUDGET_EXCEEDED",
            "AI provider exceeded the Agent tool call budget",
          );
        yield {
          type: "tool-call",
          call: {
            id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        };
      } else if (event.type === "completed") turnCompleted = true;
      else yield event;
    }
    if (!turnCompleted)
      throw providerError(
        "AI_AGENT_TURN_INCOMPLETE",
        "AI provider stream ended without completing the Agent turn",
      );
    if (pendingCalls.length === 0) {
      yield { type: "completed" };
      return;
    }

    const results: AIAgentToolResult[] = [];
    for (const call of pendingCalls) {
      const result = await options.executeTool(call);
      if (
        !isAIAgentToolResult(result) ||
        result.callId !== call.id ||
        result.name !== call.name
      )
        throw providerError(
          "AI_AGENT_TOOL_RESULT_INVALID",
          "AI Agent tool returned an invalid or mismatched result",
        );
      const serialized = JSON.stringify(result);
      toolResultCharacters += serialized.length;
      if (toolResultCharacters > MAX_AGENT_TOOL_RESULT_CHARACTERS)
        throw providerError(
          "AI_AGENT_TOOL_RESULT_BUDGET_EXCEEDED",
          "AI Agent tools exceeded the session result budget",
        );
      results.push(JSON.parse(serialized) as AIAgentToolResult);
      yield { type: "tool-result", result };
    }
    exchanges.push({
      calls: JSON.parse(JSON.stringify(pendingCalls)) as AIAgentToolCall[],
      results,
    });
  }
  throw providerError(
    "AI_AGENT_TURN_BUDGET_EXCEEDED",
    "AI provider exceeded the Agent turn budget",
  );
};
