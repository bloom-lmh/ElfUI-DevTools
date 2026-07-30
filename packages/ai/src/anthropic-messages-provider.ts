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

const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_API_VERSION = "2023-06-01";
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AnthropicMessagesProviderOptions {
  id?: string;
  label?: string;
  apiKey: string | (() => string | undefined);
  models: AIProviderDescriptor["models"];
  defaultModelId: string;
  endpoint?: string;
  apiVersion?: string;
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

const abortError = (): Error => {
  const error = new Error("AI execution was cancelled");
  error.name = "AbortError";
  return error;
};

const promptFor = (request: AIProviderRequest): string => {
  const summary = summarizeAIChangeRequest(request.changeRequest);
  const source = request.changeRequest.sourceContext
    .filter((block) => typeof block.content === "string")
    .map((block) => `Source ${block.sourceId}:\n${block.content}`)
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
  return [
    canApply
      ? "An explicit Node-validated user approval is available. You may call patch.applyApproved with exactly the supplied proposalId and approvalId; do not claim success until the tool returns a verified result."
      : request.mode === "plan"
        ? "Produce a read-only implementation plan. Do not write files."
        : "Explain the current UI and requested visual result. Do not write files.",
    request.changeRequest.userMessage,
    summary.text ? `Structured visual context:\n${summary.text}` : "",
    source ? `Approved source context:\n${source}` : "",
    approvedPatches
      ? `Explicitly approved Patch transactions:\n${approvedPatches}`
      : "",
    "Preserve responsive layout, accessibility, and public APIs.",
  ]
    .filter(Boolean)
    .join("\n\n");
};

const imageSource = (
  image: string,
):
  | { type: "base64"; media_type: string; data: string }
  | {
      type: "url";
      url: string;
    } => {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(image);
  return match
    ? { type: "base64", media_type: match[1]!, data: match[2]! }
    : { type: "url", url: image };
};

const toolResultContent = (result: AIAgentToolResult): string =>
  JSON.stringify(
    result.status === "completed"
      ? { status: result.status, output: result.output }
      : { status: result.status, error: result.error },
  );

const appendAgentMessages = (
  messages: Array<Record<string, unknown>>,
  request: AIProviderRequest,
): void => {
  for (const exchange of request.agent?.exchanges ?? []) {
    messages.push({
      role: "assistant",
      content: exchange.calls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: getAIAgentToolDefinition(call.name).wireName,
        input: call.arguments,
      })),
    });
    messages.push({
      role: "user",
      content: exchange.results.map((result) => ({
        type: "tool_result",
        tool_use_id: result.callId,
        content: toolResultContent(result),
        ...(result.status === "failed" ? { is_error: true } : {}),
      })),
    });
  }
};

const anthropicToolsFor = (
  request: AIProviderRequest,
): Record<string, unknown>[] =>
  (request.agent?.availableTools ?? []).map((name) => {
    const definition = getAIAgentToolDefinition(name);
    return {
      name: definition.wireName,
      description: definition.description,
      input_schema: definition.inputSchema,
    };
  });

const streamData = async function* (
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
  } finally {
    reader.releaseLock();
  }
};

export class AnthropicMessagesProvider implements AIProvider {
  public readonly descriptor: AIProviderDescriptor;
  private readonly getApiKey: () => string | undefined;
  private readonly endpoint: string;
  private readonly apiVersion: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private readonly resolveScreenshot:
    | AnthropicMessagesProviderOptions["resolveScreenshot"]
    | undefined;

