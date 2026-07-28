# ElfUI AI DevTools

Development tools for inspecting, locating, profiling, visually annotating, and AI-assisted editing
of ElfUI applications.

## Development usage

Add the Vite plugin after the ElfUI compiler plugin:

```ts
import { defineConfig } from "vite";
import { elfuiMacroPlugin } from "@elfui/vite-plugin";
import { elfuiDevtools } from "@elfui/devtools-vite";

const devtools = elfuiDevtools();

export default defineConfig({
  plugins: [
    elfuiMacroPlugin({
      ...devtools.compiler,
    }),
    devtools,
  ],
});
```

Passing `devtools.compiler` to the ElfUI compiler plugin lets DevTools consume Metadata v2 and
structured diagnostics without compiling a source file twice. Existing compiler options can be
placed alongside the spread.

In development, it injects a bottom-center launcher with separate **ElfUI DevTools** and **Component Inspector** buttons. The panel stays hidden until opened; choose the inspector, then click any element inside an ElfUI component to capture its DOM identity, component ownership, template node, Fragment, and source range. When exact template metadata is unavailable, the snapshot explicitly reports component-level or unresolved precision instead of inventing a source location. The panel also exposes the component tree, props, attributes, setup snapshot, exposed state, lifecycle count, recent timeline events, compiler metadata, diagnostics, and serialized Data Pipeline records. The plugin uses `apply: "serve"`, so it is absent from production builds.

For source locations, the compiler may attach a development-only `__elfSource` field to a component constructor:

```ts
Counter.__elfSource = { file: "/src/Counter.elf", line: 12, column: 1 };
```

DevTools exposes this field in the component snapshot and displays it in the detail panel.

Compatible ElfUI compiler builds additionally attach non-enumerable template metadata through
`Symbol.for("elfui.devtools.template-node")`. It is copied across static-tree clones, includes
Fragment ownership, and is eliminated from production bundles together with the development
branch.

## RPC boundary

Panel data is read through DevTools Protocol v2. Every request carries `protocolVersion` and `requestId`; the initial handshake negotiates component, timeline, pipeline, control, and reactivity capabilities. The current transport is in-page, while the same shared envelopes are intended for optional standalone hosts later.

Protocol definitions live in `@elfui/devtools-shared`; `@elfui/devtools-runtime` exposes the bridge endpoint and in-page transport, and `@elfui/devtools-client` exposes `DevtoolsRpcClient`.

The active implementation plan is
[docs/plan/elfui-ai-devtools.md](docs/plan/elfui-ai-devtools.md). The original
[Vue DevTools comparison plan](docs/plan/elfui-devtools.md) is retained as a record of the
traditional inspection baseline.

This project is intentionally independent of Vue. It will support ElfUI apps directly and may offer optional integration with Vite and Vue DevTools hosts later.
