import type { AIChangeRequest } from "@elfui/devtools-shared";
import { describe, expect, it, vi } from "vitest";

import { DEVTOOLS_AI_AGENT_SCHEMA_VERSION } from "./agent-protocol";
import { OpenAICompatibleProvider } from "./openai-compatible-provider";
import type {
  AIProviderEvent,
  AIProviderNegotiation,
  AIProviderRequest,
} from "./provider";

const changeRequest = (): AIChangeRequest => ({
  schemaVersion: 1,
  id: "request:test",
  conversationId: "conversation:test",
  project: { framework: "elfui" },
  page: {
    url: "http://localhost/",
    route: "/",
    title: "Fixture",
    viewport: { width: 1280, height: 720 },
    devicePixelRatio: 1,
    scroll: { x: 0, y: 0 },
  },
  targets: [],
  intents: [],
  annotations: [],
  screenshots: [
    {
      id: "screenshot:desired",
      kind: "viewport",
      phase: "desired",
      mimeType: "image/png",
      width: 1280,
      height: 720,
      devicePixelRatio: 1,
      route: "/",
      scroll: { x: 0, y: 0 },
      capturedAt: 1,
      excludedRegions: [],
      byteLength: 128,
    },
  ],
  sourceContext: [
    {
      id: "source:test",
      sourceId: "src/Test.ts",
      content: "export const test = true;",
    },
  ],
  userMessage: "Explain the desired result",
  constraints: {
    preserveResponsiveLayout: true,
    preserveAccessibility: true,
    preservePublicAPI: true,
  },
  governance: {
    budget: {
      maxSourceBlocks: 12,
      maxSourceCharacters: 32_000,
      maxScreenshotBytes: 8_000_000,
      maxUserMessageCharacters: 4_000,
    },
    usage: {
      sourceBlocks: 1,
      sourceCharacters: 25,
      screenshotCount: 1,
      screenshotBytes: 128,
      userMessageCharacters: 26,
    },
    approvedSourceIds: ["src/Test.ts"],
    pendingSourceApprovals: [],
    omissions: [],
    redactions: [],
    userMessageTruncated: false,
  },
});

const negotiation = (): AIProviderNegotiation => ({
  status: "supported",
  providerId: "openai-compatible",
  modelId: "test-model",
  capabilities: {
    text: true,
    imageInput: true,
    toolCalling: false,
    structuredOutput: false,
    reasoning: true,
    temperature: true,
  },
  requirements: { required: ["text"], preferred: ["image-input"] },
  missingRequired: [],
  downgraded: [],
  notices: [],
});

const providerRequest = (): AIProviderRequest => ({
  executionId: "execution:test",
  mode: "explain",
  changeRequest: changeRequest(),
  settings: {
    modelId: "test-model",
    temperature: 0.3,
    reasoning: "low",
    maxOutputTokens: 2_048,
  },
  negotiation: negotiation(),
  resolveScreenshot: async () => "data:image/png;base64,aW1hZ2U=",
});

