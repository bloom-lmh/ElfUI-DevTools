import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { CompilerStateSnapshot } from "@elfui/devtools-shared";

import type { AIAgentToolScope } from "./agent-tools.js";
import type { PatchProposalStore } from "./patch-proposals.js";
import { unifiedDiffAffectedFiles } from "./patch-proposals.js";
import {
  createProjectSourceFileResolver,
  type ProjectSourceFile,
} from "./project-source-reader.js";

export type ApprovedPatchApplicationErrorCode =
  | "PATCH_APPROVAL_NOT_FOUND"
  | "PATCH_APPROVAL_SCOPE_MISMATCH"
  | "PATCH_APPROVAL_HASH_MISMATCH"
  | "PATCH_SOURCE_CHANGED"
  | "PATCH_DIFF_CONTEXT_MISMATCH"
  | "PATCH_WRITE_FAILED"
  | "PATCH_ROLLBACK_FAILED"
  | "PATCH_APPLICATION_NOT_FOUND"
  | "PATCH_APPLICATION_LIMIT_EXCEEDED"
  | "PATCH_APPLICATION_IN_PROGRESS"
  | "PATCH_ALREADY_APPLIED";

export class ApprovedPatchApplicationError extends Error {
  public constructor(
    public readonly code: ApprovedPatchApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApprovedPatchApplicationError";
  }
}

export interface ApprovedPatchApplicationRequest {
  proposalId: string;
  approvalId: string;
}

export interface ApprovedPatchApplicationResult {
  applicationId: string;
  proposalId: string;
  approvalId: string;
  requestId: string;
  files: string[];
  beforeHashes: Record<string, string>;
  afterHashes: Record<string, string>;
  appliedAt: number;
  rolledBack: false;
}

export interface ApprovedPatchRollbackResult {
  applicationId: string;
  proposalId: string;
  approvalId: string;
  requestId: string;
  files: string[];
  restoredHashes: Record<string, string>;
  rolledBackAt: number;
  rolledBack: true;
}

export interface ApprovedPatchApplier {
  apply(
    input: ApprovedPatchApplicationRequest,
    scope: AIAgentToolScope,
  ): Promise<ApprovedPatchApplicationResult>;
  refresh(applicationId: string): Promise<ApprovedPatchApplicationResult>;
  rollback(applicationId: string): Promise<ApprovedPatchRollbackResult>;
}

interface DiffLine {
  operation: "context" | "remove" | "add";
  text: string;
}

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newCount: number;
  lines: DiffLine[];
}

interface FileDiff {
  file: string;
  hunks: DiffHunk[];
}

interface StagedFile {
  source: ProjectSourceFile;
  content: string;
  afterHash: string;
}

export interface ApprovedPatchApplierOptions {
  now?: () => number;
  writeSourceFile?: (file: string, content: string) => Promise<void>;
  maxApplications?: number;
}

interface ApplicationTransaction {
  result: ApprovedPatchApplicationResult;
  staged: StagedFile[];
  rollback: ApprovedPatchRollbackResult | null;
}

const cloneApplicationResult = (
  result: ApprovedPatchApplicationResult,
): ApprovedPatchApplicationResult => ({
  ...result,
  files: [...result.files],
  beforeHashes: { ...result.beforeHashes },
  afterHashes: { ...result.afterHashes },
});

const cloneRollbackResult = (
  result: ApprovedPatchRollbackResult,
): ApprovedPatchRollbackResult => ({
  ...result,
  files: [...result.files],
  restoredHashes: { ...result.restoredHashes },
});

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const sameHashes = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    sameStrings(leftKeys, rightKeys) &&
    leftKeys.every((key) => left[key] === right[key])
  );
};

