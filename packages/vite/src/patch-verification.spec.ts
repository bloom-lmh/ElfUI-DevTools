// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  type PatchProposal,
} from "@elfui/devtools-ai";
import type { CompilerStateSnapshot } from "@elfui/devtools-shared";
import { describe, expect, it, vi } from "vitest";

import { createApprovedPatchApplier } from "./patch-application";
import { createPatchProposalStore } from "./patch-proposals";
import {
  createPatchVerificationCoordinator,
  type PatchVerificationAdapters,
} from "./patch-verification";

const source = "export const value = 1;\n";
const applied = "export const value = 2;\n";
const formatted = `${applied}// formatted\n`;
const hash = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const fixture = async () => {
  const root = await mkdtemp(join(process.cwd(), ".elfui-verification-"));
  await mkdir(join(root, "src"));
  const file = join(root, "src/Test.ts");
  await writeFile(file, source);
  const snapshot: CompilerStateSnapshot = {
    protocolVersion: 2,
    revision: 1,
    artifacts: [
      {
        revision: 1,
        capturedAt: 1,
        id: file,
        sourceId: "src/Test.ts",
        kind: "metadata",
        payload: {},
      },
    ],
  };
  const proposal: PatchProposal = {
    schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
    id: "proposal:verification",
    requestId: "request:verification",
    summary: "Update the approved value.",
    assumptions: [],
    affectedFiles: ["src/Test.ts"],
    baseFileHashes: { "src/Test.ts": hash(source) },
    unifiedDiff:
      "diff --git a/src/Test.ts b/src/Test.ts\n--- a/src/Test.ts\n+++ b/src/Test.ts\n@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;\n",
    validationPlan: [
      {
        id: "validation:typecheck",
        kind: "typecheck",
        required: true,
        files: ["src/Test.ts"],
      },
    ],
    risk: "low",
  };
  const proposals = createPatchProposalStore(root, () => snapshot);
  const scope = {
    requestId: proposal.requestId,
    allowedSourceIds: proposal.affectedFiles,
  };
  proposals.prepare(proposal, scope);
  const approvalId = proposals.decide({
    schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
    proposalId: proposal.id,
    requestId: proposal.requestId,
    decision: "approve",
  }).decisions[0]!.id;
  return { root, file, snapshot, proposal, proposals, scope, approvalId };
};

const passingAdapters = (): PatchVerificationAdapters => ({
  format: vi.fn(async () => ({ ok: true, summary: "Formatting passed" })),
  typecheck: vi.fn(async () => ({ ok: true, summary: "Types passed" })),
  testScoped: vi.fn(async () => ({ ok: true, summary: "Tests passed" })),
  hmr: vi.fn(async () => ({ ok: true, summary: "HMR settled" })),
  diagnostics: vi.fn(async () => ({
    ok: true,
    summary: "Diagnostics clean",
    diagnostics: [],
  })),
});

