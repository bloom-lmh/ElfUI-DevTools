// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  type PatchProposal,
} from "@elfui/devtools-ai";
import type { CompilerStateSnapshot } from "@elfui/devtools-shared";
import { describe, expect, it } from "vitest";

import {
  applyUnifiedDiffToSources,
  createApprovedPatchApplier,
} from "./patch-application";
import {
  createPatchProposalStore,
  type PatchProposalStore,
} from "./patch-proposals";

const hash = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const createFixture = async (sources: Record<string, string>) => {
  const root = await mkdtemp(join(process.cwd(), ".elfui-patch-application-"));
  await mkdir(join(root, "src"));
  const artifacts: CompilerStateSnapshot["artifacts"] = [];
  for (const [sourceId, content] of Object.entries(sources)) {
    const file = join(root, sourceId);
    await writeFile(file, content);
    artifacts.push({
      revision: 1,
      capturedAt: 1,
      id: file,
      sourceId,
      kind: "metadata",
      payload: {},
    });
  }
  const snapshot: CompilerStateSnapshot = {
    protocolVersion: 2,
    revision: 1,
    artifacts,
  };
  return { root, snapshot };
};

const proposal = (sources: Record<string, string>): PatchProposal => ({
  schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  id: "proposal:apply",
  requestId: "request:apply",
  summary: "Apply the approved values.",
  assumptions: ["Keep exports stable."],
  affectedFiles: Object.keys(sources),
  baseFileHashes: Object.fromEntries(
    Object.entries(sources).map(([file, content]) => [file, hash(content)]),
  ),
  unifiedDiff:
    Object.keys(sources).length === 1
      ? "diff --git a/src/A.ts b/src/A.ts\n--- a/src/A.ts\n+++ b/src/A.ts\n@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 2;\n"
      : "diff --git a/src/A.ts b/src/A.ts\n--- a/src/A.ts\n+++ b/src/A.ts\n@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 2;\ndiff --git a/src/B.ts b/src/B.ts\n--- a/src/B.ts\n+++ b/src/B.ts\n@@ -1,1 +1,1 @@\n-export const b = 10;\n+export const b = 20;\n",
  validationPlan: [
    {
      id: "validation:typecheck",
      kind: "typecheck",
      required: true,
      files: Object.keys(sources),
    },
  ],
  risk: "low",
});

const approve = (store: PatchProposalStore, patch: PatchProposal): string => {
  const scope = {
    requestId: patch.requestId,
    allowedSourceIds: patch.affectedFiles,
  };
  store.prepare(patch, scope);
  return store.decide({
    schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
    proposalId: patch.id,
    requestId: patch.requestId,
    decision: "approve",
  }).decisions[0]!.id;
};

