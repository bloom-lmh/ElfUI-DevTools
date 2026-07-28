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

In development, it injects a bottom-center launcher with separate **ElfUI DevTools**, **Component Inspector**, and **Visual Draft** buttons. The panel stays hidden until opened; choose the inspector (or press `Ctrl/Cmd+Shift+C`), then click any element inside an ElfUI component to capture its DOM identity, component ownership, template node, Fragment, and source range. Choose Visual Draft (or press `Ctrl/Cmd+Shift+V`) and drag a target to create a Ghost-only move preview: the business DOM and source remain unchanged, while a provider-neutral VisualTarget/VisualIntent is recorded in Data Pipeline. When exact template metadata is unavailable, the snapshot explicitly reports component-level or unresolved precision instead of inventing a source location. The searchable, ARIA component tree supports keyboard navigation, collapse, selection-linked details, HMR selection recovery, and virtualized rendering for large applications. The inspector can traverse open roots and ElfUI's development-only closed-root channel without weakening production encapsulation. Components, Timeline, Compiler, and Data Pipeline have persistent keyboard-accessible navigation; app filtering and system/light/dark themes are available from the header. Component details expose props, attributes, setup snapshot, exposed state, binding activity and source locations, source, compiler diagnostics, and lifecycle state. Timeline, compiler metadata, and serialized Data Pipeline records remain visible in their dedicated views. The plugin uses `apply: "serve"`, so it is absent from production builds.

Rectangle, arrow, and highlight annotations live in a separate overlay layer. **Prepare AI request**
freezes the current targets, intents, annotations, phased screenshot references, page context, source
references, and constraints into an auditable `AIChangeRequest`; this step does not contact a model
or write files. Screenshot bytes stay in an in-memory asset controller while Pipeline records expose
inspectable metadata.

Visual Draft also supports Ghost-only resizing, anchored comments, bounded Undo, and browser-tab
screenshots. Screenshot capture can use the full viewport or the latest target plus its desired Ghost
geometry; DevTools regions and user-drawn Redact annotations are masked, screen sharing stops
immediately after the frame is read, and raw image bytes never enter Data Pipeline.

For source locations, the compiler may attach a development-only `__elfSource` field to a component constructor:

```ts
Counter.__elfSource = { file: "/src/Counter.elf", line: 12, column: 1 };
```

DevTools exposes this field in the component snapshot and displays it in the detail panel.

ElfUI beta.15 uses shared development-only WeakMap registries as the authoritative store for
template-node metadata and closed render roots. The beta.14 node/host Symbols remain best-effort
compatibility mirrors, so native DOM objects that reject Symbol descriptors cannot interrupt
rendering or inspection. Static-tree clones retain the same template identity and Fragment
ownership. Production builds are verified not to contain either registry key or compatibility
marker.

The 5,000-component performance budget and real Chromium P1 flows are executable gates:

```bash
pnpm test:large-tree
pnpm test:browser
```

The Chromium gate covers registry-only closed Shadow Root selection, component/template-node
selection recovery after HMR replacement, and Inspector hover layout-read coalescing.

## RPC boundary

Panel data is read through DevTools Protocol v2. Every request carries `protocolVersion` and `requestId`; the initial handshake negotiates component, timeline, pipeline, control, and reactivity capabilities. The current transport is in-page, while the same shared envelopes are intended for optional standalone hosts later.

Protocol definitions live in `@elfui/devtools-shared`; `@elfui/devtools-runtime` exposes the bridge endpoint and in-page transport, and `@elfui/devtools-client` exposes `DevtoolsRpcClient`.

The active implementation plan is
[docs/plan/elfui-ai-devtools.md](docs/plan/elfui-ai-devtools.md). The original
[Vue DevTools comparison plan](docs/plan/elfui-devtools.md) is retained as a record of the
traditional inspection baseline.

This project is intentionally independent of Vue. It will support ElfUI apps directly and may offer optional integration with Vite and Vue DevTools hosts later.
