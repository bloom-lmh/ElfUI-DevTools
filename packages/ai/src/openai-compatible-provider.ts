import type { ScreenshotAsset } from "@elfui/devtools-shared";

import {
  fromAIAgentWireToolName,
  getAIAgentToolDefinition,
  type AIAgentToolResult,
} from "./agent-protocol.js";
import { summarizeAIChangeRequest } from "./intent-summary.js";
import {
  AIProviderError,
  type AIProvider,
  type AIProviderDescriptor,
  type AIProviderEvent,
  type AIProviderRequest,
  type AIProviderStreamOptions,
} from "./provider.js";

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/responses";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface OpenAICompatibleProviderOptions {
  id?: string;
  label?: string;
  description?: string;
  apiKey: string | (() => string | undefined);
  models: AIProviderDescriptor["models"];
  defaultModelId: string;
  endpoint?: string;
  allowsEndpointOverride?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  supportsImageInput?: boolean;
  supportsToolCalling?: boolean;
  resolveScreenshot?: (
    screenshot: ScreenshotAsset,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
}

interface OpenAIStreamEvent {
  type?: unknown;
  delta?: unknown;
  sequence_number?: unknown;
  error?: unknown;
  response?: unknown;
  item?: unknown;
}

const abortError = (): Error => {
  const error = new Error("AI execution was cancelled");
  error.name = "AbortError";
  return error;
};

const providerErrorForStatus = (status: number): AIProviderError => {
  if (status === 401 || status === 403)
    return new AIProviderError(
      "AI_PROVIDER_AUTH_FAILED",
      `OpenAI-compatible provider authentication failed with HTTP ${status}`,
      false,
    );
  if (status === 429)
    return new AIProviderError(
      "AI_PROVIDER_RATE_LIMITED",
      "OpenAI-compatible provider rate limit exceeded",
      true,
    );
  return new AIProviderError(
    "AI_PROVIDER_HTTP_FAILED",
    `OpenAI-compatible provider request failed with HTTP ${status}`,
    status >= 500 || status === 408,
  );
};

const promptFor = (request: AIProviderRequest): string => {
  const summary = summarizeAIChangeRequest(request.changeRequest);
  const sourceContext = request.changeRequest.sourceContext
    .filter((block) => typeof block.content === "string")
    .map(
      (block) =>
        `Source ${block.sourceId}${block.templateNodeId ? ` (${block.templateNodeId})` : ""}:\n${block.content}`,
    )
    .join("\n\n");
  const approvedPatches = (request.agent?.approvedPatches ?? [])
    .map(
      (patch) =>
        `proposalId=${patch.proposalId}; approvalId=${patch.approvalId}; files=${patch.affectedFiles.join(",")}; summary=${patch.summary}`,
    )
    .join("\n");
  const canApply = request.agent?.availableTools.includes(
    "patch.applyApproved",
  );
  const task = canApply
    ? "An explicit Node-validated user approval is available. You may call patch.applyApproved with exactly the supplied proposalId and approvalId; do not claim success until the tool returns a verified result."
    : request.mode === "plan"
      ? "Produce a read-only implementation plan. Do not write files or claim that changes were applied."
      : "Explain the current UI and requested visual result. Do not write files or claim that changes were applied.";
  return [
    task,
    request.changeRequest.userMessage
      ? `User request:\n${request.changeRequest.userMessage}`
      : "",
    summary.text ? `Structured visual context:\n${summary.text}` : "",
    sourceContext ? `Approved source context:\n${sourceContext}` : "",
    approvedPatches
      ? `Explicitly approved Patch transactions:\n${approvedPatches}`
      : "",
    "Preserve responsive layout, accessibility, and public APIs.",
  ]
    .filter(Boolean)
    .join("\n\n");
};

const toolResultOutput = (result: AIAgentToolResult): string =>
  JSON.stringify(
    result.status === "completed"
      ? { status: result.status, output: result.output }
      : { status: result.status, error: result.error },
  );

