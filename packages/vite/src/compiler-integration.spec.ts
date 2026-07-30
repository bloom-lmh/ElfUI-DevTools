import { resolve } from "node:path";
import { elfuiMacroPlugin } from "@elfui/vite-plugin";
import { describe, expect, it, vi } from "vitest";

import { DEVTOOLS_COMPILER_UPDATE_EVENT, elfuiDevtools } from "./index";

describe("ElfUI beta.18 compiler integration", () => {
  it("captures real Metadata v2 component ownership and diagnostics", () => {
    const devtools = elfuiDevtools();
    const send = vi.fn();
    const server = {
      config: { root: process.cwd() },
      middlewares: { use: vi.fn() },
      ws: { send },
    } as never;
    const configureServer = devtools.configureServer;
    const configure =
      typeof configureServer === "function"
        ? configureServer
        : configureServer?.handler;
    configure?.call({} as never, server);
    const compiler = elfuiMacroPlugin({
      ...devtools.compiler,
      projectRoot: process.cwd(),
      templateTypeCheck: false,
    });
    compiler.configResolved?.({ root: process.cwd() });

    const id = resolve(process.cwd(), "fixtures/MetadataProbe.ts");
    const result = compiler.transform?.(
      `/// <!-- @elf component -->
import { defineHtml } from "@elfui/core";

export const MetadataProbe = defineHtml(\`
  <article>
    <span class="badge">ready</span>
  </article>
\`);
`,
      id,
    );

    expect(result?.code).toContain("MetadataProbe");
    const updates = send.mock.calls.map(
      ([message]) =>
        (
          message as {
            event: string;
            data: { kind: string; payload: unknown };
          }
        ).data,
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.every(
        ([message]) =>
          (message as { event: string }).event ===
          DEVTOOLS_COMPILER_UPDATE_EVENT,
      ),
    ).toBe(true);

    const metadata = updates.find((artifact) => artifact.kind === "metadata")
      ?.payload as {
      schemaVersion: number;
      sourceId: string;
      components: Array<{
        name: string;
        source: { line: number; column: number };
      }>;
    };
    expect(metadata).toMatchObject({
      schemaVersion: 2,
      sourceId: "fixtures/MetadataProbe.ts",
      components: [
        {
          name: "elf-metadata-probe",
          source: { line: expect.any(Number), column: expect.any(Number) },
        },
      ],
    });
    expect(
      updates.find((artifact) => artifact.kind === "diagnostics")?.payload,
    ).toEqual([]);
  });
});