describe("patch verification coordinator", () => {
  it("runs fixed checks, refreshes formatter output, and returns bounded diagnostics", async () => {
    const current = await fixture();
    try {
      const applier = createApprovedPatchApplier(
        current.root,
        () => current.snapshot,
        current.proposals,
      );
      const adapters = passingAdapters();
      adapters.format = vi.fn(async (context) => {
        expect(context.files).toEqual(["src/Test.ts"]);
        expect(JSON.stringify(context)).not.toContain(source);
        await writeFile(current.file, formatted);
        return { ok: true, summary: "Formatting passed" };
      });
      adapters.diagnostics = vi.fn(async () => ({
        ok: true,
        summary: "Diagnostics clean",
        diagnostics: [
          {
            severity: "warning" as const,
            code: "VERIFY_HINT",
            sourceId: "src/Test.ts",
            message: 'apiKey = "verification-secret"',
          },
        ],
      }));
      const coordinator = createPatchVerificationCoordinator(
        current.proposals,
        applier,
        adapters,
      );

      const result = await coordinator.verify(
        {
          proposalId: current.proposal.id,
          approvalId: current.approvalId,
        },
        current.scope,
      );

      expect(result.status).toBe("verified");
      expect(result.checks.map((check) => [check.step, check.status])).toEqual([
        ["format", "passed"],
        ["typecheck", "passed"],
        ["test-scoped", "passed"],
        ["build", "skipped"],
        ["hmr", "passed"],
        ["diagnostics", "passed"],
      ]);
      expect(result.application.afterHashes).toEqual({
        "src/Test.ts": hash(formatted),
      });
      expect(JSON.stringify(result)).toContain("[REDACTED]");
      expect(JSON.stringify(result)).not.toContain("verification-secret");
      expect(await readFile(current.file, "utf8")).toBe(formatted);
    } finally {
      await rm(current.root, { recursive: true, force: true });
    }
  });

  it("rolls formatter output back when typecheck throws a private error", async () => {
    const current = await fixture();
    try {
      const applier = createApprovedPatchApplier(
        current.root,
        () => current.snapshot,
        current.proposals,
      );
      const adapters = passingAdapters();
      adapters.format = vi.fn(async () => {
        await writeFile(current.file, formatted);
        return { ok: true, summary: "Formatting passed" };
      });
      adapters.typecheck = vi.fn(async () => {
        throw new Error('apiKey = "typecheck-secret"');
      });
      const coordinator = createPatchVerificationCoordinator(
        current.proposals,
        applier,
        adapters,
      );

      const result = await coordinator.verify(
        {
          proposalId: current.proposal.id,
          approvalId: current.approvalId,
        },
        current.scope,
      );

      expect(result.status).toBe("rolled-back");
      expect(result.failedStep).toBe("typecheck");
      expect(result.rollback?.restoredHashes).toEqual({
        "src/Test.ts": hash(source),
      });
      expect(JSON.stringify(result)).not.toContain("typecheck-secret");
      expect(await readFile(current.file, "utf8")).toBe(source);
      expect(adapters.testScoped).not.toHaveBeenCalled();
    } finally {
      await rm(current.root, { recursive: true, force: true });
    }
  });

  it("times out HMR, skips later diagnostics, and restores the original source", async () => {
    const current = await fixture();
    try {
      const applier = createApprovedPatchApplier(
        current.root,
        () => current.snapshot,
        current.proposals,
      );
      const adapters = passingAdapters();
      adapters.hmr = vi.fn(async () => {
        await new Promise<void>(() => undefined);
        return { ok: true, summary: "unreachable" };
      });
      const coordinator = createPatchVerificationCoordinator(
        current.proposals,
        applier,
        adapters,
        { stepTimeoutMs: 5 },
      );

      const result = await coordinator.verify(
        {
          proposalId: current.proposal.id,
          approvalId: current.approvalId,
        },
        current.scope,
      );

      expect(result.status).toBe("rolled-back");
      expect(result.failedStep).toBe("hmr");
      expect(result.checks.at(-1)?.summary).toContain("timed out");
      expect(adapters.diagnostics).not.toHaveBeenCalled();
      expect(await readFile(current.file, "utf8")).toBe(source);
    } finally {
      await rm(current.root, { recursive: true, force: true });
    }
  });

  it("treats a missing required Node adapter as a failure and rolls back", async () => {
    const current = await fixture();
    try {
      const applier = createApprovedPatchApplier(
        current.root,
        () => current.snapshot,
        current.proposals,
      );
      const coordinator = createPatchVerificationCoordinator(
        current.proposals,
        applier,
        { format: passingAdapters().format! },
      );

      const result = await coordinator.verify(
        {
          proposalId: current.proposal.id,
          approvalId: current.approvalId,
        },
        current.scope,
      );

      expect(result.status).toBe("rolled-back");
      expect(result.failedStep).toBe("typecheck");
      expect(result.checks.at(-1)).toMatchObject({
        status: "failed",
        required: true,
      });
      expect(await readFile(current.file, "utf8")).toBe(source);
    } finally {
      await rm(current.root, { recursive: true, force: true });
    }
  });
});
