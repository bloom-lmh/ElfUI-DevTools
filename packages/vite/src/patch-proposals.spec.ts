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
  createPatchProposalStore,
  unifiedDiffAffectedFiles,
} from "./patch-proposals";

const source = "export const value = 1;\n";
const sourceHash = createHash("sha256").update(source).digest("hex");

const proposal = (): PatchProposal => ({
  schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  id: "proposal:test",
  requestId: "request:test",
  summary: "Update the selected value.",
  assumptions: [],
  affectedFiles: ["src/Test.ts"],
  baseFileHashes: { "src/Test.ts": sourceHash },
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
});

const fixture = async () => {
  const root = await mkdtemp(join(process.cwd(), ".elfui-proposals-"));
  await mkdir(join(root, "src"));
  const file = join(root, "src", "Test.ts");
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
  return { root, file, snapshot };
};

describe("Patch proposal store", () => {
  it("parses a bounded unified Diff and stores a matching immutable proposal without writing", async () => {
    const current = await fixture();
    try {
      expect(unifiedDiffAffectedFiles(proposal().unifiedDiff)).toEqual([
        "src/Test.ts",
      ]);
      const store = createPatchProposalStore(
        current.root,
        () => current.snapshot,
      );
      const prepared = store.prepare(proposal(), {
        requestId: "request:test",
        allowedSourceIds: ["src/Test.ts"],
      });
      prepared.summary = "mutated caller copy";

      expect(store.get("proposal:test")?.summary).toBe(
        "Update the selected value.",
      );
      const reviews = store.list("request:test");
      expect(reviews).toEqual([
        expect.objectContaining({
          status: "pending",
          proposal: expect.objectContaining({ id: "proposal:test" }),
          decisions: [],
        }),
      ]);
      reviews[0]!.proposal.summary = "mutated review copy";
      expect(store.list("request:test")[0]?.proposal.summary).toBe(
        "Update the selected value.",
      );
      expect(await readFile(current.file, "utf8")).toBe(source);
    } finally {
      await rm(current.root, { recursive: true, force: true });
    }
  });

  it("derives immutable approval scope in Node and rejects duplicate decisions or proposal ID reuse", async () => {
    const current = await fixture();
    try {
      let time = 20;
      const store = createPatchProposalStore(
        current.root,
        () => current.snapshot,
        () => time++,
      );
      store.prepare(proposal(), {
        requestId: "request:test",
        allowedSourceIds: ["src/Test.ts"],
      });
      const review = store.decide({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        proposalId: "proposal:test",
        requestId: "request:test",
        decision: "approve",
      });

      expect(review).toMatchObject({
        status: "approved",
        decisions: [
          {
            decision: "approve",
            approvedFiles: ["src/Test.ts"],
            approvedFileHashes: { "src/Test.ts": sourceHash },
          },
        ],
      });
      expect(() =>
        store.decide({
          schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
          proposalId: "proposal:test",
          requestId: "request:test",
          decision: "reject",
        }),
      ).toThrow("terminal user decision");
      expect(() =>
        store.prepare(
          { ...proposal(), summary: "Conflicting immutable content" },
          {
            requestId: "request:test",
            allowedSourceIds: ["src/Test.ts"],
          },
        ),
      ).toThrow("different immutable content");
      expect(await readFile(current.file, "utf8")).toBe(source);
    } finally {
      await rm(current.root, { recursive: true, force: true });
    }
  });

  it("refuses approval when the source changed after proposal preparation", async () => {
    const current = await fixture();
    try {
      const store = createPatchProposalStore(
        current.root,
        () => current.snapshot,
      );
      store.prepare(proposal(), {
        requestId: "request:test",
        allowedSourceIds: ["src/Test.ts"],
      });
      await writeFile(current.file, "export const value = 3;\n");

      expect(() =>
        store.decide({
          schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
          proposalId: "proposal:test",
          requestId: "request:test",
          decision: "approve",
        }),
      ).toThrow("baseline hash is stale");
      expect(store.list("request:test")[0]?.status).toBe("pending");
    } finally {
      await rm(current.root, { recursive: true, force: true });
    }
  });

  it("records reject and commented revision decisions without approving or applying files", async () => {
    const current = await fixture();
    try {
      const store = createPatchProposalStore(
        current.root,
        () => current.snapshot,
      );
      for (const id of ["proposal:reject", "proposal:revise"])
        store.prepare(
          { ...proposal(), id },
          {
            requestId: "request:test",
            allowedSourceIds: ["src/Test.ts"],
          },
        );

      const rejected = store.decide({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        proposalId: "proposal:reject",
        requestId: "request:test",
        decision: "reject",
        comment: "Do not change this state.",
      });
      const revision = store.decide({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        proposalId: "proposal:revise",
        requestId: "request:test",
        decision: "revise",
        comment: "Preserve the current exported value.",
      });

      expect(rejected).toMatchObject({
        status: "rejected",
        decisions: [
          {
            decision: "reject",
            approvedFiles: [],
            approvedFileHashes: {},
            comment: "Do not change this state.",
          },
        ],
      });
      expect(revision).toMatchObject({
        status: "revision-requested",
        decisions: [
          {
            decision: "revise",
            approvedFiles: [],
            approvedFileHashes: {},
            comment: "Preserve the current exported value.",
          },
        ],
      });
      expect(await readFile(current.file, "utf8")).toBe(source);
    } finally {
      await rm(current.root, { recursive: true, force: true });
    }
  });

  it("rejects stale hashes, scope expansion, and Diff file mismatches", async () => {
    const current = await fixture();
    try {
      const store = createPatchProposalStore(
        current.root,
        () => current.snapshot,
      );
      expect(() =>
        store.prepare(
          {
            ...proposal(),
            baseFileHashes: { "src/Test.ts": "b".repeat(64) },
          },
          { requestId: "request:test", allowedSourceIds: ["src/Test.ts"] },
        ),
      ).toThrow("baseline hash is stale");
      expect(() =>
        store.prepare(proposal(), {
          requestId: "request:test",
          allowedSourceIds: [],
        }),
      ).toThrow("outside the approved scope");
      expect(() =>
        unifiedDiffAffectedFiles(
          proposal().unifiedDiff.replaceAll("src/Test.ts", "../Secret.ts"),
        ),
      ).toThrow("project-relative path");
      expect(() =>
        unifiedDiffAffectedFiles(
          proposal().unifiedDiff.replace("@@ -1,1 +1,1 @@", "@@ -1,2 +1,1 @@"),
        ),
      ).toThrow("hunk counts do not match");
      expect(await readFile(current.file, "utf8")).toBe(source);
    } finally {
      await rm(current.root, { recursive: true, force: true });
    }
  });
});
