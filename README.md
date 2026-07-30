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

In development, it injects a bottom-center launcher with separate **ElfUI DevTools**, **Component Inspector**, and **Visual Draft** buttons. The panel stays hidden until opened; choose the inspector (or press `Ctrl/Cmd+Shift+C`), then click any element inside an ElfUI component to capture its DOM identity, component ownership, template node, and source range. Choose Visual Draft (or press `Ctrl/Cmd+Shift+V`) and drag a target to create a Ghost-only move preview: the business DOM and source remain unchanged, while a provider-neutral VisualTarget/VisualIntent is recorded in Data Pipeline. When exact template metadata is unavailable, the snapshot explicitly reports component-level or unresolved precision instead of inventing a source location. The searchable, ARIA component tree supports keyboard navigation, collapse, selection-linked details, HMR selection recovery, and virtualized rendering for large applications. The inspector can traverse open roots and ElfUI's development-only closed-root channel without weakening production encapsulation. Components, Timeline, Compiler, and Data Pipeline have persistent keyboard-accessible navigation; app filtering and system/light/dark themes are available from the header. Component details expose props, attributes, setup snapshot, exposed state, binding activity and source locations, source, compiler diagnostics, and lifecycle state. Timeline, compiler metadata, and serialized Data Pipeline records remain visible in their dedicated views. The plugin uses `apply: "serve"`, so it is absent from production builds.

Rectangle, arrow, and highlight annotations live in a separate overlay layer. **Prepare AI request**
freezes the current targets, intents, annotations, phased screenshot references, page context, source
references, and constraints into an auditable `AIChangeRequest`; this step does not contact a model
or write files. Screenshot bytes stay in an in-memory asset controller while Pipeline records expose
inspectable metadata. Context governance applies explicit source, screenshot, and user-message
budgets; redacts common credential forms before Pipeline serialization; and omits source files that
are outside the selected targets until their source IDs are explicitly approved.

`@elfui/devtools-ai` provides provider-neutral Conversation, Message, Attachment, and stable
reference models for visual targets, intents, annotations, screenshots, source, diagnostics, and
future patch proposals. Its bounded store supports pending, streaming, completed, cancelled, and
failed message state. It also defines the readonly execution event protocol and a deterministic mock
provider without importing a model SDK.
The panel exposes read-only Explain and Plan conversation views with context usage, redactions,
omissions, attachments, and stable references. Compiler source IDs outside the selected visual
targets remain pending until the user explicitly approves them; approval rebuilds the request and
is recorded in Data Pipeline without contacting a provider. An explicit run action then streams the
mock explanation or plan from the Vite Node process, with cancellation, retry, terminal errors, and
every state transition recorded in Data Pipeline.

The Vite development plugin serves approved source context through a capability-scoped POST
endpoint. It accepts only source IDs already present in Compiler State, canonicalizes paths under
the Vite project root, rejects symlink/root escapes and oversized files, and returns at most 200
lines and 12,000 characters per read. The panel requests only selected or explicitly approved
sources, records read diagnostics, and then applies the existing context budget and redaction
rules. For readonly execution, the browser removes all source content from the request; the Node
Gateway independently re-reads only Compiler State source IDs that belong to the selected target or
an explicitly approved scope, reapplies root checks, budgets, and credential redaction, and returns
only audited stream events. The current provider is deterministic and local: there is no API Key,
external model request, implement mode, or file write. The same-page capability token remains
defense in depth rather than a strong isolation boundary for the Preview page.

Visual Draft also supports Ghost-only resizing, anchored comments, bounded Undo, and browser-tab
screenshots. Screenshot capture can use the full viewport or the latest target plus its desired Ghost
geometry; DevTools regions and user-drawn Redact annotations are masked, screen sharing stops
immediately after the frame is read, and raw image bytes never enter Data Pipeline.

Style Preview renders desired CSS in a DevTools-owned overlay clone without writing attributes or
inline styles to the business element. Ghost moves record geometric and semantic relations to nearby
ElfUI targets. Motion Preview records transition properties, trigger, duration, delay, easing, and
reduced-motion behavior as a structured `motion` intent; its marker and timing label stay in a
DevTools-owned overlay and never write `transition` to the business node. Visual drafts survive a
page refresh in session storage; template-node targets are rebound through stable compiler metadata
and their geometry is refreshed for the current viewport.
Component lifecycle and business-DOM replacement events relocate the same stable targets after HMR.
Viewport resize and scroll events also refresh target geometry so overlays stay aligned responsively.
Missing nodes invalidate dependent intents and repair viewport-backed annotations, while navigation
invalidates the route-scoped draft instead of carrying stale visual context to another page. Every
relocation and invalidation remains visible in Data Pipeline.

The deterministic Node mock provider uses a provider-neutral structured summary of VisualTarget,
VisualIntent, annotation, and source references. A 50-case understanding fixture covers style, move
relations, resize, remove/duplicate, motion, annotation, and source identity; every expected target
and intent fact must appear in both the direct summary and streamed Provider output without relying
on user prose, screenshot pixels, or source content.

For source locations, the compiler may attach a development-only `__elfSource` field to a component constructor:

```ts
Counter.__elfSource = { file: "/src/Counter.elf", line: 12, column: 1 };
```

DevTools exposes this field in the component snapshot and displays it in the detail panel.

ElfUI beta.18 uses shared development-only WeakMap registries as the authoritative store for
template-node metadata and closed render roots. The older node/host Symbols remain best-effort
compatibility mirrors, so native DOM objects that reject Symbol descriptors cannot interrupt
rendering or inspection. Static-tree clones retain the same template identity and component
ownership. Production builds are verified not to contain either registry key or compatibility
marker. Optional Fragment fields are read only for beta.15 compatibility; beta.17 removed the
Fragment API and its compiler metadata.

The 5,000-component performance budget and real Chromium P1 flows are executable gates:

```bash
pnpm test:large-tree
pnpm test:browser
```

The Chromium gate covers registry-only closed Shadow Root selection, component/template-node
selection recovery, Visual Draft relocation after HMR replacement, business DOM preservation, and
Inspector hover layout-read coalescing. It also exercises structured motion controls, overlay-only
preview and persistence, exact Node-side repetition of motion/source facts, and style/motion
relocation after HMR.

## RPC boundary

Panel data is read through DevTools Protocol v2. Every request carries `protocolVersion` and `requestId`; the initial handshake negotiates component, timeline, pipeline, control, and reactivity capabilities. The current transport is in-page, while the same shared envelopes are intended for optional standalone hosts later.

Protocol definitions live in `@elfui/devtools-shared`; `@elfui/devtools-runtime` exposes the bridge endpoint and in-page transport, and `@elfui/devtools-client` exposes `DevtoolsRpcClient`.

The active implementation plan is
[docs/plan/elfui-ai-devtools.md](docs/plan/elfui-ai-devtools.md). The original
[Vue DevTools comparison plan](docs/plan/elfui-devtools.md) is retained as a record of the
traditional inspection baseline.

This project is intentionally independent of Vue. It will support ElfUI apps directly and may offer optional integration with Vite and Vue DevTools hosts later.
