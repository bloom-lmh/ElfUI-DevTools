import {
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  isPatchProposal,
  isProjectRelativePath,
  type PatchApproval,
  type PatchProposal,
  type PatchProposalDecisionRequest,
  type PatchProposalReview,
  type PatchProposalReviewStatus,
} from "@elfui/devtools-ai";
import type { CompilerStateSnapshot } from "@elfui/devtools-shared";

import type { AIAgentToolScope } from "./agent-tools.js";
import { createProjectSourceReader } from "./project-source-reader.js";

const MAX_PROPOSALS = 50;

export class PatchProposalError extends Error {
  public constructor(
    public readonly code:
      | "PATCH_PROPOSAL_INVALID"
      | "PATCH_PROPOSAL_SCOPE_DENIED"
      | "PATCH_PROPOSAL_DIFF_INVALID"
      | "PATCH_PROPOSAL_HASH_MISMATCH"
      | "PATCH_PROPOSAL_ID_CONFLICT"
      | "PATCH_PROPOSAL_NOT_FOUND"
      | "PATCH_PROPOSAL_DECISION_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "PatchProposalError";
  }
}

interface DiffFileState {
  file: string;
  oldHeader: boolean;
  newHeader: boolean;
  hunk: boolean;
  oldLinesRemaining: number;
  newLinesRemaining: number;
}

const finalizeHunk = (state: DiffFileState): void => {
  if (
    state.hunk &&
    (state.oldLinesRemaining !== 0 || state.newLinesRemaining !== 0)
  )
    throw new PatchProposalError(
      "PATCH_PROPOSAL_DIFF_INVALID",
      `Unified Diff hunk counts do not match content for ${state.file}`,
    );
};

const finalizeDiffFile = (
  state: DiffFileState | null,
  files: string[],
): void => {
  if (!state) return;
  finalizeHunk(state);
  if (!state.oldHeader || !state.newHeader || !state.hunk)
    throw new PatchProposalError(
      "PATCH_PROPOSAL_DIFF_INVALID",
      `Unified Diff for ${state.file} is missing file headers or hunks`,
    );
  if (files.includes(state.file))
    throw new PatchProposalError(
      "PATCH_PROPOSAL_DIFF_INVALID",
      `Unified Diff repeats ${state.file}`,
    );
  files.push(state.file);
};

