import type { CompilerStateSnapshot } from "@elfui/devtools-shared";
import { redactSensitiveText } from "@elfui/devtools-shared";
import {
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  isAIAgentToolCall,
  type AIAgentToolCall,
  type AIAgentToolResult,
  type AIProviderJSONValue,
} from "@elfui/devtools-ai";

import {
  createProjectSourceReader,
  ProjectSourceReadError,
  type ProjectSourceReader,
} from "./project-source-reader.js";

const MAX_SEARCH_FILES = 200;
const MAX_SEARCH_CHARACTERS = 500_000;
const MAX_READ_CHARACTERS = 32_000;
const SEARCH_CHUNK_LINES = 200;

export interface AIAgentToolScope {
  requestId: string;
  allowedSourceIds: readonly string[];
}

export interface ReadonlyAIAgentTools {
  execute(
    call: AIAgentToolCall,
    scope: AIAgentToolScope,
  ): Promise<AIAgentToolResult>;
}

const completed = (
  call: AIAgentToolCall,
  output: AIProviderJSONValue,
): AIAgentToolResult => ({
  schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  callId: call.id,
  name: call.name,
  status: "completed",
  output,
});

const failed = (
  call: AIAgentToolCall,
  code: string,
  message: string,
  retryable = false,
): AIAgentToolResult => ({
  schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  callId: call.id,
  name: call.name,
  status: "failed",
  error: { code, message, retryable },
});

const globExpression = (pattern: string): RegExp => {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else expression += "[^/]*";
    } else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`, "u");
};

const matchesInclude = (
  sourceId: string,
  includes: readonly RegExp[],
): boolean =>
  includes.length === 0 || includes.some((pattern) => pattern.test(sourceId));

const sourceIdsForScope = (
  snapshot: CompilerStateSnapshot,
  scope: AIAgentToolScope,
): string[] => {
  const allowed = new Set(scope.allowedSourceIds);
  return [
    ...new Set(
      snapshot.artifacts
        .map((artifact) => artifact.sourceId)
        .filter((sourceId) => allowed.has(sourceId)),
    ),
  ].slice(0, MAX_SEARCH_FILES);
};

const assertAllowed = (sourceId: string, scope: AIAgentToolScope): void => {
  if (!scope.allowedSourceIds.includes(sourceId))
    throw new Error("Source is outside the approved AI tool scope");
};

const readRanges = (
  call: Extract<AIAgentToolCall, { name: "source.readRanges" }>,
  scope: AIAgentToolScope,
  readSource: ProjectSourceReader,
): AIAgentToolResult => {
  assertAllowed(call.arguments.sourceId, scope);
  let remaining = MAX_READ_CHARACTERS;
  const blocks: AIProviderJSONValue[] = [];
  let truncated = false;
  for (const range of call.arguments.ranges) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const result = readSource({
      sourceId: call.arguments.sourceId,
      range,
    });
    const redacted = redactSensitiveText(result.content);
    const content = redacted.text.slice(0, remaining);
    remaining -= content.length;
    blocks.push({
      sourceId: result.sourceId,
      startLine: result.range.startLine,
      endLine: result.range.endLine,
      content,
      sha256: result.sha256,
      redactions: redacted.replacements,
      truncated: result.truncated || content.length < redacted.text.length,
    });
    if (content.length < redacted.text.length) truncated = true;
  }
  return completed(call, { blocks, truncated });
};

const readFile = (
  call: Extract<AIAgentToolCall, { name: "source.readFile" }>,
  scope: AIAgentToolScope,
  readSource: ProjectSourceReader,
): AIAgentToolResult => {
  assertAllowed(call.arguments.sourceId, scope);
  const result = readSource({ sourceId: call.arguments.sourceId });
  const redacted = redactSensitiveText(result.content);
  return completed(call, {
    sourceId: result.sourceId,
    startLine: result.range.startLine,
    endLine: result.range.endLine,
    totalLines: result.totalLines,
    content: redacted.text,
    sha256: result.sha256,
    redactions: redacted.replacements,
    truncated: result.truncated,
  });
};

const searchProject = (
  call: Extract<AIAgentToolCall, { name: "project.search" }>,
  scope: AIAgentToolScope,
  snapshot: CompilerStateSnapshot,
  readSource: ProjectSourceReader,
): AIAgentToolResult => {
  const query = call.arguments.query.toLowerCase();
  const maximum = call.arguments.maxResults ?? 20;
  const includes = (call.arguments.include ?? []).map(globExpression);
  const sourceIds = sourceIdsForScope(snapshot, scope);
  const matches: AIProviderJSONValue[] = [];
  let scannedCharacters = 0;
  let truncated = false;

  for (const sourceId of sourceIds) {
    if (!matchesInclude(sourceId, includes)) continue;
    let startLine = 1;
    while (matches.length < maximum) {
      const result = readSource({
        sourceId,
        range: {
          startLine,
          endLine: startLine + SEARCH_CHUNK_LINES - 1,
        },
      });
      scannedCharacters += result.content.length;
      const lines = result.content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index]!.toLowerCase().includes(query)) continue;
        const preview = redactSensitiveText(lines[index]!.trim()).text.slice(
          0,
          500,
        );
        matches.push({
          sourceId,
          line: result.range.startLine + index,
          preview,
        });
        if (matches.length >= maximum) break;
      }
      if (
        matches.length >= maximum ||
        scannedCharacters >= MAX_SEARCH_CHARACTERS ||
        result.range.endLine >= result.totalLines
      ) {
        truncated =
          matches.length >= maximum ||
          scannedCharacters >= MAX_SEARCH_CHARACTERS;
        break;
      }
      startLine = result.range.endLine + 1;
    }
    if (matches.length >= maximum || scannedCharacters >= MAX_SEARCH_CHARACTERS)
      break;
  }
  return completed(call, {
    matches,
    scannedFiles: sourceIds.length,
    scannedCharacters,
    truncated,
  });
};

export const createReadonlyAIAgentTools = (
  root: string,
  getSnapshot: () => CompilerStateSnapshot,
): ReadonlyAIAgentTools => {
  const readSource = createProjectSourceReader(root, getSnapshot);
  return {
    async execute(call, scope) {
      if (!isAIAgentToolCall(call))
        throw new Error("Invalid AI agent tool call");
      try {
        switch (call.name) {
          case "project.search":
            return searchProject(call, scope, getSnapshot(), readSource);
          case "source.readRanges":
            return readRanges(call, scope, readSource);
          case "source.readFile":
            return readFile(call, scope, readSource);
          default:
            return failed(
              call,
              "AI_AGENT_TOOL_NOT_AVAILABLE",
              "This tool requires a prepared proposal and explicit user approval",
            );
        }
      } catch (error) {
        return failed(
          call,
          "AI_AGENT_TOOL_SCOPE_DENIED",
          error instanceof ProjectSourceReadError ||
            (error instanceof Error &&
              error.message === "Source is outside the approved AI tool scope")
            ? error.message
            : "AI agent tool failed within its approved scope",
        );
      }
    },
  };
};
