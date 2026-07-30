// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { elfuiMacroPlugin } from "@elfui/vite-plugin";
import { build, type Plugin } from "vite";
import { describe, expect, it, vi } from "vitest";
import {
  DEVTOOLS_COMPILER_STATE_ENDPOINT,
  DEVTOOLS_COMPILER_UPDATE_EVENT,
  DEVTOOLS_OPEN_IN_EDITOR_ENDPOINT,
  DEVTOOLS_SOURCE_READ_ENDPOINT,
  createCompilerArtifactStore,
  createCompilerStateMiddleware,
  createDevtoolsBootstrap,
  createDevtoolsVirtualClient,
  createOpenInEditorMiddleware,
  createSourceReadMiddleware,
  elfuiDevtools,
} from "./index";

const requestMiddleware = (
  middleware: ReturnType<typeof createOpenInEditorMiddleware>,
  url: string,
) => {
  const end = vi.fn();
  const next = vi.fn();
  const response = { statusCode: 200, end } as unknown as ServerResponse;
  middleware({ url } as IncomingMessage, response, next);
  return { end, next, response };
};

const requestSourceMiddleware = async (
  middleware: ReturnType<typeof createSourceReadMiddleware>,
  body: unknown,
  options: { accessToken?: string; method?: string } = {},
) => {
  const request = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  request.url = DEVTOOLS_SOURCE_READ_ENDPOINT;
  request.method = options.method ?? "POST";
  request.headers = {
    "x-elfui-devtools-token": options.accessToken ?? "test-capability",
  };
  const next = vi.fn();
  const setHeader = vi.fn();
  let statusCode = 200;
  let responseBody = "";
  const completed = new Promise<void>((resolveRequest) => {
    const response = {
      get statusCode() {
        return statusCode;
      },
      set statusCode(value: number) {
        statusCode = value;
      },
      setHeader,
      end: (value = "") => {
        responseBody = String(value);
        resolveRequest();
      },
    } as unknown as ServerResponse;
    middleware(request, response, next);
  });
  await completed;
  return { body: responseBody, next, setHeader, statusCode };
};