export const unifiedDiffAffectedFiles = (unifiedDiff: string): string[] => {
  const files: string[] = [];
  let current: DiffFileState | null = null;
  for (const line of unifiedDiff.split(/\r?\n/u)) {
    const fileHeader = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (fileHeader) {
      finalizeDiffFile(current, files);
      const oldFile = fileHeader[1]!;
      const newFile = fileHeader[2]!;
      if (
        oldFile !== newFile ||
        !isProjectRelativePath(oldFile) ||
        oldFile.includes("\t")
      )
        throw new PatchProposalError(
          "PATCH_PROPOSAL_DIFF_INVALID",
          "Unified Diff must modify one project-relative path per file",
        );
      current = {
        file: oldFile,
        oldHeader: false,
        newHeader: false,
        hunk: false,
        oldLinesRemaining: 0,
        newLinesRemaining: 0,
      };
      continue;
    }
    if (
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("copy from ") ||
      line.startsWith("copy to ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("Binary files ")
    )
      throw new PatchProposalError(
        "PATCH_PROPOSAL_DIFF_INVALID",
        "Rename, copy, create, delete, and binary diffs are not supported",
      );
    if (!current) {
      if (line.length > 0)
        throw new PatchProposalError(
          "PATCH_PROPOSAL_DIFF_INVALID",
          "Unified Diff must start with a diff --git file header",
        );
      continue;
    }
    if (current.hunk && !line.startsWith("@@")) {
      if (line === "\\ No newline at end of file") continue;
      if (line.length === 0) {
        finalizeHunk(current);
        continue;
      }
      const prefix = line[0];
      if (prefix === " ") {
        current.oldLinesRemaining -= 1;
        current.newLinesRemaining -= 1;
      } else if (prefix === "-") current.oldLinesRemaining -= 1;
      else if (prefix === "+") current.newLinesRemaining -= 1;
      else
        throw new PatchProposalError(
          "PATCH_PROPOSAL_DIFF_INVALID",
          `Unified Diff has invalid hunk content for ${current.file}`,
        );
      if (current.oldLinesRemaining < 0 || current.newLinesRemaining < 0)
        throw new PatchProposalError(
          "PATCH_PROPOSAL_DIFF_INVALID",
          `Unified Diff hunk contains too many lines for ${current.file}`,
        );
      continue;
    }
    if (line.startsWith("--- ")) {
      if (line !== `--- a/${current.file}` || current.oldHeader)
        throw new PatchProposalError(
          "PATCH_PROPOSAL_DIFF_INVALID",
          `Unified Diff has an invalid old-file header for ${current.file}`,
        );
      current.oldHeader = true;
    } else if (line.startsWith("+++ ")) {
      if (
        line !== `+++ b/${current.file}` ||
        !current.oldHeader ||
        current.newHeader
      )
        throw new PatchProposalError(
          "PATCH_PROPOSAL_DIFF_INVALID",
          `Unified Diff has an invalid new-file header for ${current.file}`,
        );
      current.newHeader = true;
    } else if (line.startsWith("@@")) {
      if (!current.oldHeader || !current.newHeader)
        throw new PatchProposalError(
          "PATCH_PROPOSAL_DIFF_INVALID",
          `Unified Diff hunk for ${current.file} appears before file headers`,
        );
      finalizeHunk(current);
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(
        line,
      );
      if (!hunk)
        throw new PatchProposalError(
          "PATCH_PROPOSAL_DIFF_INVALID",
          `Unified Diff has an invalid hunk header for ${current.file}`,
        );
      current.hunk = true;
      current.oldLinesRemaining = hunk[2] ? Number(hunk[2]) : 1;
      current.newLinesRemaining = hunk[4] ? Number(hunk[4]) : 1;
    }
  }
  finalizeDiffFile(current, files);
  if (files.length === 0)
    throw new PatchProposalError(
      "PATCH_PROPOSAL_DIFF_INVALID",
      "Unified Diff does not contain any files",
    );
  return files;
};

const cloneProposal = (proposal: PatchProposal): PatchProposal =>
  JSON.parse(JSON.stringify(proposal)) as PatchProposal;

const cloneReview = (review: PatchProposalReview): PatchProposalReview =>
  JSON.parse(JSON.stringify(review)) as PatchProposalReview;

const statusForDecision = (
  decision: PatchApproval["decision"],
): PatchProposalReviewStatus =>
  decision === "approve"
    ? "approved"
    : decision === "reject"
      ? "rejected"
      : "revision-requested";

export interface PatchProposalStore {
  prepare(proposal: PatchProposal, scope: AIAgentToolScope): PatchProposal;
  get(proposalId: string): PatchProposal | null;
  getReview(proposalId: string): PatchProposalReview | null;
  list(requestId: string): PatchProposalReview[];
  decide(input: PatchProposalDecisionRequest): PatchProposalReview;
}

export const createPatchProposalStore = (
  root: string,
  getSnapshot: () => CompilerStateSnapshot,
  now: () => number = Date.now,
): PatchProposalStore => {
  const readSource = createProjectSourceReader(root, getSnapshot);
  const proposals = new Map<string, PatchProposalReview>();
  let nextApprovalId = 1;
  return {
    prepare(proposal, scope) {
      if (!isPatchProposal(proposal))
        throw new PatchProposalError(
          "PATCH_PROPOSAL_INVALID",
          "Patch proposal failed schema validation",
        );
      if (proposal.requestId !== scope.requestId)
        throw new PatchProposalError(
          "PATCH_PROPOSAL_SCOPE_DENIED",
          "Patch proposal does not belong to the active AI request",
        );
      const allowed = new Set(scope.allowedSourceIds);
      if (proposal.affectedFiles.some((file) => !allowed.has(file)))
        throw new PatchProposalError(
          "PATCH_PROPOSAL_SCOPE_DENIED",
          "Patch proposal affects files outside the approved scope",
        );
      const diffFiles = unifiedDiffAffectedFiles(proposal.unifiedDiff);
      if (
        diffFiles.length !== proposal.affectedFiles.length ||
        diffFiles.some((file, index) => file !== proposal.affectedFiles[index])
      )
        throw new PatchProposalError(
          "PATCH_PROPOSAL_DIFF_INVALID",
          "Unified Diff files do not exactly match affectedFiles order",
        );
      for (const file of proposal.affectedFiles) {
        const actualHash = readSource({ sourceId: file }).sha256;
        if (proposal.baseFileHashes[file] !== actualHash)
          throw new PatchProposalError(
            "PATCH_PROPOSAL_HASH_MISMATCH",
            `Patch proposal baseline hash is stale for ${file}`,
          );
      }
      const existing = proposals.get(proposal.id);
      if (existing) {
        if (JSON.stringify(existing.proposal) !== JSON.stringify(proposal))
          throw new PatchProposalError(
            "PATCH_PROPOSAL_ID_CONFLICT",
            "Patch proposal id already belongs to different immutable content",
          );
        return cloneProposal(existing.proposal);
      }
      const createdAt = now();
      proposals.set(proposal.id, {
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        proposal: cloneProposal(proposal),
        status: "pending",
        decisions: [],
        createdAt,
        updatedAt: createdAt,
      });
      while (proposals.size > MAX_PROPOSALS) {
        const oldest = proposals.keys().next().value as string | undefined;
        if (!oldest) break;
        proposals.delete(oldest);
      }
      return cloneProposal(proposal);
    },
    get(proposalId) {
      const review = proposals.get(proposalId);
      return review ? cloneProposal(review.proposal) : null;
    },
    getReview(proposalId) {
      const review = proposals.get(proposalId);
      return review ? cloneReview(review) : null;
    },
    list(requestId) {
      return [...proposals.values()]
        .filter((review) => review.proposal.requestId === requestId)
        .reverse()
        .map(cloneReview);
    },
    decide(input) {
      const review = proposals.get(input.proposalId);
      if (!review || review.proposal.requestId !== input.requestId)
        throw new PatchProposalError(
          "PATCH_PROPOSAL_NOT_FOUND",
          "Patch proposal was not found for the active AI request",
        );
      if (review.decisions.length > 0)
        throw new PatchProposalError(
          "PATCH_PROPOSAL_DECISION_CONFLICT",
          "Patch proposal already has a terminal user decision",
        );
      if (input.decision === "approve")
        for (const file of review.proposal.affectedFiles) {
          const actualHash = readSource({ sourceId: file }).sha256;
          if (actualHash !== review.proposal.baseFileHashes[file])
            throw new PatchProposalError(
              "PATCH_PROPOSAL_HASH_MISMATCH",
              `Patch proposal baseline hash is stale for ${file}`,
            );
        }
      const createdAt = Math.max(now(), review.updatedAt);
      const comment = input.comment?.trim();
      const approval: PatchApproval = {
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        id: `approval:${nextApprovalId++}`,
        proposalId: review.proposal.id,
        requestId: review.proposal.requestId,
        decision: input.decision,
        approvedFiles:
          input.decision === "approve"
            ? [...review.proposal.affectedFiles]
            : [],
        approvedFileHashes:
          input.decision === "approve"
            ? { ...review.proposal.baseFileHashes }
            : {},
        ...(comment ? { comment } : {}),
        createdAt,
      };
      review.status = statusForDecision(input.decision);
      review.decisions.push(approval);
      review.updatedAt = createdAt;
      return cloneReview(review);
    },
  };
};