  public constructor(options: AnthropicMessagesProviderOptions) {
    this.descriptor = {
      id: options.id ?? "anthropic-messages",
      label: options.label ?? "Anthropic Messages",
      capabilities: {
        text: true,
        imageInput:
          options.supportsImageInput === true ||
          options.resolveScreenshot !== undefined,
        toolCalling: false,
        structuredOutput: false,
        reasoning: false,
        temperature: true,
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
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
        "Anthropic Messages API key is not configured",
        false,
      );
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const content: Array<Record<string, unknown>> = [];
      const resolveScreenshot =
        request.resolveScreenshot ?? this.resolveScreenshot;
      if (
        request.negotiation.capabilities.imageInput &&
        !request.negotiation.downgraded.includes("image-input") &&
        resolveScreenshot
      )
        for (const screenshot of request.changeRequest.screenshots) {
          const image = await resolveScreenshot(screenshot, controller.signal);
          if (image)
            content.push({ type: "image", source: imageSource(image) });
        }
      content.push({ type: "text", text: promptFor(request) });
      const messages: Array<Record<string, unknown>> = [
        { role: "user", content },
      ];
      appendAgentMessages(messages, request);
      const body: Record<string, unknown> = {
        model: request.settings.modelId,
        max_tokens:
          request.settings.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        messages,
        stream: true,
      };
      const tools = anthropicToolsFor(request);
      if (
        tools.length > 0 &&
        request.negotiation.capabilities.toolCalling &&
        !request.negotiation.downgraded.includes("tool-calling")
      )
        body.tools = tools;
      if (request.settings.temperature !== undefined)
        body.temperature = request.settings.temperature;

      let response: Response;
      try {
        response = await this.fetchImplementation(
          request.settings.endpoint ?? this.endpoint,
          {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": this.apiVersion,
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
            "Anthropic Messages request timed out",
            true,
          );
        throw new AIProviderError(
          "AI_PROVIDER_CONNECTION_FAILED",
          error instanceof Error
            ? error.message
            : "Anthropic Messages connection failed",
          true,
        );
      }
      if (!response.ok)
        throw new AIProviderError(
          response.status === 429
            ? "AI_PROVIDER_RATE_LIMITED"
            : response.status === 401 || response.status === 403
              ? "AI_PROVIDER_AUTH_FAILED"
              : "AI_PROVIDER_HTTP_FAILED",
          `Anthropic Messages request failed with HTTP ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      if (!response.body)
        throw new AIProviderError(
          "AI_PROVIDER_STREAM_INVALID",
          "Anthropic Messages returned no response body",
          true,
        );

      const toolBlocks = new Map<
        number,
        { id: string; name: string; input: unknown; arguments: string }
      >();
      for await (const data of streamData(response.body, controller.signal)) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data) as Record<string, unknown>;
        } catch {
          throw new AIProviderError(
            "AI_PROVIDER_STREAM_INVALID",
            "Anthropic Messages returned invalid SSE JSON",
            true,
          );
        }
        if (
          event.type === "content_block_start" &&
          typeof event.index === "number" &&
          event.content_block !== null &&
          typeof event.content_block === "object"
        ) {
          const block = event.content_block as Record<string, unknown>;
          if (
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
          )
            toolBlocks.set(event.index, {
              id: block.id,
              name: block.name,
              input: block.input ?? {},
              arguments: "",
            });
        } else if (
          event.type === "content_block_delta" &&
          event.delta !== null &&
          typeof event.delta === "object" &&
          "type" in event.delta &&
          event.delta.type === "text_delta" &&
          "text" in event.delta &&
          typeof event.delta.text === "string"
        )
          yield { type: "text-delta", text: event.delta.text };
        else if (
          event.type === "content_block_delta" &&
          typeof event.index === "number" &&
          event.delta !== null &&
          typeof event.delta === "object" &&
          "type" in event.delta &&
          event.delta.type === "input_json_delta" &&
          "partial_json" in event.delta &&
          typeof event.delta.partial_json === "string"
        ) {
          const block = toolBlocks.get(event.index);
          if (block) block.arguments += event.delta.partial_json;
        } else if (
          event.type === "content_block_stop" &&
          typeof event.index === "number"
        ) {
          const block = toolBlocks.get(event.index);
          if (block) {
            toolBlocks.delete(event.index);
            yield {
              type: "tool-call",
              call: {
                id: block.id,
                name: fromAIAgentWireToolName(block.name) ?? block.name,
                arguments: block.arguments || JSON.stringify(block.input ?? {}),
              },
            };
          }
        } else if (event.type === "message_stop") {
          if (toolBlocks.size > 0)
            throw new AIProviderError(
              "AI_PROVIDER_STREAM_INVALID",
              "Anthropic Messages ended with an incomplete tool call",
              true,
            );
          yield { type: "completed" };
          return;
        } else if (event.type === "error")
          throw new AIProviderError(
            "AI_PROVIDER_RESPONSE_FAILED",
            "Anthropic Messages returned an error event",
            true,
          );
      }
      throw new AIProviderError(
        "AI_PROVIDER_STREAM_INCOMPLETE",
        "Anthropic Messages stream ended without message_stop",
        true,
      );
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}
