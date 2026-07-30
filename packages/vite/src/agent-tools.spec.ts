// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  type AIAgentToolCall,
} from "@elfui/devtools-ai";
import type { CompilerStateSnapshot } from "@elfui/devtools-shared";
import { describe, expect, it } from "vitest";

import { createReadonlyAIAgentTools } from "./agent-tools";

const call = <T extends AIAgentToolCall>(
  name: T["name"],
  argumentsValue: T["arguments"],
): T =>
  ({
    schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
    id: `call:${name}`,
    executionId: "execution:test",
    name,
    arguments: argumentsValue,
  }) as T;

describe("readonly AI agent tools", () => {
  it("searches and reads only approved Compiler State sources with redaction", async () => {
    const root = await mkdtemp(join(process.cwd(), ".elfui-agent-tools-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "src", "Allowed.ts"),
        'const apiKey = "secret-value";\nexport const target = "needle";\n',
      );
      await writeFile(
        join(root, "src", "Denied.ts"),
        'export const denied = "needle";\n',
      );
      const snapshot: CompilerStateSnapshot = {
        protocolVersion: 2,
        revision: 1,
        artifacts: [
          {
            revision: 1,
            capturedAt: 1,
            id: join(root, "src", "Allowed.ts"),
            sourceId: "src/Allowed.ts",
            kind: "metadata",
            payload: {},
          },
          {
            revision: 1,
            capturedAt: 1,
            id: join(root, "src", "Denied.ts"),
            sourceId: "src/Denied.ts",
            kind: "metadata",
            payload: {},
          },
        ],
      };
      const tools = createReadonlyAIAgentTools(root, () => snapshot);
      const scope = {
        requestId: "request:test",
        allowedSourceIds: ["src/Allowed.ts"],
      };
      const search = await tools.execute(
        call<Extract<AIAgentToolCall, { name: "project.search" }>>(
          "project.search",
          { query: "needle", include: ["src/**/*.ts"] },
        ),
        scope,
      );
      const read = await tools.execute(
        call<Extract<AIAgentToolCall, { name: "source.readFile" }>>(
          "source.readFile",
          { sourceId: "src/Allowed.ts" },
        ),
        scope,
      );

      expect(JSON.stringify(search)).toContain("src/Allowed.ts");
      expect(JSON.stringify(search)).not.toContain("src/Denied.ts");
      expect(JSON.stringify(read)).toContain("[REDACTED]");
      expect(JSON.stringify(read)).not.toContain("secret-value");
      expect(JSON.stringify(read)).toContain('"sha256"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies unapproved reads and keeps write-capable tools unavailable", async () => {
    const root = await mkdtemp(join(process.cwd(), ".elfui-agent-denied-"));
    try {
      await mkdir(join(root, "src"));
      const file = join(root, "src", "Test.ts");
      await writeFile(file, "export const value = 1;\n");
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
      const tools = createReadonlyAIAgentTools(root, () => snapshot);
      const denied = await tools.execute(
        call<Extract<AIAgentToolCall, { name: "source.readRanges" }>>(
          "source.readRanges",
          {
            sourceId: "src/Test.ts",
            ranges: [{ startLine: 1, endLine: 1 }],
          },
        ),
        { requestId: "request:test", allowedSourceIds: [] },
      );
      const write = await tools.execute(
        call<Extract<AIAgentToolCall, { name: "patch.applyApproved" }>>(
          "patch.applyApproved",
          { proposalId: "proposal:test", approvalId: "approval:test" },
        ),
        { requestId: "request:test", allowedSourceIds: ["src/Test.ts"] },
      );

      expect(denied).toMatchObject({
        status: "failed",
        error: { code: "AI_AGENT_TOOL_SCOPE_DENIED" },
      });
      expect(write).toMatchObject({
        status: "failed",
        error: { code: "AI_AGENT_TOOL_NOT_AVAILABLE" },
      });
      expect(await readFile(file, "utf8")).toBe("export const value = 1;\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
