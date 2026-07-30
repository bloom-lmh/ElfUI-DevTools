import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CompilerStateSnapshot,
  SourceReadRequest,
  SourceReadResult,
} from "@elfui/devtools-shared";

const MAX_SOURCE_FILE_BYTES = 1_000_000;
const MAX_SOURCE_LINES = 200;
const MAX_SOURCE_CHARACTERS = 12_000;

export class ProjectSourceReadError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ProjectSourceReadError";
  }
}

const isInsideRoot = (root: string, file: string): boolean => {
  const pathFromRoot = relative(root, file);
  return (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
};

const normalizedReadRange = (
  input: SourceReadRequest,
  totalLines: number,
): { startLine: number; endLine: number } => {
  if (!input.range)
    return {
      startLine: 1,
      endLine: Math.min(totalLines, MAX_SOURCE_LINES),
    };
  const { startLine, endLine } = input.range;
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    throw new ProjectSourceReadError(400, "Invalid source range");
  return {
    startLine,
    endLine: Math.min(endLine, startLine + MAX_SOURCE_LINES - 1, totalLines),
  };
};

export interface ProjectSourceReadResult extends SourceReadResult {
  sha256: string;
}

export interface ProjectSourceFile {
  sourceId: string;
  file: string;
  content: string;
  sha256: string;
}

export type ProjectSourceReader = (
  input: SourceReadRequest,
) => ProjectSourceReadResult;

export type ProjectSourceFileResolver = (sourceId: string) => ProjectSourceFile;

export const createProjectSourceFileResolver = (
  root: string,
  getSnapshot: () => CompilerStateSnapshot,
): ProjectSourceFileResolver => {
  const projectRoot = realpathSync(resolve(root));
  return (sourceId) => {
    if (
      typeof sourceId !== "string" ||
      sourceId.length === 0 ||
      sourceId.includes("\0")
    )
      throw new ProjectSourceReadError(400, "Invalid sourceId");
    const knownSource = getSnapshot().artifacts.some(
      (artifact) => artifact.sourceId === sourceId,
    );
    if (!knownSource)
      throw new ProjectSourceReadError(
        403,
        "sourceId is not present in Compiler State",
      );

    const requestedFile = resolve(projectRoot, sourceId);
    if (!isInsideRoot(projectRoot, requestedFile))
      throw new ProjectSourceReadError(
        403,
        "Source file is outside the Vite project root",
      );
    if (!existsSync(requestedFile) || !statSync(requestedFile).isFile())
      throw new ProjectSourceReadError(404, "Source file does not exist");
    const sourceFile = realpathSync(requestedFile);
    if (!isInsideRoot(projectRoot, sourceFile))
      throw new ProjectSourceReadError(
        403,
        "Source file resolves outside the project root",
      );
    if (statSync(sourceFile).size > MAX_SOURCE_FILE_BYTES)
      throw new ProjectSourceReadError(
        413,
        "Source file exceeds the read limit",
      );

    const content = readFileSync(sourceFile, "utf8");
    return {
      sourceId,
      file: sourceFile,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  };
};

export const createProjectSourceReader = (
  root: string,
  getSnapshot: () => CompilerStateSnapshot,
): ProjectSourceReader => {
  const resolveSourceFile = createProjectSourceFileResolver(root, getSnapshot);
  return (input) => {
    if (!input || typeof input !== "object")
      throw new ProjectSourceReadError(400, "Invalid source request");
    const source = resolveSourceFile(input.sourceId);
    const lines = source.content.split(/\r?\n/u);
    const range = normalizedReadRange(input, lines.length);
    if (range.startLine > lines.length)
      throw new ProjectSourceReadError(400, "Invalid source range");
    const selected = lines.slice(range.startLine - 1, range.endLine).join("\n");
    const content = selected.slice(0, MAX_SOURCE_CHARACTERS);
    return {
      sourceId: input.sourceId,
      range,
      content,
      totalLines: lines.length,
      characterCount: content.length,
      sha256: source.sha256,
      truncated:
        range.endLine < lines.length || selected.length > MAX_SOURCE_CHARACTERS,
    };
  };
};
