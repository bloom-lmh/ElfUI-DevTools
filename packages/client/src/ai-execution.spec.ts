import { describe, expect, it, vi } from "vitest";

import {
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  DEVTOOLS_AI_EXECUTION_CANCEL_ENDPOINT,
  DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
  DEVTOOLS_AI_PROVIDER_CATALOG_ENDPOINT,
  DEVTOOLS_AI_PATCH_PROPOSAL_CATALOG_ENDPOINT,
  DEVTOOLS_AI_PATCH_PROPOSAL_DECISION_ENDPOINT,
  DEVTOOLS_AI_PATCH_ROLLBACK_ENDPOINT,
  DEVTOOLS_AI_SCREENSHOT_UPLOAD_ENDPOINT,
  type AIExecutionStartRequest,
} from "@elfui/devtools-ai";
import type { AIChangeRequest } from "@elfui/devtools-shared";

import { createAIExecutionClient, withoutSourceContent } from "./ai-execution";

const changeRequest = {
  schemaVersion: 1,
  id: "request:test",
  conversationId: "conversation:test",
  sourceContext: [
    {
      id: "source:test",
      sourceId: "src/Test.ts",
      content: "const secret = true;",
    },
  ],
} as AIChangeRequest;

const startRequest: AIExecutionStartRequest = {
  schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
  executionId: "execution:test",
  conversationId: "conversation:test",
  assistantMessageId: "message:test",
  mode: "explain",
  changeRequest: withoutSourceContent(changeRequest),
};

const pendingPatchReview = {
  schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  proposal: {
    schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
    id: "proposal:test",
    requestId: "request:test",
    summary: "Update the selected value.",
    assumptions: ["Public API remains stable."],
    affectedFiles: ["src/Test.ts"],
    baseFileHashes: { "src/Test.ts": "a".repeat(64) },
    unifiedDiff:
      "diff --git a/src/Test.ts b/src/Test.ts\n--- a/src/Test.ts\n+++ b/src/Test.ts\n@@ -1 +1 @@\n-old\n+new\n",
    validationPlan: [
      {
        id: "validation:typecheck",
        kind: "typecheck",
        required: true,
        files: ["src/Test.ts"],
      },
    ],
    risk: "low",
  },
  status: "pending",
  decisions: [],
  createdAt: 10,
  updatedAt: 10,
} as const;

const event = (value: Record<string, unknown>): string =>
  `${JSON.stringify({
    schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
    executionId: "execution:test",
    at: 10,
    ...value,
  })}\n`;

