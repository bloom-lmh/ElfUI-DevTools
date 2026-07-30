import { describe, expect, it } from "vitest";

import {
  DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
  isAIExecutionEvent,
} from "./execution";
import { DeterministicMockProvider } from "./mock-provider";

const providerRequest = {
  executionId: "execution:test",
  mode: "explain" as const,
  settings: { modelId: "elfui-deterministic" },
  negotiation: {
    status: "supported" as const,
    providerId: "elfui-mock",
    modelId: "elfui-deterministic",
    capabilities: {
      text: true,
      imageInput: false,
      toolCalling: false,
      structuredOutput: false,
      reasoning: false,
      temperature: false,
    },
    requirements: {
      required: ["text" as const],
      preferred: [],
    },
    missingRequired: [],
    downgraded: [],
    notices: [],
  },
  changeRequest: {
    schemaVersion: 1 as const,
    id: "request:test",
    conversationId: "conversation:test",
    project: { framework: "elfui" as const },
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
    screenshots: [],
    sourceContext: [
      {
        id: "source:test",
        sourceId: "src/Test.ts",
        content: "export const test = true;",
      },
    ],
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
        screenshotCount: 0,
        screenshotBytes: 0,
        userMessageCharacters: 0,
      },
      approvedSourceIds: [],
      pendingSourceApprovals: [],
      omissions: [],
      redactions: [],
      userMessageTruncated: false,
    },
  },
};

describe("readonly AI execution protocol", () => {
  it("streams deterministic provider-neutral text", async () => {
    const provider = new DeterministicMockProvider({
      chunkSize: 10,
      delayMs: 0,
    });
    const events = [];
    for await (const event of provider.stream(providerRequest, {
      signal: new AbortController().signal,
    }))
      events.push(event);

    expect(events.at(-1)).toEqual({ type: "completed" });
    expect(
      events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.text)
        .join(""),
    ).toContain("不会直接改变业务 DOM");
  });

  it("supports deterministic provider failures and cancellation", async () => {
    const failing = new DeterministicMockProvider({
      delayMs: 0,
      failAfterChunks: 0,
    });
    await expect(async () => {
      for await (const event of failing.stream(providerRequest, {
        signal: new AbortController().signal,
      })) {
        void event;
      }
    }).rejects.toThrow("Deterministic mock provider failure");

    const controller = new AbortController();
    controller.abort();
    const cancelled = new DeterministicMockProvider({ delayMs: 0 });
    await expect(async () => {
      for await (const event of cancelled.stream(providerRequest, {
        signal: controller.signal,
      })) {
        void event;
      }
    }).rejects.toMatchObject({ name: "AbortError" });
  });

  it("validates audited execution events", () => {
    expect(
      isAIExecutionEvent({
        schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
        type: "started",
        executionId: "execution:test",
        sequence: 1,
        at: 10,
        providerId: "elfui-mock",
        mode: "explain",
        context: {
          sourceBlocks: 1,
          sourceCharacters: 25,
          redactions: 0,
          omissions: 0,
        },
      }),
    ).toBe(true);
    expect(
      isAIExecutionEvent({
        schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
        type: "text-delta",
        executionId: "execution:test",
        sequence: 2,
        at: 11,
      }),
    ).toBe(false);
    expect(
      isAIExecutionEvent({
        schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
        type: "tool-call",
        executionId: "execution:test",
        sequence: 3,
        at: 12,
        call: {
          id: "call:test",
          name: "source.readRanges",
          arguments: '{"sourceId":"src/Test.ts"}',
        },
      }),
    ).toBe(true);
    expect(
      isAIExecutionEvent({
        schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
        type: "structured-output",
        executionId: "execution:test",
        sequence: 4,
        at: 13,
        value: { summary: "Safe", files: ["src/Test.ts"] },
      }),
    ).toBe(true);
    expect(
      isAIExecutionEvent({
        schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
        type: "structured-output",
        executionId: "execution:test",
        sequence: 5,
        at: 14,
        value: { invalid: Number.NaN },
      }),
    ).toBe(false);
    expect(
      isAIExecutionEvent({
        schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
        type: "tool-result",
        executionId: "execution:test",
        sequence: 6,
        at: 15,
        callId: "call:test",
        name: "source.readFile",
        status: "completed",
        outputCharacters: 512,
      }),
    ).toBe(true);
    const patchVerification = {
      schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
      type: "patch-verification",
      executionId: "execution:test",
      sequence: 7,
      at: 16,
      verification: {
        verificationId: "verification:test",
        applicationId: "application:test",
        proposalId: "proposal:test",
        approvalId: "approval:test",
        requestId: "request:test",
        status: "verified",
        files: [
          {
            sourceId: "src/Test.ts",
            beforeHash: "a".repeat(64),
            afterHash: "b".repeat(64),
          },
        ],
        checks: [
          "format",
          "typecheck",
          "test-scoped",
          "build",
          "hmr",
          "diagnostics",
        ].map((step) => ({
          step,
          status: step === "build" ? "skipped" : "passed",
          required: step !== "build",
          summary: `${step} safe summary`,
          durationMs: 1,
        })),
        diagnostics: [],
        diagnosticsTruncated: false,
        appliedAt: 11,
        startedAt: 10,
        completedAt: 12,
      },
    };
    expect(isAIExecutionEvent(patchVerification)).toBe(true);
    expect(
      isAIExecutionEvent({
        ...patchVerification,
        verification: {
          ...patchVerification.verification,
          status: "rolled-back",
          failedStep: "typecheck",
          rolledBackAt: 12,
        },
      }),
    ).toBe(false);
  });
});
