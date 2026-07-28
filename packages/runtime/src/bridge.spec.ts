import { describe, expect, it, vi } from "vitest";

import {
  createDevtoolsBridge,
  DEVTOOLS_GLOBAL_HOOK,
  installGlobalDevtoolsBridge,
} from "./bridge";

describe("ElfUIDevtoolsBridge", () => {
  it("builds a component tree across an open shadow root", () => {
    const bridge = createDevtoolsBridge({ now: () => 42 });
    const root = document.createElement("elf-root");
    const shadow = root.attachShadow({ mode: "open" });
    const child = document.createElement("elf-child");
    shadow.appendChild(child);
    document.body.appendChild(root);

    const rootId = bridge.registerComponent({
      host: root,
      tag: "elf-root",
      shadowMode: "open",
    });
    const childId = bridge.registerComponent({
      host: child,
      tag: "elf-child",
      props: () => ({ count: 1 }),
    });

    expect(bridge.getSnapshot()).toMatchObject({
      protocolVersion: 2,
      apps: [{ rootIds: [rootId] }],
      components: [
        { id: rootId, parentId: null, children: [childId] },
        { id: childId, parentId: rootId, tag: "elf-child" },
      ],
    });
    expect(bridge.getComponentDetail(childId)?.props).toMatchObject({
      kind: "object",
      entries: [{ key: "count", value: { kind: "primitive", value: 1 } }],
    });
  });

  it("emits bounded lifecycle events and detaches components", () => {
    const now = vi.fn().mockReturnValue(100);
    const bridge = createDevtoolsBridge({ now, maxTimelineEvents: 2 });
    const host = document.createElement("elf-counter");
    const id = bridge.registerComponent({ host, tag: "elf-counter" });

    bridge.notifyUpdate(host);
    bridge.notifyError(host, new Error("boom"));
    bridge.unregisterComponent(host);

    expect(bridge.getComponentDetail(id)).toBeNull();
    expect(bridge.getTimeline()).toHaveLength(2);
    expect(bridge.getTimeline().map((event) => event.type)).toEqual([
      "error",
      "unmount",
    ]);
  });

  it("does not duplicate registration for the same host", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-counter");

    expect(bridge.registerComponent({ host, tag: "elf-counter" })).toBe(
      bridge.registerComponent({ host, tag: "different-tag" }),
    );
    expect(bridge.getSnapshot().components).toHaveLength(1);
  });

  it("installs and restores the global bridge hook", () => {
    const target: Record<string, unknown> = {
      [DEVTOOLS_GLOBAL_HOOK]: "previous",
    };
    const bridge = createDevtoolsBridge();
    const dispose = installGlobalDevtoolsBridge(bridge, target);
    expect(target[DEVTOOLS_GLOBAL_HOOK]).toBe(bridge);
    dispose();
    expect(target[DEVTOOLS_GLOBAL_HOOK]).toBe("previous");
  });

  it("keeps global runtime and reactivity hook methods bound", () => {
    const target: Record<string, unknown> = {};
    const bridge = createDevtoolsBridge();
    const dispose = installGlobalDevtoolsBridge(bridge, target);
    const hook = target[DEVTOOLS_GLOBAL_HOOK] as {
      emitRuntimeEvent: typeof bridge.emitRuntimeEvent;
      emitReactivityEvent: typeof bridge.emitReactivityEvent;
    };
    const host = document.createElement("elf-bound-counter");
    const emitRuntimeEvent = hook.emitRuntimeEvent;
    emitRuntimeEvent({
      type: "component:mount",
      component: {
        id: "elfui-component:bound",
        host,
        tag: "elf-bound-counter",
      },
    });
    const emitReactivityEvent = hook.emitReactivityEvent;
    emitReactivityEvent({
      type: "reactivity:effect",
      triggerId: "elfui-trigger:bound",
      effectId: "elfui-effect:bound",
      componentId: "elfui-component:bound",
      duration: 1,
    });

    expect(bridge.getSnapshot().components).toHaveLength(1);
    expect(bridge.getTimeline().map((event) => event.layer)).toEqual([
      "component",
      "reactivity",
    ]);
    dispose();
  });

  it("consumes real ElfUI runtime app, component, update, and emit events", () => {
    const bridge = createDevtoolsBridge({ now: () => 25 });
    const host = document.createElement("elf-runtime-counter");
    bridge.emitRuntimeEvent({
      type: "app:mount",
      app: { id: "elfui-app:1", label: "elf-app", root: host },
    });
    bridge.emitRuntimeEvent({
      type: "component:mount",
      component: {
        host,
        appId: "elfui-app:1",
        tag: "elf-runtime-counter",
        props: () => ({ count: 2 }),
        setup: () => ({ ready: true }),
      },
    });
    bridge.emitRuntimeEvent({ type: "component:update", host });
    bridge.emitRuntimeEvent({
      type: "component:emit",
      host,
      event: "change",
      args: [3],
    });

    expect(bridge.getSnapshot().apps).toMatchObject([
      { id: "elfui-app:1", rootIds: ["component:1"] },
    ]);
    expect(bridge.getComponentDetail("component:1")?.setup).toMatchObject({
      kind: "object",
      entries: [{ key: "ready", value: { value: true } }],
    });
    expect(bridge.getTimeline().map((event) => event.layer)).toEqual([
      "component",
      "component",
      "events",
    ]);
  });

  it("builds a runtime tree when children mount before their parent", () => {
    const bridge = createDevtoolsBridge();
    const parent = document.createElement("elf-runtime-parent");
    const child = document.createElement("elf-runtime-child");

    bridge.emitRuntimeEvent({
      type: "component:mount",
      component: {
        id: "elfui-component:2",
        parentId: "elfui-component:1",
        appId: "elfui-app:1",
        host: child,
        tag: "elf-runtime-child",
      },
    });
    bridge.emitRuntimeEvent({
      type: "component:mount",
      component: {
        id: "elfui-component:1",
        parentId: null,
        appId: "elfui-app:1",
        host: parent,
        tag: "elf-runtime-parent",
      },
    });

    expect(bridge.getSnapshot()).toMatchObject({
      apps: [{ id: "elfui-app:1", rootIds: ["elfui-component:1"] }],
      components: [
        {
          id: "elfui-component:2",
          parentId: "elfui-component:1",
        },
        {
          id: "elfui-component:1",
          children: ["elfui-component:2"],
        },
      ],
    });

    bridge.emitRuntimeEvent({ type: "component:unmount", host: parent });
    expect(bridge.getSnapshot().components).toEqual([]);
  });

  it("keeps multiple runtime apps isolated during unmount", () => {
    const bridge = createDevtoolsBridge();
    const first = document.createElement("elf-first-app");
    const second = document.createElement("elf-second-app");
    bridge.emitRuntimeEvent({
      type: "app:mount",
      app: { id: "elfui-app:first", label: "first", root: first },
    });
    bridge.emitRuntimeEvent({
      type: "app:mount",
      app: { id: "elfui-app:second", label: "second", root: second },
    });
    bridge.emitRuntimeEvent({
      type: "component:mount",
      component: {
        id: "elfui-component:first",
        parentId: null,
        appId: "elfui-app:first",
        host: first,
        tag: "elf-first-app",
      },
    });
    bridge.emitRuntimeEvent({
      type: "component:mount",
      component: {
        id: "elfui-component:second",
        parentId: null,
        appId: "elfui-app:second",
        host: second,
        tag: "elf-second-app",
      },
    });

    bridge.emitRuntimeEvent({
      type: "app:unmount",
      appId: "elfui-app:first",
    });

    expect(bridge.getSnapshot()).toMatchObject({
      apps: [
        {
          id: "elfui-app:second",
          rootIds: ["elfui-component:second"],
        },
      ],
      components: [{ id: "elfui-component:second" }],
    });
  });

  it("settles Dynamic and Suspense branch replacement to one logical child", () => {
    const bridge = createDevtoolsBridge();
    const parent = document.createElement("elf-branch-parent");
    const dynamicBefore = document.createElement("elf-dynamic-before");
    const dynamicAfter = document.createElement("elf-dynamic-after");
    const fallback = document.createElement("elf-suspense-fallback");
    const resolved = document.createElement("elf-suspense-resolved");
    const mount = (id: string, host: HTMLElement, tag: string): void => {
      bridge.emitRuntimeEvent({
        type: "component:mount",
        component: {
          id,
          parentId: id === "branch:parent" ? null : "branch:parent",
          appId: "branch:app",
          host,
          tag,
        },
      });
    };

    mount("branch:parent", parent, "elf-branch-parent");
    mount("branch:dynamic-before", dynamicBefore, "elf-dynamic-before");
    mount("branch:dynamic-after", dynamicAfter, "elf-dynamic-after");
    bridge.emitRuntimeEvent({ type: "component:unmount", host: dynamicBefore });
    mount("branch:fallback", fallback, "elf-suspense-fallback");
    mount("branch:resolved", resolved, "elf-suspense-resolved");
    bridge.emitRuntimeEvent({ type: "component:unmount", host: fallback });

    expect(bridge.getSnapshot()).toMatchObject({
      apps: [{ id: "branch:app", rootIds: ["branch:parent"] }],
      components: [
        {
          id: "branch:parent",
          children: ["branch:dynamic-after", "branch:resolved"],
        },
        { id: "branch:dynamic-after", parentId: "branch:parent" },
        { id: "branch:resolved", parentId: "branch:parent" },
      ],
    });

    bridge.emitRuntimeEvent({ type: "component:unmount", host: parent });
    expect(bridge.getSnapshot().components).toEqual([]);
  });

  it("adds state trigger and effect causality to the reactivity timeline", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-reactivity-counter");
    bridge.registerComponent({
      id: "elfui-component:counter",
      appId: "elfui-app:counter",
      parentId: null,
      host,
      tag: "elf-reactivity-counter",
      source: { file: "/src/Counter.elf", line: 10, column: 5 },
    });

    bridge.emitReactivityEvent({
      type: "reactivity:trigger",
      id: "elfui-trigger:1",
      parentTriggerId: null,
      targetId: "elfui-target:1",
      targetName: "count",
      key: "value",
      effects: [
        {
          effectId: "elfui-effect:1",
          componentId: "elfui-component:counter",
          debug: {
            kind: "binding",
            name: "text",
            source: { line: 4, column: 8 },
          },
        },
      ],
    });
    bridge.emitReactivityEvent({
      type: "reactivity:effect",
      triggerId: "elfui-trigger:1",
      effectId: "elfui-effect:1",
      componentId: "elfui-component:counter",
      debug: {
        kind: "binding",
        name: "text",
        source: { line: 4, column: 8 },
      },
      duration: 1.25,
    });
    bridge.ingestCompilerArtifact({
      revision: 1,
      capturedAt: 30,
      id: "diagnostics:counter",
      sourceId: "src/Counter.elf",
      kind: "diagnostics",
      payload: [
        {
          severity: "warning",
          code: "ELF_BINDING_READONLY",
          message: "Binding cannot be assigned.",
          hint: "Use a writable signal.",
          component: "elf-reactivity-counter",
          fragment: "content",
          file: "/src/Counter.elf",
          line: 13,
          column: 8,
        },
        {
          severity: "error",
          code: "ELF_OTHER_COMPONENT",
          message: "Belongs to another component.",
          component: "elf-other",
          line: 1,
          column: 1,
        },
      ],
    });

    expect(bridge.getTimeline().slice(-2)).toMatchObject([
      {
        layer: "reactivity",
        type: "trigger",
        summary:
          "count.value → text triggered 1 effect @ /src/Counter.elf:13:8",
      },
      {
        layer: "reactivity",
        type: "effect",
        summary: "text ran in 1.25ms @ /src/Counter.elf:13:8",
      },
    ]);
    expect(bridge.getComponentDetail("elfui-component:counter")).toMatchObject({
      bindings: [
        {
          effectId: "elfui-effect:1",
          kind: "binding",
          name: "text",
          source: { file: "/src/Counter.elf", line: 13, column: 8 },
          triggerCount: 1,
          runCount: 1,
          lastDuration: 1.25,
        },
      ],
      diagnostics: [
        {
          severity: "warning",
          code: "ELF_BINDING_READONLY",
          message: "Binding cannot be assigned.",
          hint: "Use a writable signal.",
          fragment: "content",
          source: { file: "/src/Counter.elf", line: 13, column: 8 },
        },
      ],
    });
  });

  it("pauses, rate limits, clears, and aggregates timeline events", () => {
    let now = 100;
    const bridge = createDevtoolsBridge({
      now: () => now,
      maxTimelineEventsPerWindow: 2,
      timelineWindowMs: 1000,
      aggregateWindowMs: 16,
    });
    const host = document.createElement("elf-busy-counter");
    bridge.registerComponent({
      id: "elfui-component:busy",
      appId: "elfui-app:busy",
      parentId: null,
      host,
      tag: "elf-busy-counter",
    });
    bridge.clearTimeline();

    bridge.setTimelinePaused(true);
    bridge.notifyUpdate(host);
    expect(bridge.getTimelineStatus()).toMatchObject({
      paused: true,
      droppedEvents: 1,
    });

    bridge.setTimelinePaused(false);
    bridge.clearTimeline();
    bridge.notifyUpdate(host);
    bridge.notifyUpdate(host);
    bridge.notifyUpdate(host);
    expect(bridge.getTimeline()).toHaveLength(2);
    expect(bridge.getTimelineStatus().droppedEvents).toBe(1);

    now += 1000;
    bridge.clearTimeline();
    const trigger = {
      type: "reactivity:trigger" as const,
      id: "elfui-trigger:busy",
      parentTriggerId: null,
      targetId: "elfui-target:busy",
      targetName: "count",
      key: "value",
      effects: [
        {
          effectId: "elfui-effect:busy",
          componentId: "elfui-component:busy",
          debug: { kind: "binding", name: "text" },
        },
      ],
    };
    bridge.emitReactivityEvent(trigger);
    now += 1;
    bridge.emitReactivityEvent({ ...trigger, id: "elfui-trigger:busy-2" });
    expect(bridge.getTimeline()).toHaveLength(1);
    expect(bridge.getTimeline()[0]?.summary).toContain("×2");
    expect(bridge.getTimelineStatus().aggregatedEvents).toBe(1);
  });

  it("returns structured RPC errors for incompatible or invalid requests", () => {
    const bridge = createDevtoolsBridge();
    const incompatible = bridge.handleRpcRequest({
      protocolVersion: 99,
      requestId: "old-client:1",
      method: "app.snapshot",
      params: {},
    });
    expect(incompatible).toMatchObject({
      protocolVersion: 2,
      requestId: "old-client:1",
      ok: false,
      error: {
        code: "PROTOCOL_MISMATCH",
        data: { received: 99, supported: 2 },
      },
    });

    const invalid = bridge.handleRpcRequest({
      protocolVersion: 2,
      requestId: "client:2",
      method: "timeline.setPaused",
      params: { paused: "yes" },
    } as never);
    expect(invalid).toMatchObject({
      requestId: "client:2",
      ok: false,
      error: { code: "INVALID_PARAMS" },
    });
  });

  it("records a bounded, serializable data pipeline", () => {
    const bridge = createDevtoolsBridge({
      now: () => 73,
      maxPipelineRecords: 2,
    });
    const host = document.createElement("elf-pipeline");
    bridge.registerComponent({ host, tag: "elf-pipeline" });
    bridge.notifyUpdate(host);
    const record = bridge.recordPipeline({
      taskId: "task:style",
      stage: "visual-intent",
      source: "visual-tools",
      kind: "style.preview",
      summary: "Previewed a wider card",
      payload: { width: 320, unit: "px" },
    });

    expect(record).toMatchObject({
      taskId: "task:style",
      stage: "visual-intent",
      schemaVersion: 1,
      source: "visual-tools",
      kind: "style.preview",
      payload: {
        kind: "object",
        entries: expect.arrayContaining([
          { key: "width", value: { kind: "primitive", value: 320 } },
        ]),
      },
    });
    expect(bridge.getPipelineState()).toMatchObject({
      droppedRecords: 1,
      records: [
        { stage: "observation", kind: "component.update" },
        { id: record.id, stage: "visual-intent" },
      ],
    });
    expect(bridge.clearPipeline()).toEqual({
      droppedRecords: 0,
      records: [],
    });
  });
});
