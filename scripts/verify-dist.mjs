const entries = [
  "../packages/shared/dist/index.js",
  "../packages/runtime/dist/index.js",
  "../packages/client/dist/index.js",
  "../packages/vite/dist/index.js",
];

for (const entry of entries) {
  await import(new URL(entry, import.meta.url));
}

log("[ElfUI DevTools] ESM distribution imports verified.");
import { log } from "node:console";
import { URL } from "node:url";
