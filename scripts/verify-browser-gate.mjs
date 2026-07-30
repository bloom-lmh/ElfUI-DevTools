/* global URL, clearTimeout, console, process, setTimeout */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";
import { DeterministicMockProvider } from "../packages/ai/dist/index.js";
import { createAIGatewayMiddleware } from "../packages/vite/dist/index.js";

const root = fileURLToPath(
  new URL("../fixtures/p1-browser-gate", import.meta.url),
);
const browserGateSourceFile = fileURLToPath(
  new URL("../fixtures/p1-browser-gate/src/BrowserGate.ts", import.meta.url),
);
const originalBrowserGateSource = await readFile(browserGateSourceFile, "utf8");
const serveMode = process.argv.includes("--serve");
const servePortArgument = process.argv.find((argument) =>
  argument.startsWith("--port="),
);
const servePort = Number(servePortArgument?.slice("--port=".length) ?? 4174);
const session = `elfui-p1-${process.pid}`;
const cli = process.platform === "win32" ? "npx.cmd" : "npx";
let resolveResult;
let rejectResult;
const gateResult = new Promise((resolve, reject) => {
  resolveResult = resolve;
  rejectResult = reject;
});
const deterministicProvider = new DeterministicMockProvider({ delayMs: 2 });
let browserGateVerificationRun = 0;
let browserGateWatcherChanges = 0;
const browserGateProvider = {
  descriptor: {
    ...deterministicProvider.descriptor,
    capabilities: {
      ...deterministicProvider.descriptor.capabilities,
      toolCalling: true,
      structuredOutput: true,
    },
  },
  async *stream(request, options) {
    if (request.mode !== "plan") {
      yield* deterministicProvider.stream(request, options);
      return;
    }
    const approvedPatch = request.agent?.approvedPatches?.[0];
    if (approvedPatch) {
      if (request.agent?.turn === 0)
        yield {
          type: "tool-call",
          call: {
            id: `call:apply:${request.executionId}`,
            name: "patch.applyApproved",
            arguments: JSON.stringify({
              proposalId: approvedPatch.proposalId,
              approvalId: approvedPatch.approvalId,
            }),
          },
        };
      else {
        const result = request.agent.exchanges.at(-1)?.results[0];
        yield {
          type: "text-delta",
          text:
            result?.status === "completed"
              ? `Approved Patch transaction finished with ${String(result.output?.status ?? "unknown")} status.`
              : "Approved Patch transaction failed before verification.",
        };
      }
      yield { type: "completed" };
      return;
    }
    const followUp = request.changeRequest.followUp;
    if (followUp) {
      yield {
        type: "text-delta",
        text:
          `Follow-up plan retained ${followUp.references.length} unresolved visual reference(s): ` +
          `${followUp.references.map((reference) => `${reference.kind}/${reference.id}/${reference.status}`).join(", ")}; ` +
          `resultScreenshotId=${followUp.resultScreenshotId}; ` +
          `file=src/BrowserGate.ts; ` +
          `diagnostic=${request.changeRequest.diagnostics?.[0]?.id ?? "none"}.`,
      };
      yield { type: "completed" };
      return;
    }
    if (request.agent?.turn === 0) {
      yield {
        type: "tool-call",
        call: {
          id: `call:read:${request.executionId}`,
          name: "source.readFile",
          arguments: '{"sourceId":"src/BrowserGate.ts"}',
        },
      };
    } else if (request.agent?.turn === 1) {
      const output = request.agent.exchanges.at(-1)?.results[0]?.output ?? {};
      yield {
        type: "tool-call",
        call: {
          id: `call:prepare:${request.executionId}`,
          name: "patch.prepare",
          arguments: JSON.stringify({
            proposal: {
              schemaVersion: 1,
              id: `proposal:browser-gate:${request.executionId}`,
              requestId: request.changeRequest.id,
              summary: "Update the selected BrowserGate component state.",
              assumptions: [
                "Keep the public component API and motion settings unchanged.",
              ],
              affectedFiles: ["src/BrowserGate.ts"],
              baseFileHashes: { "src/BrowserGate.ts": output.sha256 },
              unifiedDiff:
                "diff --git a/src/BrowserGate.ts b/src/BrowserGate.ts\n--- a/src/BrowserGate.ts\n+++ b/src/BrowserGate.ts\n@@ -1,1 +1,1 @@\n-export const BrowserGateCard = true;\n+export const BrowserGateCard = false;\n",
              validationPlan: [
                {
                  id: "validation:browser-gate:typecheck",
                  kind: "typecheck",
                  required: true,
                  files: ["src/BrowserGate.ts"],
                },
                {
                  id: "validation:browser-gate:browser",
                  kind: "test-scoped",
                  required: true,
                  files: ["src/BrowserGate.ts"],
                },
              ],
              risk: "low",
            },
          }),
        },
      };
    } else {
      yield {
        type: "text-delta",
        text: "Plan and immutable PatchProposal prepared for explicit review.",
      };
    }
    yield { type: "completed" };
  },
};