describe("AI execution client", () => {
  it("strips source content and parses a contiguous NDJSON stream", async () => {
    expect(JSON.stringify(withoutSourceContent(changeRequest))).not.toContain(
      "const secret",
    );
    const body = [
      event({
        type: "started",
        sequence: 1,
        providerId: "elfui-mock",
        mode: "explain",
        context: {
          sourceBlocks: 1,
          sourceCharacters: 20,
          redactions: 0,
          omissions: 0,
        },
      }),
      event({ type: "text-delta", sequence: 2, text: "Hello" }),
      event({
        type: "tool-call",
        sequence: 3,
        call: {
          id: "call:test",
          name: "source.readRanges",
          arguments: '{"sourceId":"src/Test.ts"}',
        },
      }),
      event({
        type: "tool-result",
        sequence: 4,
        callId: "call:test",
        name: "source.readRanges",
        status: "completed",
        outputCharacters: 120,
      }),
      event({
        type: "patch-verification",
        sequence: 5,
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
      }),
      event({
        type: "structured-output",
        sequence: 6,
        value: { summary: "Read-only" },
      }),
      event({
        type: "reference",
        sequence: 7,
        reference: {
          kind: "visual-intent",
          id: "visual-intent:test",
          label: "style intent",
        },
      }),
      event({ type: "completed", sequence: 8, finishReason: "stop" }),
    ].join("");
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body.slice(0, 40)));
            controller.enqueue(new TextEncoder().encode(body.slice(40)));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
    const client = createAIExecutionClient(
      "capability",
      fetchImplementation,
      "http://localhost",
    );
    const events = [];
    for await (const streamed of client.execute(startRequest))
      events.push(streamed);

    expect(events.map((item) => item.type)).toEqual([
      "started",
      "text-delta",
      "tool-call",
      "tool-result",
      "patch-verification",
      "structured-output",
      "reference",
      "completed",
    ]);
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "x-elfui-devtools-token": "capability",
      },
    });
  });

  it("rejects non-contiguous events and sends cancellation separately", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          event({
            type: "completed",
            sequence: 2,
            finishReason: "stop",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const client = createAIExecutionClient(
      "capability",
      fetchImplementation,
      "http://localhost",
    );
    await expect(async () => {
      for await (const event of client.execute(startRequest)) {
        void event;
      }
    }).rejects.toThrow("sequence is not contiguous");

    await client.cancel("execution:test");
    expect(String(fetchImplementation.mock.calls[1]?.[0])).toContain(
      DEVTOOLS_AI_EXECUTION_CANCEL_ENDPOINT,
    );
  });

  it("loads the public provider catalog without a request body", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      Response.json({
        schemaVersion: 1,
        defaultProviderId: "elfui-mock",
        providers: [
          {
            id: "elfui-mock",
            label: "Mock",
            capabilities: {
              text: true,
              imageInput: false,
              toolCalling: false,
              structuredOutput: false,
              reasoning: false,
              temperature: false,
            },
            models: [{ id: "mock-model", label: "Mock" }],
            defaultModelId: "mock-model",
          },
        ],
      }),
    );
    const client = createAIExecutionClient(
      "capability",
      fetchImplementation,
      "http://localhost",
    );
    const catalog = await client.listProviders!();

    expect(catalog.defaultProviderId).toBe("elfui-mock");
    expect(String(fetchImplementation.mock.calls[0]?.[0])).toContain(
      DEVTOOLS_AI_PROVIDER_CATALOG_ENDPOINT,
    );
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: { "x-elfui-devtools-token": "capability" },
    });
    expect(fetchImplementation.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it("uploads screenshot bytes through the separate bounded asset endpoint", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = createAIExecutionClient(
      "capability",
      fetchImplementation,
      "http://localhost",
    );
    await client.uploadScreenshots!([
      {
        id: "screenshot:test",
        kind: "viewport",
        phase: "desired",
        mimeType: "image/png",
        width: 1,
        height: 1,
        devicePixelRatio: 1,
        route: "/fixture",
        scroll: { x: 0, y: 0 },
        capturedAt: 10,
        excludedRegions: [],
        byteLength: 5,
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      },
    ]);

    expect(String(fetchImplementation.mock.calls[0]?.[0])).toContain(
      DEVTOOLS_AI_SCREENSHOT_UPLOAD_ENDPOINT,
    );
    const init = fetchImplementation.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: "POST",
      headers: { "x-elfui-devtools-token": "capability" },
      cache: "no-store",
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
      asset: { id: "screenshot:test", byteLength: 5 },
      dataUrl: "data:image/png;base64,aW1hZ2U=",
    });
    expect(JSON.stringify(body.asset)).not.toContain("dataUrl");
  });

  it("uses only Node-owned IDs for proposal decisions and application rollback", async () => {
    const approved = {
      ...pendingPatchReview,
      status: "approved" as const,
      decisions: [
        {
          schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
          id: "approval:1",
          proposalId: "proposal:test",
          requestId: "request:test",
          decision: "approve" as const,
          approvedFiles: ["src/Test.ts"],
          approvedFileHashes: { "src/Test.ts": "a".repeat(64) },
          createdAt: 11,
        },
      ],
      updatedAt: 11,
    };
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
          requestId: "request:test",
          proposals: [pendingPatchReview],
        }),
      )
      .mockResolvedValueOnce(Response.json(approved))
      .mockResolvedValueOnce(
        Response.json({
          schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
          applicationId: "application:test",
          verificationId: "verification:test",
          proposalId: "proposal:test",
          approvalId: "approval:1",
          requestId: "request:test",
          status: "rolled-back",
          reason: "user",
          files: ["src/Test.ts"],
          restoredFileHashes: { "src/Test.ts": "a".repeat(64) },
          rolledBackAt: 12,
        }),
      );
    const client = createAIExecutionClient(
      "capability",
      fetchImplementation,
      "http://localhost",
    );

    const catalog = await client.listPatchProposals!("request:test");
    expect(catalog.proposals[0]?.proposal.unifiedDiff).toContain("-old");
    const review = await client.decidePatchProposal!({
      schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
      proposalId: "proposal:test",
      requestId: "request:test",
      decision: "approve",
    });
    expect(review.status).toBe("approved");
    const rollback = await client.rollbackPatchApplication!({
      schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
      applicationId: "application:test",
      verificationId: "verification:test",
      proposalId: "proposal:test",
      requestId: "request:test",
    });
    expect(rollback.status).toBe("rolled-back");

    const catalogUrl = new URL(String(fetchImplementation.mock.calls[0]?.[0]));
    expect(catalogUrl.pathname).toBe(
      DEVTOOLS_AI_PATCH_PROPOSAL_CATALOG_ENDPOINT,
    );
    expect(catalogUrl.searchParams.get("requestId")).toBe("request:test");
    const decisionCall = fetchImplementation.mock.calls[1];
    expect(String(decisionCall?.[0])).toContain(
      DEVTOOLS_AI_PATCH_PROPOSAL_DECISION_ENDPOINT,
    );
    const decisionBody = String(decisionCall?.[1]?.body);
    expect(JSON.parse(decisionBody)).toEqual({
      schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
      proposalId: "proposal:test",
      requestId: "request:test",
      decision: "approve",
    });
    expect(decisionBody).not.toContain("unifiedDiff");
    expect(decisionBody).not.toContain("approvedFileHashes");
    const rollbackCall = fetchImplementation.mock.calls[2];
    expect(String(rollbackCall?.[0])).toContain(
      DEVTOOLS_AI_PATCH_ROLLBACK_ENDPOINT,
    );
    expect(JSON.parse(String(rollbackCall?.[1]?.body))).toEqual({
      schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
      applicationId: "application:test",
      verificationId: "verification:test",
      proposalId: "proposal:test",
      requestId: "request:test",
    });
    expect(String(rollbackCall?.[1]?.body)).not.toContain("restoredFileHashes");
  });
});