const appendAgentInput = (
  input: Array<Record<string, unknown>>,
  request: AIProviderRequest,
): void => {
  for (const exchange of request.agent?.exchanges ?? []) {
    for (const call of exchange.calls)
      input.push({
        type: "function_call",
        call_id: call.id,
        name: getAIAgentToolDefinition(call.name).wireName,
        arguments: JSON.stringify(call.arguments),
      });
    for (const result of exchange.results)
      input.push({
        type: "function_call_output",
        call_id: result.callId,
        output: toolResultOutput(result),
      });
  }
};

const openAIToolsFor = (
  request: AIProviderRequest,
): Record<string, unknown>[] =>
  (request.agent?.availableTools ?? []).map((name) => {
    const definition = getAIAgentToolDefinition(name);
    return {
      type: "function",
      name: definition.wireName,
      description: definition.description,
      parameters: definition.inputSchema,
      strict: false,
    };
  });

const openAIToolCall = (
  event: OpenAIStreamEvent,
): Extract<AIProviderEvent, { type: "tool-call" }> | undefined => {
  if (
    event.type !== "response.output_item.done" ||
    event.item === null ||
    typeof event.item !== "object"
  )
    return undefined;
  const item = event.item as Record<string, unknown>;
  if (
    item.type !== "function_call" ||
    typeof item.call_id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.arguments !== "string"
  )
    return undefined;
  return {
    type: "tool-call",
    call: {
      id: item.call_id,
      name: fromAIAgentWireToolName(item.name) ?? item.name,
      arguments: item.arguments,
    },
  };
};

const parseSSEBlocks = async function* (
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  } finally {
    reader.releaseLock();
  }
};

const eventErrorMessage = (event: OpenAIStreamEvent): string => {
  if (
    event.error !== null &&
    typeof event.error === "object" &&
    "message" in event.error &&
    typeof event.error.message === "string"
  )
    return event.error.message;
  if (
    event.response !== null &&
    typeof event.response === "object" &&
    "error" in event.response &&
    event.response.error !== null &&
    typeof event.response.error === "object" &&
    "message" in event.response.error &&
    typeof event.response.error.message === "string"
  )
    return event.response.error.message;
  return "OpenAI-compatible provider returned an unsuccessful response";
};

export class OpenAICompatibleProvider implements AIProvider {
  public readonly descriptor: AIProviderDescriptor;
  private readonly getApiKey: () => string | undefined;
  private readonly endpoint: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private readonly resolveScreenshot:
    | OpenAICompatibleProviderOptions["resolveScreenshot"]
    | undefined;

