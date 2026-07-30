import { afterEach, describe, expect, it } from "vitest";
import {
  DEVTOOLS_GLOBAL_HOOK,
  type ElfUIDevtoolsBridge,
} from "@elfui/devtools-runtime";
import type { CompilerStateSnapshot } from "@elfui/devtools-shared";

import {
  ingestCompilerArtifact,
  ingestCompilerSnapshot,
  installElfUIDevtools,
} from "./bootstrap";

describe("compiler artifact ingestion", () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
    document.body.replaceChildren();
  });

  it("writes metadata and diagnostics into the observable data pipeline", () => {
    dispose = installElfUIDevtools();
    const bridge = (globalThis as Record<string, unknown>)[
      DEVTOOLS_GLOBAL_HOOK
    ] as ElfUIDevtoolsBridge;
    ingestCompilerSnapshot({
      protocolVersion: 2,
      revision: 2,
      artifacts: [
        {
          revision: 1,
          capturedAt: 10,
          id: "/project/src/Card.ts",
          sourceId: "src/Card.ts",
          kind: "metadata",
          payload: {
            schemaVersion: 2,
            sourceId: "src/Card.ts",
            components: [
              {
                name: "Card",
                source: {
                  start: 20,
                  end: 120,
                  line: 2,
                  column: 1,
                  endLine: 6,
                  endColumn: 2,
                },
              },
            ],
            diagnostics: {
              errors: 0,
              warnings: 1,
              codes: ["ELF_TEMPLATE_TEST"],
            },
          },
        },
        {
          revision: 2,
          capturedAt: 11,
          id: "/project/src/Card.ts",
          sourceId: "src/Card.ts",
          kind: "diagnostics",
          payload: [
            {
              severity: "warning",
              code: "ELF_TEMPLATE_TEST",
              message: "Template warning",
            },
          ],
        },
      ],
    });

    const records = bridge.getPipelineState().records;
    expect(records).toMatchObject([
      {
        stage: "observation",
        source: "compiler",
        kind: "compiler.metadata",
        summary: "src/Card.ts: 1 component",
      },
      {
        parentId: records[0]?.id,
        source: "compiler",
        kind: "compiler.diagnostics",
        diagnostics: [
          {
            severity: "warning",
            code: "ELF_TEMPLATE_TEST",
            message: "Template warning",
          },
        ],
      },
    ]);
    expect(JSON.stringify(records[0]?.payload)).toContain('"Card"');
    expect(JSON.stringify(records[0]?.payload)).toContain('"source"');

    ingestCompilerArtifact({
      revision: 3,
      capturedAt: 12,
      id: "/project/src/Card.ts",
      sourceId: "src/Card.ts",
      kind: "diagnostics",
      payload: [],
    });
    expect(
      bridge
        .getCompilerState()
        .artifacts.find((artifact) => artifact.kind === "diagnostics")?.payload,
    ).toEqual([]);
    expect(bridge.getPipelineState().records).toHaveLength(3);
  });

  it("queues early artifacts and ignores stale or incompatible revisions", () => {
    ingestCompilerArtifact({
      revision: 1,
      capturedAt: 10,
      id: "/project/src/Early.ts",
      sourceId: "src/Early.ts",
      kind: "metadata",
      payload: { schemaVersion: 2, sourceId: "src/Early.ts" },
    });
    dispose = installElfUIDevtools();
    const bridge = (globalThis as Record<string, unknown>)[
      DEVTOOLS_GLOBAL_HOOK
    ] as ElfUIDevtoolsBridge;
    ingestCompilerArtifact({
      revision: 1,
      capturedAt: 11,
      id: "/project/src/Early.ts",
      sourceId: "src/Early.ts",
      kind: "metadata",
      payload: { sourceId: "stale" },
    });
    ingestCompilerSnapshot({
      protocolVersion: 1,
      revision: 2,
      artifacts: [],
    } as unknown as CompilerStateSnapshot);

    expect(bridge.getPipelineState().records).toHaveLength(1);
    expect(bridge.getPipelineState().records[0]?.summary).toContain(
      "src/Early.ts",
    );
  });

  it("keeps older snapshot artifacts for other files when HMR wins the race", () => {
    dispose = installElfUIDevtools();
    const bridge = (globalThis as Record<string, unknown>)[
      DEVTOOLS_GLOBAL_HOOK
    ] as ElfUIDevtoolsBridge;
    ingestCompilerArtifact({
      revision: 5,
      capturedAt: 15,
      id: "/project/src/New.ts",
      sourceId: "src/New.ts",
      kind: "metadata",
      payload: { schemaVersion: 2, sourceId: "src/New.ts" },
    });
    ingestCompilerSnapshot({
      protocolVersion: 2,
      revision: 5,
      artifacts: [
        {
          revision: 1,
          capturedAt: 10,
          id: "/project/src/Existing.ts",
          sourceId: "src/Existing.ts",
          kind: "metadata",
          payload: { schemaVersion: 2, sourceId: "src/Existing.ts" },
        },
        {
          revision: 5,
          capturedAt: 15,
          id: "/project/src/New.ts",
          sourceId: "src/New.ts",
          kind: "metadata",
          payload: { schemaVersion: 2, sourceId: "src/New.ts" },
        },
      ],
    });

    expect(
      bridge
        .getPipelineState()
        .records.map((record) => record.summary)
        .join("\n"),
    ).toContain("src/Existing.ts");
    expect(bridge.getPipelineState().records).toHaveLength(2);
  });
});