describe("elfuiDevtools", () => {
  it("injects the development bootstrap but can be disabled", () => {
    const plugin = elfuiDevtools();
    expect(plugin.apply).toBe("serve");
    expect(createDevtoolsBootstrap()).toMatchObject([
      {
        tag: "script",
        attrs: {
          src: "/@id/__x00__virtual:elfui-devtools-client",
        },
        injectTo: "body",
      },
    ]);
    expect(elfuiDevtools({ enabled: false }).transformIndexHtml).toBeDefined();
  });

  it("keeps development registries out of a production Vite build", async () => {
    const root = await mkdtemp(
      join(process.cwd(), ".elfui-devtools-production-"),
    );
    const generatedChunks: string[] = [];
    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "index.html"),
        '<div id="app"></div><script type="module" src="/src/main.ts"></script>',
      );
      await writeFile(
        join(root, "src", "main.ts"),
        `import { defineHtml } from "@elfui/core";

export const ProductionProbe = defineHtml(\`
  <article><button type="button">Save</button></article>
\`);

customElements.define("elf-production-probe", ProductionProbe);
document.querySelector("#app")?.append(document.createElement("elf-production-probe"));
`,
      );
      const devtools = elfuiDevtools();
      const captureOutput: Plugin = {
        name: "capture-production-output",
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle))
            if (output.type === "chunk") generatedChunks.push(output.code);
        },
      };

      await build({
        root,
        logLevel: "silent",
        plugins: [
          elfuiMacroPlugin({
            ...devtools.compiler,
            projectRoot: process.cwd(),
            templateTypeCheck: false,
          }),
          devtools,
          captureOutput,
        ],
        // ElfUI's production contract replaces the development-only global
        // before Rollup tree-shakes compiler/runtime debug branches.
        define: { __DEV__: false },
        build: { write: false },
      });

      const output = generatedChunks.join("\n");
      expect(output).not.toContain("elfui.devtools.template-node-registry");
      expect(output).not.toContain("elfui.devtools.render-root-registry");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("resolves client entries from the plugin package in strict dependency layouts", async () => {
    const plugin = elfuiDevtools();
    const resolveId = plugin.resolveId;
    const resolveVirtualId =
      typeof resolveId === "function" ? resolveId : resolveId?.handler;

    const autoEntry = await resolveVirtualId?.call(
      {} as never,
      "virtual:elfui-devtools-client/auto",
      undefined,
      {} as never,
    );
    const apiEntry = await resolveVirtualId?.call(
      {} as never,
      "virtual:elfui-devtools-client/api",
      undefined,
      {} as never,
    );

    expect(String(autoEntry)).toMatch(/client[\\/]dist[\\/]auto\.js$/);
    expect(String(apiEntry)).toMatch(/client[\\/]dist[\\/]index\.js$/);
  });

  it("captures compiler metadata and diagnostics as revisioned artifacts", () => {
    const store = createCompilerArtifactStore(() => 42);
    const listener = vi.fn();
    store.onArtifact(listener);
    store.compiler.onMetadata(
      {
        schemaVersion: 2,
        sourceId: "src/Card.ts",
        components: [{ name: "Card" }],
      },
      "/project/src/Card.ts",
    );
    store.compiler.onDiagnostics(
      [{ severity: "warning", code: "ELF_TEST", message: "Check this" }],
      "/project/src/Card.ts",
    );

    expect(store.snapshot()).toMatchObject({
      protocolVersion: 2,
      revision: 2,
      artifacts: [
        {
          revision: 1,
          capturedAt: 42,
          kind: "metadata",
          id: "/project/src/Card.ts",
        },
        {
          revision: 2,
          kind: "diagnostics",
          id: "/project/src/Card.ts",
        },
      ],
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("serves compiler state and wires compiler updates into the virtual client", () => {
    const snapshot = {
      protocolVersion: 2 as const,
      revision: 1,
      artifacts: [],
    };
    const middleware = createCompilerStateMiddleware(() => snapshot);
    const end = vi.fn();
    const next = vi.fn();
    const setHeader = vi.fn();
    const response = {
      statusCode: 200,
      end,
      setHeader,
    } as unknown as ServerResponse;
    middleware(
      { url: DEVTOOLS_COMPILER_STATE_ENDPOINT } as IncomingMessage,
      response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith("cache-control", "no-store");
    expect(JSON.parse(String(end.mock.calls[0]?.[0]))).toEqual(snapshot);
    const client = createDevtoolsVirtualClient(
      "source-capability",
      "ai-capability",
    );
    expect(client).toContain("ingestCompilerSnapshot");
    expect(client).toContain("ingestCompilerArtifact");
    expect(client).toContain("createSourceContextReader");
    expect(client).toContain("createAIExecutionClient");
    expect(client).toContain("source-capability");
    expect(client).toContain("ai-capability");
    expect(client).toContain(DEVTOOLS_COMPILER_UPDATE_EVENT);
  });

  it("broadcasts compiler hook updates over Vite HMR", () => {
    const plugin = elfuiDevtools();
    const send = vi.fn();
    const use = vi.fn();
    const server = {
      config: { root: process.cwd() },
      middlewares: { use },
      ws: { send },
    } as never;
    const configureServer = plugin.configureServer;
    const configure =
      typeof configureServer === "function"
        ? configureServer
        : configureServer?.handler;
    configure?.call({} as never, server);
    plugin.compiler.onMetadata(
      { schemaVersion: 2, sourceId: "src/Hmr.ts" },
      "/project/src/Hmr.ts",
    );

    expect(use).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "custom",
        event: DEVTOOLS_COMPILER_UPDATE_EVENT,
        data: expect.objectContaining({
          kind: "metadata",
          id: "/project/src/Hmr.ts",
        }),
      }),
    );
  });

  it("opens an existing source file with its line and column", () => {
    const openInEditor = vi.fn();
    const middleware = createOpenInEditorMiddleware(process.cwd(), {
      openInEditor,
    });
    const query = new URLSearchParams({
      file: "package.json",
      line: "3",
      column: "4",
    });
    const { response, next } = requestMiddleware(
      middleware,
      `${DEVTOOLS_OPEN_IN_EDITOR_ENDPOINT}?${query}`,
    );

    expect(response.statusCode).toBe(204);
    expect(next).not.toHaveBeenCalled();
    expect(openInEditor).toHaveBeenCalledWith(
      resolve(process.cwd(), "package.json"),
      3,
      4,
    );
  });

  it("rejects paths outside the Vite root and ignores other routes", () => {
    const openInEditor = vi.fn();
    const middleware = createOpenInEditorMiddleware(process.cwd(), {
      openInEditor,
    });
    const blocked = requestMiddleware(
      middleware,
      `${DEVTOOLS_OPEN_IN_EDITOR_ENDPOINT}?file=../package.json`,
    );
    const ignored = requestMiddleware(middleware, "/application-route");

    expect(blocked.response.statusCode).toBe(403);
    expect(openInEditor).not.toHaveBeenCalled();
    expect(ignored.next).toHaveBeenCalledOnce();
  });

  it("reads only known source IDs inside the project root and clamps ranges", async () => {
    const root = await mkdtemp(join(process.cwd(), ".elfui-source-read-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "src", "Card.ts"),
        Array.from(
          { length: 260 },
          (_, index) => `export const line${index + 1} = ${index + 1};`,
        ).join("\n"),
      );
      const snapshot = {
        protocolVersion: 2 as const,
        revision: 1,
        artifacts: [
          {
            revision: 1,
            capturedAt: 1,
            id: join(root, "src", "Card.ts"),
            sourceId: "src/Card.ts",
            kind: "metadata" as const,
            payload: {},
          },
        ],
      };
      const middleware = createSourceReadMiddleware(
        root,
        () => snapshot,
        "test-capability",
      );
      const response = await requestSourceMiddleware(middleware, {
        sourceId: "src/Card.ts",
        range: { startLine: 20, endLine: 250 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.next).not.toHaveBeenCalled();
      expect(response.setHeader).toHaveBeenCalledWith(
        "cache-control",
        "no-store",
      );
      const result = JSON.parse(response.body) as {
        sourceId: string;
        range: { startLine: number; endLine: number };
        content: string;
        truncated: boolean;
      };
      expect(result).toMatchObject({
        sourceId: "src/Card.ts",
        range: { startLine: 20, endLine: 219 },
        truncated: true,
      });
      expect(result.content).toContain("line20");
      expect(result.content).not.toContain("line220");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing capabilities, unknown source IDs, and root escapes", async () => {
    const root = await mkdtemp(join(process.cwd(), ".elfui-source-deny-"));
    try {
      await writeFile(join(root, "known.ts"), "export const known = true;");
      const snapshot = {
        protocolVersion: 2 as const,
        revision: 1,
        artifacts: [
          {
            revision: 1,
            capturedAt: 1,
            id: join(root, "known.ts"),
            sourceId: "known.ts",
            kind: "metadata" as const,
            payload: {},
          },
          {
            revision: 2,
            capturedAt: 2,
            id: resolve(root, "..", "outside.ts"),
            sourceId: "../outside.ts",
            kind: "metadata" as const,
            payload: {},
          },
        ],
      };
      const middleware = createSourceReadMiddleware(
        root,
        () => snapshot,
        "test-capability",
      );

      const missingCapability = await requestSourceMiddleware(
        middleware,
        { sourceId: "known.ts" },
        { accessToken: "wrong" },
      );
      const unknownSource = await requestSourceMiddleware(middleware, {
        sourceId: "unknown.ts",
      });
      const escaped = await requestSourceMiddleware(middleware, {
        sourceId: "../outside.ts",
      });

      expect(missingCapability.statusCode).toBe(403);
      expect(unknownSource.statusCode).toBe(403);
      expect(escaped.statusCode).toBe(403);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