const sseResponse = (chunks: string[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );

const collect = async (
  provider: OpenAICompatibleProvider,
  request = providerRequest(),
): Promise<AIProviderEvent[]> => {
  const events: AIProviderEvent[] = [];
  for await (const event of provider.stream(request, {
    signal: new AbortController().signal,
  }))
    events.push(event);
  return events;
};

describe("OpenAI-compatible Responses provider", () => {
  it("streams split SSE text and keeps the key out of public metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'data: {"type":"response.created","sequence_number":0}\n\n',
        'data: {"type":"response.output_text.delta","sequence_number":1,"del',
        'ta":"Audited "}\r\n\r\n',
        'data: {"type":"response.output_text.delta","sequence_number":2,"delta":"result"}\n\n',
        'data: {"type":"response.completed","sequence_number":3}\n\n',
      ]),
    );
    const provider = new OpenAICompatibleProvider({
      apiKey: () => "node-only-secret",
      models: [
        {
          id: "test-model",
          label: "Test model",
          capabilities: {
            imageInput: true,
            reasoning: true,
            temperature: true,
          },
        },
      ],
      defaultModelId: "test-model",
      fetch: fetchMock,
      supportsImageInput: true,
    });

    const events = await collect(provider);
    expect(events).toEqual([
      { type: "text-delta", text: "Audited " },
      { type: "text-delta", text: "result" },
      { type: "completed" },
    ]);
    expect(JSON.stringify(provider.descriptor)).not.toContain(
      "node-only-secret",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://api.openai.com/v1/responses");
    expect(init?.headers).toEqual(
      expect.objectContaining({
        authorization: "Bearer node-only-secret",
        accept: "text/event-stream",
      }),
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "test-model",
      stream: true,
      store: false,
      temperature: 0.3,
      max_output_tokens: 2_048,
      reasoning: { effort: "low" },
    });
    expect(JSON.stringify(body)).toContain('"type":"input_image"');
    expect(JSON.stringify(body)).toContain("Approved source context");
  });

  it("maps rate limits to a retryable structured provider error", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "node-only-secret",
      models: [{ id: "test-model", label: "Test model" }],
      defaultModelId: "test-model",
      fetch: async () => new Response("", { status: 429 }),
    });

    await expect(collect(provider)).rejects.toMatchObject({
      code: "AI_PROVIDER_RATE_LIMITED",
      retryable: true,
    });
  });

  it("maps bounded Agent tools, tool results, and Responses function calls", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'data: {"type":"response.output_item.done","sequence_number":1,"item":{"type":"function_call","call_id":"call:patch","name":"patch_prepare","arguments":"{\\"proposal\\":{}}"}}\n\n',
        'data: {"type":"response.completed","sequence_number":2}\n\n',
      ]),
    );
    const provider = new OpenAICompatibleProvider({
      apiKey: "node-only-secret",
      models: [{ id: "test-model", label: "Test model" }],
      defaultModelId: "test-model",
      fetch: fetchMock,
      supportsToolCalling: true,
    });
    const agentRequest = providerRequest();
    agentRequest.mode = "plan";
    agentRequest.negotiation.capabilities.toolCalling = true;
    agentRequest.agent = {
      turn: 1,
      availableTools: [
        "source.readFile",
        "patch.prepare",
        "patch.applyApproved",
      ],
      approvedPatches: [
        {
          proposalId: "proposal:approved",
          approvalId: "approval:approved",
          requestId: "request:test",
          summary: "Apply the reviewed patch",
          affectedFiles: ["src/Test.ts"],
        },
      ],
      exchanges: [
        {
          calls: [
            {
              schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
              id: "call:read",
              executionId: agentRequest.executionId,
              name: "source.readFile",
              arguments: { sourceId: "src/Test.ts" },
            },
          ],
          results: [
            {
              schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
              callId: "call:read",
              name: "source.readFile",
              status: "completed",
              output: { hash: "a".repeat(64), content: "redacted source" },
            },
          ],
        },
      ],
    };

    expect(await collect(provider, agentRequest)).toEqual([
      {
        type: "tool-call",
        call: {
          id: "call:patch",
          name: "patch.prepare",
          arguments: '{"proposal":{}}',
        },
      },
      { type: "completed" },
    ]);
    expect(provider.descriptor.capabilities.toolCalling).toBe(true);
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "source_read_file",
        strict: false,
      }),
      expect.objectContaining({
        type: "function",
        name: "patch_prepare",
        strict: false,
      }),
      expect.objectContaining({
        type: "function",
        name: "patch_apply_approved",
        strict: false,
      }),
    ]);
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          call_id: "call:read",
          name: "source_read_file",
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call:read",
          output: expect.stringContaining("redacted source"),
        }),
      ]),
    );
    expect(JSON.stringify(body)).toContain("proposal:approved");
    expect(JSON.stringify(body)).toContain("approval:approved");
    expect(JSON.stringify(body)).toContain(
      "do not claim success until the tool returns a verified result",
    );
  });

  it("rejects out-of-order and incomplete streams", async () => {
    const outOfOrder = new OpenAICompatibleProvider({
      apiKey: "node-only-secret",
      models: [{ id: "test-model", label: "Test model" }],
      defaultModelId: "test-model",
      fetch: async () =>
        sseResponse([
          'data: {"type":"response.output_text.delta","sequence_number":2,"delta":"a"}\n\n',
          'data: {"type":"response.output_text.delta","sequence_number":1,"delta":"b"}\n\n',
        ]),
    });
    await expect(collect(outOfOrder)).rejects.toMatchObject({
      code: "AI_PROVIDER_STREAM_OUT_OF_ORDER",
    });

    const incomplete = new OpenAICompatibleProvider({
      apiKey: "node-only-secret",
      models: [{ id: "test-model", label: "Test model" }],
      defaultModelId: "test-model",
      fetch: async () =>
        sseResponse([
          'data: {"type":"response.output_text.delta","sequence_number":1,"delta":"partial"}\n\n',
          "data: [DONE]\n\n",
        ]),
    });
    await expect(collect(incomplete)).rejects.toMatchObject({
      code: "AI_PROVIDER_STREAM_INCOMPLETE",
    });
  });

  it("times out a disconnected request without exposing its key", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "node-only-secret",
      models: [{ id: "test-model", label: "Test model" }],
      defaultModelId: "test-model",
      timeoutMs: 5,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });

    const error = await collect(provider).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "AI_PROVIDER_TIMEOUT",
      retryable: true,
    });
    expect(JSON.stringify(error)).not.toContain("node-only-secret");
  });
});