  public constructor(options: OpenAICompatibleProviderOptions) {
    this.descriptor = {
      id: options.id ?? "openai-compatible",
      label: options.label ?? "OpenAI-compatible",
      ...(options.description ? { description: options.description } : {}),
      capabilities: {
        text: true,
        imageInput:
          options.supportsImageInput === true ||
          options.resolveScreenshot !== undefined,
        toolCalling: false,
        structuredOutput: false,
        reasoning: false,
        temperature: false,
      },
      models: options.models,
      defaultModelId: options.defaultModelId,
      allowsCustomModelId: true,
      ...(options.allowsEndpointOverride === true
        ? { allowsEndpointOverride: true }
        : {}),
    };
    if (typeof options.apiKey === "function") this.getApiKey = options.apiKey;
    else {
      const apiKey = options.apiKey;
      this.getApiKey = () => apiKey;
    }
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs =
      typeof options.timeoutMs === "number" &&
      Number.isSafeInteger(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    this.resolveScreenshot = options.resolveScreenshot;
    this.descriptor.capabilities.toolCalling =
      options.supportsToolCalling === true;
  }

  public async *stream(
    request: AIProviderRequest,
    options: AIProviderStreamOptions,
  ): AsyncIterable<AIProviderEvent> {
    if (options.signal.aborted) throw abortError();
    const apiKey = this.getApiKey();
    if (!apiKey)
      throw new AIProviderError(
        "AI_PROVIDER_AUTH_MISSING",
        "OpenAI-compatible provider API key is not configured",
        false,
      );
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const content: Array<Record<string, unknown>> = [
        { type: "input_text", text: promptFor(request) },
      ];
      const resolveScreenshot =
        request.resolveScreenshot ?? this.resolveScreenshot;
      if (
        request.negotiation.capabilities.imageInput &&
        !request.negotiation.downgraded.includes("image-input") &&
        resolveScreenshot
      )
        for (const screenshot of request.changeRequest.screenshots) {
          const imageUrl = await resolveScreenshot(
            screenshot,
            controller.signal,
          );
          if (imageUrl)
            content.push({
              type: "input_image",
              image_url: imageUrl,
              detail: "auto",
            });
        }
      const input: Array<Record<string, unknown>> = [{ role: "user", content }];
      appendAgentInput(input, request);
      const body: Record<string, unknown> = {
        model: request.settings.modelId,
        input,
        stream: true,
        store: false,
      };
      const tools = openAIToolsFor(request);
      if (
        tools.length > 0 &&
        request.negotiation.capabilities.toolCalling &&
        !request.negotiation.downgraded.includes("tool-calling")
      ) {
        body.tools = tools;
        body.parallel_tool_calls = true;
      }
      if (request.settings.maxOutputTokens !== undefined)
        body.max_output_tokens = request.settings.maxOutputTokens;
      if (request.settings.temperature !== undefined)
        body.temperature = request.settings.temperature;
      if (
        request.settings.reasoning !== undefined &&
        request.settings.reasoning !== "none"
      )
        body.reasoning = { effort: request.settings.reasoning };

      let response: Response;
      try {
        response = await this.fetchImplementation(
          request.settings.endpoint ?? this.endpoint,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
              accept: "text/event-stream",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );
      } catch (error) {
        if (options.signal.aborted) throw abortError();
        if (controller.signal.aborted)
          throw new AIProviderError(
            "AI_PROVIDER_TIMEOUT",
            "OpenAI-compatible provider request timed out",
            true,
          );
        throw new AIProviderError(
          "AI_PROVIDER_CONNECTION_FAILED",
          error instanceof Error
            ? error.message
            : "OpenAI-compatible provider connection failed",
          true,
        );
      }
      if (!response.ok) throw providerErrorForStatus(response.status);
      if (!response.body)
        throw new AIProviderError(
          "AI_PROVIDER_STREAM_INVALID",
          "OpenAI-compatible provider returned no response body",
          true,
        );

      let completed = false;
      let lastSequence = -1;
      for await (const data of parseSSEBlocks(
        response.body,
        controller.signal,
      )) {
        if (data === "[DONE]") break;
        let event: OpenAIStreamEvent;
        try {
          event = JSON.parse(data) as OpenAIStreamEvent;
        } catch {
          throw new AIProviderError(
            "AI_PROVIDER_STREAM_INVALID",
            "OpenAI-compatible provider returned invalid SSE JSON",
            true,
          );
        }
        if (
          typeof event.sequence_number === "number" &&
          Number.isSafeInteger(event.sequence_number)
        ) {
          if (event.sequence_number <= lastSequence)
            throw new AIProviderError(
              "AI_PROVIDER_STREAM_OUT_OF_ORDER",
              "OpenAI-compatible provider returned out-of-order stream events",
              true,
            );
          lastSequence = event.sequence_number;
        }
        if (event.type === "response.output_text.delta") {
          if (typeof event.delta !== "string")
            throw new AIProviderError(
              "AI_PROVIDER_STREAM_INVALID",
              "OpenAI-compatible provider returned an invalid text delta",
              true,
            );
          yield { type: "text-delta", text: event.delta };
        } else {
          const toolCall = openAIToolCall(event);
          if (toolCall) yield toolCall;
          else if (event.type === "response.completed") {
            completed = true;
            yield { type: "completed" };
            return;
          } else if (
            event.type === "error" ||
            event.type === "response.failed" ||
            event.type === "response.incomplete"
          )
            throw new AIProviderError(
              "AI_PROVIDER_RESPONSE_FAILED",
              eventErrorMessage(event),
              true,
            );
        }
      }
      if (!completed)
        throw new AIProviderError(
          "AI_PROVIDER_STREAM_INCOMPLETE",
          "OpenAI-compatible provider stream ended without response.completed",
          true,
        );
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}
