// @vitest-environment node

import {
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  type AIAgentToolResult,
  type AIProvider,
  type AIProviderRequest,
} from "@elfui/devtools-ai";
import { describe, expect, it, vi } from "vitest";

import { runAIAgentSession } from "./agent-session";

const descriptor = {
  id: "agent-provider",
  label: "Agent provider",
  capabilities: {
    text: true,
    imageInput: false,
    toolCalling: true,
    structuredOutput: true,
    reasoning: false,
    temperature: false,
  },
  models: [{ id: "agent-model", label: "Agent model" }],
  defaultModelId: "agent-model",
};

const request = {
  executionId: "execution:test",
  mode: "plan",
  settings: { modelId: "agent-model" },
  negotiation: {
    status: "supported",
    providerId: "agent-provider",
    modelId: "agent-model",
    capabilities: descriptor.capabilities,
    requirements: { required: ["text"], preferred: ["tool-calling"] },
    missingRequired: [],
    downgraded: [],
    notices: [],
  },
  changeRequest: { id: "request:test" },
} as unknown as AIProviderRequest;

describe("request-scoped AI agent session", () => {
  it("feeds bounded tool results into the next Provider turn", async () => {
    const received: AIProviderRequest[] = [];
    const approvedPatches = [
      {
        proposalId: "proposal:test",
        approvalId: "approval:test",
        requestId: "request:test",
        summary: "Apply the approved change",
        affectedFiles: ["src/Test.ts"],
      },
    ];
    const provider: AIProvider = {
      descriptor,
      async *stream(current) {
        received.push(current);
        if (current.agent?.turn === 0) {
          current.agent.approvedPatches![0]!.summary = "provider mutation";
          yield {
            type: "tool-call",
            call: {
              id: "call:read",
              name: "source.readFile",
              arguments: JSON.stringify({ sourceId: "src/Test.ts" }),
            },
          };
        } else yield { type: "text-delta", text: "Prepared from tool data" };
        yield { type: "completed" };
      },
    };
    const result: AIAgentToolResult = {
      schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
      callId: "call:read",
      name: "source.readFile",
      status: "completed",
      output: { content: "redacted source" },
    };
    const executeTool = vi.fn().mockResolvedValue(result);
    const events = [];
    for await (const event of runAIAgentSession({
      provider,
      request,
      signal: new AbortController().signal,
      availableTools: ["source.readFile"],
      approvedPatches,
      executeTool,
    }))
      events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      "tool-call",
      "tool-result",
      "text-delta",
      "completed",
    ]);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(received).toHaveLength(2);
    expect(approvedPatches[0]?.summary).toBe("Apply the approved change");
    expect(received[1]?.agent?.approvedPatches).toEqual(approvedPatches);
    expect(received[1]?.agent).toMatchObject({
      turn: 1,
      exchanges: [
        {
          calls: [
            expect.objectContaining({
              id: "call:read",
              name: "source.readFile",
              arguments: { sourceId: "src/Test.ts" },
            }),
          ],
          results: [result],
        },
      ],
    });
  });

  it("rejects invalid, duplicate, and unbounded tool loops", async () => {
    const invalid: AIProvider = {
      descriptor,
      async *stream() {
        yield {
          type: "tool-call",
          call: { id: "call:bad", name: "shell.exec", arguments: "{}" },
        };
        yield { type: "completed" };
      },
    };
    await expect(async () => {
      for await (const event of runAIAgentSession({
        provider: invalid,
        request,
        signal: new AbortController().signal,
        availableTools: [],
        executeTool: vi.fn(),
      }))
        void event;
    }).rejects.toMatchObject({ code: "AI_AGENT_TOOL_CALL_INVALID" });

    const repeated: AIProvider = {
      descriptor,
      async *stream() {
        yield {
          type: "tool-call",
          call: {
            id: "call:same",
            name: "source.readFile",
            arguments: '{"sourceId":"src/Test.ts"}',
          },
        };
        yield { type: "completed" };
      },
    };
    await expect(async () => {
      for await (const event of runAIAgentSession({
        provider: repeated,
        request,
        signal: new AbortController().signal,
        availableTools: ["source.readFile"],
        executeTool: async (call) => ({
          schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
          callId: call.id,
          name: call.name,
          status: "completed",
          output: {},
        }),
      }))
        void event;
    }).rejects.toMatchObject({ code: "AI_AGENT_TOOL_CALL_DUPLICATE" });
  });
});