const parseUnifiedDiff = (unifiedDiff: string): FileDiff[] => {
  const expectedFiles = unifiedDiffAffectedFiles(unifiedDiff);
  const files: FileDiff[] = [];
  let currentFile: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const line of unifiedDiff.split(/\r?\n/u)) {
    const fileHeader = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (fileHeader) {
      currentFile = { file: fileHeader[1]!, hunks: [] };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }
    const hunkHeader =
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(line);
    if (hunkHeader && currentFile) {
      currentHunk = {
        oldStart: Number(hunkHeader[1]),
        oldCount: hunkHeader[2] ? Number(hunkHeader[2]) : 1,
        newCount: hunkHeader[4] ? Number(hunkHeader[4]) : 1,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk || line === "\\ No newline at end of file") continue;
    const prefix = line[0];
    if (prefix === " ")
      currentHunk.lines.push({ operation: "context", text: line.slice(1) });
    else if (prefix === "-")
      currentHunk.lines.push({ operation: "remove", text: line.slice(1) });
    else if (prefix === "+")
      currentHunk.lines.push({ operation: "add", text: line.slice(1) });
  }

  if (
    !sameStrings(
      files.map((file) => file.file),
      expectedFiles,
    )
  )
    throw new ApprovedPatchApplicationError(
      "PATCH_DIFF_CONTEXT_MISMATCH",
      "Unified Diff files changed after proposal validation",
    );
  return files;
};

const sourceLines = (
  source: string,
): { lines: string[]; eol: string; finalEol: boolean } => {
  const finalEol = /\r?\n$/u.test(source);
  const lines = source.length === 0 ? [] : source.split(/\r?\n/u);
  if (finalEol) lines.pop();
  return {
    lines,
    eol: source.includes("\r\n") ? "\r\n" : "\n",
    finalEol,
  };
};

const applyFileDiff = (source: string, diff: FileDiff): string => {
  const split = sourceLines(source);
  const output: string[] = [];
  let sourceIndex = 0;

  for (const hunk of diff.hunks) {
    const hunkIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (hunkIndex < sourceIndex || hunkIndex > split.lines.length)
      throw new ApprovedPatchApplicationError(
        "PATCH_DIFF_CONTEXT_MISMATCH",
        `Patch hunk position no longer matches ${diff.file}`,
      );
    output.push(...split.lines.slice(sourceIndex, hunkIndex));
    sourceIndex = hunkIndex;
    let oldLines = 0;
    let newLines = 0;
    for (const line of hunk.lines) {
      if (line.operation === "add") {
        output.push(line.text);
        newLines += 1;
        continue;
      }
      if (split.lines[sourceIndex] !== line.text)
        throw new ApprovedPatchApplicationError(
          "PATCH_DIFF_CONTEXT_MISMATCH",
          `Patch context no longer matches ${diff.file}`,
        );
      if (line.operation === "context") {
        output.push(line.text);
        newLines += 1;
      }
      sourceIndex += 1;
      oldLines += 1;
    }
    if (oldLines !== hunk.oldCount || newLines !== hunk.newCount)
      throw new ApprovedPatchApplicationError(
        "PATCH_DIFF_CONTEXT_MISMATCH",
        `Patch hunk counts no longer match ${diff.file}`,
      );
  }
  output.push(...split.lines.slice(sourceIndex));
  const content = output.join(split.eol);
  return split.finalEol ? `${content}${split.eol}` : content;
};

const applicationError = (
  code: ApprovedPatchApplicationErrorCode,
  message: string,
): ApprovedPatchApplicationError =>
  new ApprovedPatchApplicationError(code, message);