const server = await createServer({
  root,
  logLevel: "warn",
  server: {
    host: "127.0.0.1",
    port: serveMode ? servePort : 0,
    strictPort: serveMode,
    hmr: false,
  },
  plugins: [
    {
      name: "elfui-devtools-browser-gate-ai",
      configureServer(viteServer) {
        viteServer.watcher.on("change", (file) => {
          if (file === browserGateSourceFile) browserGateWatcherChanges += 1;
        });
        const snapshot = {
          protocolVersion: 2,
          revision: 2,
          artifacts: [
            {
              revision: 1,
              capturedAt: Date.now(),
              id: "src/BrowserGate.ts",
              sourceId: "src/BrowserGate.ts",
              kind: "metadata",
              payload: {},
            },
            {
              revision: 2,
              capturedAt: Date.now(),
              id: "src/Supporting.ts",
              sourceId: "src/Supporting.ts",
              kind: "metadata",
              payload: {},
            },
          ],
        };
        viteServer.middlewares.use(
          createAIGatewayMiddleware(
            root,
            () => snapshot,
            "browser-gate-ai-capability",
            browserGateProvider,
            Date.now,
            {
              adapters: {
                async format() {
                  browserGateVerificationRun += 1;
                  const source = await readFile(browserGateSourceFile, "utf8");
                  return {
                    ok: source.includes("BrowserGateCard = false"),
                    summary: "Fixture formatter preserved the approved source",
                  };
                },
                async typecheck() {
                  if (browserGateVerificationRun > 1)
                    return {
                      ok: false,
                      summary:
                        "Intentional second-run typecheck failure for rollback verification",
                      diagnostics: [
                        {
                          severity: "error",
                          code: "BROWSER_GATE_TYPECHECK",
                          sourceId: "src/BrowserGate.ts",
                          message:
                            "Intentional bounded fixture diagnostic; source must be restored",
                        },
                      ],
                    };
                  const source = await readFile(browserGateSourceFile, "utf8");
                  return {
                    ok: source.includes("BrowserGateCard = false"),
                    summary: "Fixture typecheck passed",
                  };
                },
                async testScoped() {
                  const source = await readFile(browserGateSourceFile, "utf8");
                  return {
                    ok:
                      source.trim() === "export const BrowserGateCard = false;",
                    summary: "Scoped BrowserGate source test passed",
                  };
                },
                async hmr({ signal }) {
                  const deadline = Date.now() + 2_000;
                  while (
                    browserGateWatcherChanges === 0 &&
                    Date.now() < deadline &&
                    !signal.aborted
                  )
                    await new Promise((resolve) => setTimeout(resolve, 20));
                  return {
                    ok: browserGateWatcherChanges > 0,
                    summary:
                      browserGateWatcherChanges > 0
                        ? "Vite watcher observed the approved source update"
                        : "Vite watcher did not observe the source update",
                  };
                },
                async diagnostics() {
                  return {
                    ok: true,
                    summary: "Fixture Runtime/Compiler diagnostics are clean",
                    diagnostics: [],
                  };
                },
              },
            },
          ),
        );
      },
    },
    {
      name: "elfui-devtools-browser-gate-result",
      configureServer(viteServer) {
        viteServer.middlewares.use(
          "/__elfui_devtools_gate_result",
          (request, response) => {
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk) => {
              body += chunk;
            });
            request.on("end", () => {
              try {
                resolveResult(JSON.parse(body));
                response.statusCode = 204;
                response.end();
              } catch (error) {
                rejectResult(error);
                response.statusCode = 400;
                response.end();
              }
            });
          },
        );
      },
    },
  ],
});

const runCli = (args, tolerateFailure = false) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      cli,
      [
        "--yes",
        "--package",
        "@playwright/cli@0.1.17",
        "playwright-cli",
        "--session",
        session,
        ...args,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || tolerateFailure) resolve(output);
      else
        reject(
          new Error(
            `playwright-cli exited with code ${String(code)}\n${output}`,
          ),
        );
    });
  });

const timeout = setTimeout(
  () => rejectResult(new Error("Browser gate timed out after 60 seconds.")),
  60_000,
);

if (serveMode) {
  clearTimeout(timeout);
  await server.listen();
  console.log(
    `ElfUI browser gate demo: ${server.resolvedUrls?.local[0] ?? "http://127.0.0.1:4174/"}`,
  );
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
  if (
    (await readFile(browserGateSourceFile, "utf8")) !==
    originalBrowserGateSource
  )
    await writeFile(browserGateSourceFile, originalBrowserGateSource);
  process.exit(0);
}

try {
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("Vite did not expose a local browser-gate URL.");
  await runCli(["close"], true);
  await runCli(["open", url]);
  const result = await gateResult;
  if (!result?.ok)
    throw new Error(
      `P1 browser gate failed.\n${result?.error ?? JSON.stringify(result)}`,
    );
  for (const check of result.checks ?? [])
    console.log(`✓ ${check.name}: ${check.detail}`);
  console.log("Browser gate passed in real Chromium.");
} finally {
  clearTimeout(timeout);
  await runCli(["close"], true);
  await server.close();
  if (
    (await readFile(browserGateSourceFile, "utf8")) !==
    originalBrowserGateSource
  )
    await writeFile(browserGateSourceFile, originalBrowserGateSource);
}
