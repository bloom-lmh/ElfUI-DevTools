/* global URL, clearTimeout, console, process, setTimeout */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(
  new URL("../fixtures/p1-browser-gate", import.meta.url),
);
const session = `elfui-p1-${process.pid}`;
const cli = process.platform === "win32" ? "npx.cmd" : "npx";
let resolveResult;
let rejectResult;
const gateResult = new Promise((resolve, reject) => {
  resolveResult = resolve;
  rejectResult = reject;
});

const server = await createServer({
  root,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
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
  () => rejectResult(new Error("P1 browser gate timed out after 30 seconds.")),
  30_000,
);

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
  console.log("P1 browser gate passed in real Chromium.");
} finally {
  clearTimeout(timeout);
  await runCli(["close"], true);
  await server.close();
}