describe("approved patch application", () => {
  it("applies a strictly approved Diff and returns before/after hashes", async () => {
    const sources = { "src/A.ts": "export const a = 1;\n" };
    const fixture = await createFixture(sources);
    try {
      const patch = proposal(sources);
      const store = createPatchProposalStore(
        fixture.root,
        () => fixture.snapshot,
      );
      const approvalId = approve(store, patch);
      const applier = createApprovedPatchApplier(
        fixture.root,
        () => fixture.snapshot,
        store,
        { now: () => 50 },
      );

      const result = await applier.apply(
        { proposalId: patch.id, approvalId },
        {
          requestId: patch.requestId,
          allowedSourceIds: patch.affectedFiles,
        },
      );

      const applied = "export const a = 2;\n";
      expect(await readFile(join(fixture.root, "src/A.ts"), "utf8")).toBe(
        applied,
      );
      expect(result).toEqual({
        applicationId: "application:1",
        proposalId: patch.id,
        approvalId,
        requestId: patch.requestId,
        files: ["src/A.ts"],
        beforeHashes: { "src/A.ts": hash(sources["src/A.ts"]) },
        afterHashes: { "src/A.ts": hash(applied) },
        appliedAt: 50,
        rolledBack: false,
      });

      const rollback = await applier.rollback(result.applicationId);
      expect(rollback).toEqual({
        applicationId: result.applicationId,
        proposalId: patch.id,
        approvalId,
        requestId: patch.requestId,
        files: ["src/A.ts"],
        restoredHashes: { "src/A.ts": hash(sources["src/A.ts"]) },
        rolledBackAt: 50,
        rolledBack: true,
      });
      expect(await readFile(join(fixture.root, "src/A.ts"), "utf8")).toBe(
        sources["src/A.ts"],
      );
      await expect(applier.rollback(result.applicationId)).resolves.toEqual(
        rollback,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects stale source, wrong approval IDs, and forged approval hashes", async () => {
    const sources = { "src/A.ts": "export const a = 1;\n" };
    const fixture = await createFixture(sources);
    try {
      const patch = proposal(sources);
      const store = createPatchProposalStore(
        fixture.root,
        () => fixture.snapshot,
      );
      const approvalId = approve(store, patch);
      const scope = {
        requestId: patch.requestId,
        allowedSourceIds: patch.affectedFiles,
      };
      const applier = createApprovedPatchApplier(
        fixture.root,
        () => fixture.snapshot,
        store,
      );

      await expect(
        applier.apply(
          { proposalId: patch.id, approvalId: "approval:forged" },
          scope,
        ),
      ).rejects.toMatchObject({ code: "PATCH_APPROVAL_NOT_FOUND" });

      const forgedReview = store.getReview(patch.id)!;
      forgedReview.decisions[0]!.approvedFileHashes["src/A.ts"] = "f".repeat(
        64,
      );
      const forgedStore: PatchProposalStore = {
        ...store,
        getReview: () => forgedReview,
      };
      const forgedApplier = createApprovedPatchApplier(
        fixture.root,
        () => fixture.snapshot,
        forgedStore,
      );
      await expect(
        forgedApplier.apply({ proposalId: patch.id, approvalId }, scope),
      ).rejects.toMatchObject({ code: "PATCH_APPROVAL_HASH_MISMATCH" });

      await writeFile(join(fixture.root, "src/A.ts"), "export const a = 3;\n");
      await expect(
        applier.apply({ proposalId: patch.id, approvalId }, scope),
      ).rejects.toMatchObject({ code: "PATCH_SOURCE_CHANGED" });
      expect(await readFile(join(fixture.root, "src/A.ts"), "utf8")).toBe(
        "export const a = 3;\n",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("restores every attempted file when a later write fails", async () => {
    const sources = {
      "src/A.ts": "export const a = 1;\n",
      "src/B.ts": "export const b = 10;\n",
    };
    const fixture = await createFixture(sources);
    try {
      const patch = proposal(sources);
      const store = createPatchProposalStore(
        fixture.root,
        () => fixture.snapshot,
      );
      const approvalId = approve(store, patch);
      let failed = false;
      const applier = createApprovedPatchApplier(
        fixture.root,
        () => fixture.snapshot,
        store,
        {
          writeSourceFile: async (file, content) => {
            if (!failed && file.endsWith("B.ts") && content.includes("20")) {
              failed = true;
              throw new Error("simulated second-file write failure");
            }
            await writeFile(file, content);
          },
        },
      );

      await expect(
        applier.apply(
          { proposalId: patch.id, approvalId },
          {
            requestId: patch.requestId,
            allowedSourceIds: patch.affectedFiles,
          },
        ),
      ).rejects.toMatchObject({ code: "PATCH_WRITE_FAILED" });
      expect(await readFile(join(fixture.root, "src/A.ts"), "utf8")).toBe(
        sources["src/A.ts"],
      );
      expect(await readFile(join(fixture.root, "src/B.ts"), "utf8")).toBe(
        sources["src/B.ts"],
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses rollback after an applied file was externally modified", async () => {
    const sources = { "src/A.ts": "export const a = 1;\n" };
    const fixture = await createFixture(sources);
    try {
      const patch = proposal(sources);
      const store = createPatchProposalStore(
        fixture.root,
        () => fixture.snapshot,
      );
      const approvalId = approve(store, patch);
      const applier = createApprovedPatchApplier(
        fixture.root,
        () => fixture.snapshot,
        store,
      );
      const application = await applier.apply(
        { proposalId: patch.id, approvalId },
        {
          requestId: patch.requestId,
          allowedSourceIds: patch.affectedFiles,
        },
      );
      await writeFile(join(fixture.root, "src/A.ts"), "export const a = 3;\n");

      await expect(
        applier.rollback(application.applicationId),
      ).rejects.toMatchObject({ code: "PATCH_SOURCE_CHANGED" });
      expect(await readFile(join(fixture.root, "src/A.ts"), "utf8")).toBe(
        "export const a = 3;\n",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("applies multiple hunks while preserving CRLF and final newline", () => {
    const source = "const a = 1;\r\nconst keep = true;\r\nconst b = 2;\r\n";
    const unifiedDiff =
      "diff --git a/src/Test.ts b/src/Test.ts\n--- a/src/Test.ts\n+++ b/src/Test.ts\n@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 10;\n@@ -3,1 +3,1 @@\n-const b = 2;\n+const b = 20;\n";

    expect(
      applyUnifiedDiffToSources(unifiedDiff, { "src/Test.ts": source }),
    ).toEqual({
      "src/Test.ts": "const a = 10;\r\nconst keep = true;\r\nconst b = 20;\r\n",
    });
  });
});
