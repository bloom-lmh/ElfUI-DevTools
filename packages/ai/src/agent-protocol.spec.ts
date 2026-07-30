import { describe, expect, it } from "vitest";

import {
  AI_AGENT_TOOL_DEFINITIONS,
  AI_AGENT_TOOL_NAMES,
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  fromAIAgentWireToolName,
  isAIAgentToolCall,
  isAIAgentToolResult,
  isPatchApplicationRollbackRequest,
  isPatchApplicationRollbackResult,
  isPatchApproval,
  isPatchProposalCatalog,
  isPatchProposalDecisionRequest,
  isPatchProposalReview,
  isPatchProposal,
  isProjectRelativePath,
  type PatchProposal,
} from "./agent-protocol";

const hash = "a".repeat(64);

const proposal = (): PatchProposal => ({
  schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  id: "proposal:test",
  requestId: "request:test",
  summary: "Update the selected visual target.",
  assumptions: ["The public API remains unchanged."],
  affectedFiles: ["src/Test.ts"],
  baseFileHashes: { "src/Test.ts": hash },
  unifiedDiff:
    "--- a/src/Test.ts\n+++ b/src/Test.ts\n@@ -1 +1 @@\n-old\n+new\n",
  validationPlan: [
    {
      id: "validation:typecheck",
      kind: "typecheck",
      required: true,
      files: ["src/Test.ts"],
    },
  ],
  risk: "low",
});

describe("AI agent protocol", () => {
  it("publishes one provider-safe schema for every fixed tool name", () => {
    expect(AI_AGENT_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual(
      AI_AGENT_TOOL_NAMES,
    );
    expect(
      new Set(AI_AGENT_TOOL_DEFINITIONS.map(({ wireName }) => wireName)).size,
    ).toBe(AI_AGENT_TOOL_NAMES.length);
    for (const definition of AI_AGENT_TOOL_DEFINITIONS) {
      expect(definition.wireName).toMatch(/^[a-z0-9_]+$/);
      expect(fromAIAgentWireToolName(definition.wireName)).toBe(
        definition.name,
      );
      expect(definition.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  it("accepts a bounded PatchProposal with exact file hashes", () => {
    expect(isPatchProposal(proposal())).toBe(true);
    expect(
      isPatchProposal({
        ...proposal(),
        affectedFiles: ["src/Test.ts", "src/Other.ts"],
      }),
    ).toBe(false);
  });

  it("rejects absolute paths, traversal, backslashes, and raw command-shaped paths", () => {
    expect(isProjectRelativePath("src/Test.ts")).toBe(true);
    expect(isProjectRelativePath("../secret.env")).toBe(false);
    expect(isProjectRelativePath("C:/secret.env")).toBe(false);
    expect(isProjectRelativePath("src\\Test.ts")).toBe(false);
    expect(isProjectRelativePath("/etc/passwd")).toBe(false);
  });

  it("validates approval decisions against exact approved hashes", () => {
    expect(
      isPatchApproval({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        id: "approval:test",
        proposalId: "proposal:test",
        requestId: "request:test",
        decision: "approve",
        approvedFiles: ["src/Test.ts"],
        approvedFileHashes: { "src/Test.ts": hash },
        createdAt: 10,
      }),
    ).toBe(true);
    expect(
      isPatchApproval({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        id: "approval:test",
        proposalId: "proposal:test",
        requestId: "request:test",
        decision: "approve",
        approvedFiles: [],
        approvedFileHashes: {},
        createdAt: 10,
      }),
    ).toBe(false);
  });

  it("accepts only ID-based user decisions and consistent Node review catalogs", () => {
    expect(
      isPatchProposalDecisionRequest({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        proposalId: "proposal:test",
        requestId: "request:test",
        decision: "revise",
        comment: "Keep the public export unchanged.",
      }),
    ).toBe(true);
    expect(
      isPatchProposalDecisionRequest({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        proposalId: "proposal:test",
        requestId: "request:test",
        decision: "approve",
        approvedFiles: ["src/Injected.ts"],
      }),
    ).toBe(false);
    expect(
      isPatchProposalDecisionRequest({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        proposalId: "proposal:test",
        requestId: "request:test",
        decision: "revise",
        comment: "   ",
      }),
    ).toBe(false);

    const review = {
      schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
      proposal: proposal(),
      status: "pending",
      decisions: [],
      createdAt: 10,
      updatedAt: 10,
    };
    expect(isPatchProposalReview(review)).toBe(true);
    expect(
      isPatchProposalCatalog({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        requestId: "request:test",
        proposals: [review],
      }),
    ).toBe(true);
    expect(
      isPatchProposalCatalog({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        requestId: "request:other",
        proposals: [review],
      }),
    ).toBe(false);

    expect(
      isPatchApplicationRollbackRequest({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        applicationId: "application:test",
        verificationId: "verification:test",
        proposalId: "proposal:test",
        requestId: "request:test",
      }),
    ).toBe(true);
    expect(
      isPatchApplicationRollbackRequest({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        applicationId: "application:test",
        verificationId: "verification:test",
        proposalId: "proposal:test",
        requestId: "request:test",
        restoredFileHashes: { "src/Test.ts": hash },
      }),
    ).toBe(false);
    expect(
      isPatchApplicationRollbackResult({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        applicationId: "application:test",
        verificationId: "verification:test",
        proposalId: "proposal:test",
        approvalId: "approval:test",
        requestId: "request:test",
        status: "rolled-back",
        reason: "user",
        files: ["src/Test.ts"],
        restoredFileHashes: { "src/Test.ts": hash },
        rolledBackAt: 12,
      }),
    ).toBe(true);
  });

  it("accepts only the fixed tool whitelist and typed bounded arguments", () => {
    expect(
      isAIAgentToolCall({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        id: "call:read",
        executionId: "execution:test",
        name: "source.readRanges",
        arguments: {
          sourceId: "src/Test.ts",
          ranges: [{ startLine: 1, endLine: 20 }],
        },
      }),
    ).toBe(true);
    expect(
      isAIAgentToolCall({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        id: "call:shell",
        executionId: "execution:test",
        name: "shell.exec",
        arguments: { command: "rm -rf ." },
      }),
    ).toBe(false);
    expect(
      isAIAgentToolCall({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        id: "call:prepare",
        executionId: "execution:test",
        name: "patch.prepare",
        arguments: { proposal: proposal() },
      }),
    ).toBe(true);
  });

  it("keeps tool results terminal and mutually exclusive", () => {
    expect(
      isAIAgentToolResult({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        callId: "call:test",
        name: "project.search",
        status: "completed",
        output: { matches: [] },
      }),
    ).toBe(true);
    expect(
      isAIAgentToolResult({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        callId: "call:test",
        name: "project.search",
        status: "failed",
        output: { matches: [] },
        error: { code: "FAILED", message: "Failed", retryable: false },
      }),
    ).toBe(false);
  });
});