export const createApprovedPatchApplier = (
  root: string,
  getSnapshot: () => CompilerStateSnapshot,
  proposals: PatchProposalStore,
  options: ApprovedPatchApplierOptions = {},
): ApprovedPatchApplier => {
  const resolveSourceFile = createProjectSourceFileResolver(root, getSnapshot);
  const writeSourceFile =
    options.writeSourceFile ??
    ((file: string, content: string) => writeFile(file, content, "utf8"));
  const now = options.now ?? Date.now;
  const maxApplications =
    typeof options.maxApplications === "number" &&
    Number.isSafeInteger(options.maxApplications) &&
    options.maxApplications > 0
      ? options.maxApplications
      : 20;
  const applications = new Map<string, ApplicationTransaction>();
  let nextApplicationId = 1;

  return {
    async apply(input, scope) {
      if (applications.size >= maxApplications)
        for (const [applicationId, transaction] of applications) {
          if (!transaction.rollback) continue;
          applications.delete(applicationId);
          if (applications.size < maxApplications) break;
        }
      if (applications.size >= maxApplications)
        throw applicationError(
          "PATCH_APPLICATION_LIMIT_EXCEEDED",
          "Patch application history is full; resolve or restart existing transactions",
        );
      const review = proposals.getReview(input.proposalId);
      const approval = review?.decisions.find(
        (decision) => decision.id === input.approvalId,
      );
      if (
        !review ||
        review.proposal.requestId !== scope.requestId ||
        review.status !== "approved" ||
        !approval ||
        approval.decision !== "approve"
      )
        throw applicationError(
          "PATCH_APPROVAL_NOT_FOUND",
          "Patch proposal does not have the requested active approval",
        );

      const proposal = review.proposal;
      if (
        !sameStrings(approval.approvedFiles, proposal.affectedFiles) ||
        proposal.affectedFiles.some(
          (sourceId) => !scope.allowedSourceIds.includes(sourceId),
        )
      )
        throw applicationError(
          "PATCH_APPROVAL_SCOPE_MISMATCH",
          "Patch approval does not exactly match the active proposal scope",
        );
      if (!sameHashes(approval.approvedFileHashes, proposal.baseFileHashes))
        throw applicationError(
          "PATCH_APPROVAL_HASH_MISMATCH",
          "Patch approval hashes do not exactly match the active proposal",
        );

      const diffs = parseUnifiedDiff(proposal.unifiedDiff);
      const staged = diffs.map((diff): StagedFile => {
        const source = resolveSourceFile(diff.file);
        if (
          source.sha256 !== proposal.baseFileHashes[diff.file] ||
          source.sha256 !== approval.approvedFileHashes[diff.file]
        )
          throw applicationError(
            "PATCH_SOURCE_CHANGED",
            `Approved source changed before application: ${diff.file}`,
          );
        const content = applyFileDiff(source.content, diff);
        return { source, content, afterHash: sha256(content) };
      });

      for (const file of staged) {
        const current = resolveSourceFile(file.source.sourceId);
        if (
          current.file !== file.source.file ||
          current.sha256 !== file.source.sha256
        )
          throw applicationError(
            "PATCH_SOURCE_CHANGED",
            `Approved source changed before commit: ${file.source.sourceId}`,
          );
      }

      const attempted: StagedFile[] = [];
      try {
        for (const file of staged) {
          const current = resolveSourceFile(file.source.sourceId);
          if (
            current.file !== file.source.file ||
            current.sha256 !== file.source.sha256
          )
            throw applicationError(
              "PATCH_SOURCE_CHANGED",
              `Approved source changed during commit: ${file.source.sourceId}`,
            );
          attempted.push(file);
          await writeSourceFile(file.source.file, file.content);
          const written = resolveSourceFile(file.source.sourceId);
          if (
            written.file !== file.source.file ||
            written.sha256 !== file.afterHash
          )
            throw applicationError(
              "PATCH_WRITE_FAILED",
              `Patch write verification failed for ${file.source.sourceId}`,
            );
        }
      } catch (error) {
        try {
          for (const file of attempted.reverse()) {
            const current = resolveSourceFile(file.source.sourceId);
            if (current.sha256 === file.source.sha256) continue;
            if (
              current.file !== file.source.file ||
              current.sha256 !== file.afterHash
            )
              throw new Error("Source changed outside the patch transaction");
            await writeSourceFile(file.source.file, file.source.content);
            const restored = resolveSourceFile(file.source.sourceId);
            if (
              restored.file !== file.source.file ||
              restored.sha256 !== file.source.sha256
            )
              throw new Error("Source restoration verification failed");
          }
        } catch {
          throw applicationError(
            "PATCH_ROLLBACK_FAILED",
            "Patch application failed and the original source could not be fully restored",
          );
        }
        if (error instanceof ApprovedPatchApplicationError) throw error;
        throw applicationError(
          "PATCH_WRITE_FAILED",
          "Patch application failed and all attempted files were restored",
        );
      }

      const result: ApprovedPatchApplicationResult = {
        applicationId: `application:${nextApplicationId++}`,
        proposalId: proposal.id,
        approvalId: approval.id,
        requestId: proposal.requestId,
        files: [...proposal.affectedFiles],
        beforeHashes: { ...proposal.baseFileHashes },
        afterHashes: Object.fromEntries(
          staged.map((file) => [file.source.sourceId, file.afterHash]),
        ),
        appliedAt: now(),
        rolledBack: false,
      };
      applications.set(result.applicationId, {
        result,
        staged,
        rollback: null,
      });
      return cloneApplicationResult(result);
    },
    async refresh(applicationId) {
      const transaction = applications.get(applicationId);
      if (!transaction || transaction.rollback)
        throw applicationError(
          "PATCH_APPLICATION_NOT_FOUND",
          "Active patch application transaction was not found",
        );
      for (const file of transaction.staged) {
        const current = resolveSourceFile(file.source.sourceId);
        if (current.file !== file.source.file)
          throw applicationError(
            "PATCH_SOURCE_CHANGED",
            `Applied source path changed during refresh: ${file.source.sourceId}`,
          );
        file.content = current.content;
        file.afterHash = current.sha256;
      }
      transaction.result.afterHashes = Object.fromEntries(
        transaction.staged.map((file) => [
          file.source.sourceId,
          file.afterHash,
        ]),
      );
      return cloneApplicationResult(transaction.result);
    },
    async rollback(applicationId) {
      const transaction = applications.get(applicationId);
      if (!transaction)
        throw applicationError(
          "PATCH_APPLICATION_NOT_FOUND",
          "Patch application transaction was not found",
        );
      if (transaction.rollback)
        return cloneRollbackResult(transaction.rollback);

      for (const file of transaction.staged) {
        const current = resolveSourceFile(file.source.sourceId);
        if (
          current.file !== file.source.file ||
          current.sha256 !== file.afterHash
        )
          throw applicationError(
            "PATCH_SOURCE_CHANGED",
            `Applied source changed before rollback: ${file.source.sourceId}`,
          );
      }

      const attempted: StagedFile[] = [];
      try {
        for (const file of [...transaction.staged].reverse()) {
          attempted.push(file);
          await writeSourceFile(file.source.file, file.source.content);
          const restored = resolveSourceFile(file.source.sourceId);
          if (
            restored.file !== file.source.file ||
            restored.sha256 !== file.source.sha256
          )
            throw new Error("Source restoration verification failed");
        }
      } catch {
        try {
          for (const file of attempted) {
            const current = resolveSourceFile(file.source.sourceId);
            if (current.sha256 === file.afterHash) continue;
            if (
              current.file !== file.source.file ||
              current.sha256 !== file.source.sha256
            )
              throw new Error(
                "Source changed outside the rollback transaction",
              );
            await writeSourceFile(file.source.file, file.content);
            const reapplied = resolveSourceFile(file.source.sourceId);
            if (
              reapplied.file !== file.source.file ||
              reapplied.sha256 !== file.afterHash
            )
              throw new Error("Patched source restoration failed");
          }
        } catch {
          throw applicationError(
            "PATCH_ROLLBACK_FAILED",
            "Patch rollback failed and the applied source state could not be fully restored",
          );
        }
        throw applicationError(
          "PATCH_ROLLBACK_FAILED",
          "Patch rollback failed; the complete applied source state was restored",
        );
      }

      const rollback: ApprovedPatchRollbackResult = {
        applicationId,
        proposalId: transaction.result.proposalId,
        approvalId: transaction.result.approvalId,
        requestId: transaction.result.requestId,
        files: [...transaction.result.files],
        restoredHashes: { ...transaction.result.beforeHashes },
        rolledBackAt: now(),
        rolledBack: true,
      };
      transaction.rollback = rollback;
      transaction.staged = [];
      return cloneRollbackResult(rollback);
    },
  };
};

export const applyUnifiedDiffToSources = (
  unifiedDiff: string,
  sources: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    parseUnifiedDiff(unifiedDiff).map((diff) => {
      const source = sources[diff.file];
      if (source === undefined)
        throw applicationError(
          "PATCH_DIFF_CONTEXT_MISMATCH",
          `Patch source is missing for ${diff.file}`,
        );
      return [diff.file, applyFileDiff(source, diff)];
    }),
  );
