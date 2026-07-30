import { describe, expect, it, vi } from "vitest";

import { DEVTOOLS_AI_AGENT_SCHEMA_VERSION } from "./agent-protocol";
import { AnthropicMessagesProvider } from "./anthropic-messages-provider";
import type { AIProviderRequest } from "./provider";

const request = (): AIProviderRequest =>
  ({
    executionId: "execution:test",
    mode: "explain",
    settings: {
      modelId: "test-model",
      maxOutputTokens: 2_048,
      temperature: 0.2,
    },
    negotiation: {
      capabilities: { imageInput: true },
      downgraded: [],
    },
    changeRequest: {
      userMessage: "Explain this",
      targets: [],
      intents: [],
      annotations: [],
      sourceContext: [],
      screenshots: [{ id: "screenshot:test" }],
    },
    resolveScreenshot: async () => "data:image/png;base64,aW1hZ2U=",
  }) as unknown as AIProviderRequest;

const response = (): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of [
          'data: {"type":"message_start"}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Non-OpenAI "}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"result"}}\n\n',
          'data: {"type":"message_stop"}\n\n',
        ])
          controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    { status: 200 },
  );

describe("Anthropic Messages provider", () => {
  it("uses the non-OpenAI Messages protocol and streams text", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response());
    const provider = new AnthropicMessagesProvider({
      apiKey: () => "node-only-anthropic-key",
      models: [{ id: "test-model", label: "Test" }],
      defaultModelId: "test-model",
      fetch: fetchMock,
      supportsImageInput: true,
    });
    const events = [];
    for await (const event of provider.stream(request(), {
      signal: new AbortController().signal,
    }))
      events.push(event);

    expect(events).toEqual([
      { type: "text-delta", text: "Non-OpenAI " },
      { type: "text-delta", text: "result" },
      { type: "completed" },
    ]);
    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.headers).toEqual(
      expect.objectContaining({
        "x-api-key": "node-only-anthropic-key",
        "anthropic-version": "2023-06-01",
      }),
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "test-model",
      max_tokens: 2_048,
      temperature: 0.2,
      stream: true,
    });
    expect(JSON.stringify(body)).toContain('"type":"image"');
    expect(JSON.stringify(provider.descriptor)).not.toContain(
      "node-only-anthropic-key",
    );
  });

  it("requires message_stop and maps rate limits", async () => {
    const incomplete = new AnthropicMessagesProvider({
      apiKey: "key",
      models: [{ id: "test-model", label: "Test" }],
      defaultModelId: "test-model",
      fetch: async () => new Response('data: {"type":"ping"}\n\n'),
    });
    await expect(async () => {
      for await (const event of incomplete.stream(request(), {
        signal: new AbortController().signal,
      }))
        void event;
    }).rejects.toMatchObject({ code: "AI_PROVIDER_STREAM_INCOMPLETE" });

    const limited = new AnthropicMessagesProvider({
      apiKey: "key",
      models: [{ id: "test-model", label: "Test" }],
      defaultModelId: "test-model",
      fetch: async () => new Response("", { status: 429 }),
    });
    await expect(async () => {
      for await (const event of limited.stream(request(), {
        signal: new AbortController().signal,
      }))
        void event;
    }).rejects.toMatchObject({
      code: "AI_PROVIDER_RATE_LIMITED",
      retryable: true,
    });
  });

  it("maps bounded Agent tools, result messages, and streamed tool_use", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          [
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call:patch","name":"patch_prepare","input":{}}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"proposal\\":"}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}}"}}\n\n',
            'data: {"type":"content_block_stop","index":0}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ].join(""),
          { status: 200 },
        ),
    );
    const provider = new AnthropicMessagesProvider({
      apiKey: "node-only-anthropic-key",
      models: [{ id: "test-model", label: "Test" }],
      defaultModelId: "test-model",
      fetch: fetchMock,
      supportsToolCalling: true,
    });
    const agentRequest = request();
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
    const events = [];
    for await (const event of provider.stream(agentRequest, {
      signal: new AbortController().signal,
    }))
      events.push(event);

    expect(events).toEqual([
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
        name: "source_read_file",
        input_schema: expect.objectContaining({ type: "object" }),
      }),
      expect.objectContaining({
        name: "patch_prepare",
        input_schema: expect.objectContaining({ type: "object" }),
      }),
      expect.objectContaining({
        name: "patch_apply_approved",
        input_schema: expect.objectContaining({ type: "object" }),
      }),
    ]);
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({
              type: "tool_use",
              id: "call:read",
              name: "source_read_file",
            }),
          ],
        }),
        expect.objectContaining({
          role: "user",
          content: [
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call:read",
              content: expect.stringContaining("redacted source"),
            }),
          ],
        }),
      ]),
    );
    expect(JSON.stringify(body)).toContain("proposal:approved");
    expect(JSON.stringify(body)).toContain("approval:approved");
    expect(JSON.stringify(body)).toContain(
      "do not claim success until the tool returns a verified result",
    );
  });
});
