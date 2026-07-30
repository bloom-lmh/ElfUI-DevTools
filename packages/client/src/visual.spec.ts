import { describe, expect, it, vi } from "vitest";

import { createDevtoolsBridge } from "@elfui/devtools-runtime";
import type { VisualDraft, VisualTarget } from "@elfui/devtools-visual-intent";

import {
  DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY,
  inferVisualRelations,
  VisualIntentSession,
  VisualToolsController,
} from "./visual";

const target: VisualTarget = {
  id: "visual-target:button",
  runtimeNodeId: "component:button",
  componentId: "component:card",
  inspector: {
    componentId: "component:card",
    domPath: "elf-card > button",
    element: { tag: "button", classes: [] },
    sourcePrecision: "template-node",
  },
  geometry: { x: 10, y: 20, width: 120, height: 40 },
};

describe("VisualIntentSession", () => {
  it("captures targets and records fake moves in the Data Pipeline", () => {
    const bridge = createDevtoolsBridge({ now: () => 100 });
    const session = new VisualIntentSession(bridge, {
      draftId: "visual-draft:test",
      now: () => 100,
    });
    session.captureTarget(target);
    session.previewMove("visual-target:button", {
      x: 15,
      y: 20,
      width: 120,
      height: 40,
    });

    expect(session.getDraft()).toMatchObject({
      id: "visual-draft:test",
      targets: [{ id: target.id, geometry: target.geometry }],
      intents: [
        {
          type: "move",
          targetId: target.id,
          before: target.geometry,
          desired: { x: 15, y: 20, width: 120, height: 40 },
        },
      ],
    });
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toEqual(["visual.target.capture", "visual.move.preview"]);
  });

  it("rejects annotations that are not anchored to captured targets", () => {
    const bridge = createDevtoolsBridge();
    const session = new VisualIntentSession(bridge, {
      draftId: "visual-draft:test",
    });
    expect(() =>
      session.addAnnotation({
        id: "annotation:missing",
        type: "comment",
        targetIds: ["visual-target:missing"],
        text: "Missing target",
        createdAt: 1,
      }),
    ).toThrow('Unknown visual target "visual-target:missing"');
  });

  it("records a resize intent independently from the target geometry", () => {
    const bridge = createDevtoolsBridge({ now: () => 110 });
    const session = new VisualIntentSession(bridge, {
      draftId: "visual-draft:resize",
    });
    session.captureTarget(target);
    const resized = session.previewResize(target.id, {
      ...target.geometry,
      width: 145,
      height: 52,
    });

    expect(resized).toMatchObject({
      type: "resize",
      before: { width: 120, height: 40 },
      desired: { width: 145, height: 52 },
    });
    expect(target.geometry).toEqual({
      x: 10,
      y: 20,
      width: 120,
      height: 40,
    });
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toEqual(["visual.target.capture", "visual.resize.preview"]);
  });

  it("records cumulative style preview properties", () => {
    const bridge = createDevtoolsBridge({ now: () => 115 });
    const session = new VisualIntentSession(bridge, {
      draftId: "visual-draft:style",
    });
    session.captureTarget({
      ...target,
      computedStyle: {
        "background-color": "rgb(255, 255, 255)",
        color: "rgb(0, 0, 0)",
      },
    });
    session.previewStyle(target.id, "background-color", "rgb(15, 118, 110)");
    session.previewStyle(target.id, "color", "rgb(255, 255, 255)");

    expect(session.getDraft().intents).toEqual([
      expect.objectContaining({
        type: "style",
        targetId: target.id,
        before: {
          "background-color": "rgb(255, 255, 255)",
          color: "rgb(0, 0, 0)",
        },
        desired: {
          "background-color": "rgb(15, 118, 110)",
          color: "rgb(255, 255, 255)",
        },
      }),
    ]);
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toEqual([
      "visual.target.capture",
      "visual.style.preview",
      "visual.style.preview",
    ]);
  });

  it("records validated motion transitions and supports undo", () => {
    const bridge = createDevtoolsBridge({ now: () => 118 });
    const session = new VisualIntentSession(bridge, {
      draftId: "visual-draft:motion",
    });
    session.captureTarget(target);
    expect(() =>
      session.previewMotion(target.id, {
        kind: "transition",
        trigger: "hover",
        properties: [],
        durationMs: 240,
        delayMs: 0,
        easing: "ease-out",
        respectReducedMotion: true,
      }),
    ).toThrow("valid CSS properties");

    const motion = session.previewMotion(target.id, {
      kind: "transition",
      trigger: "hover",
      properties: [" opacity ", "transform", "opacity"],
      durationMs: 320.4,
      delayMs: 40.2,
      easing: " cubic-bezier(0.2, 0, 0, 1) ",
      respectReducedMotion: true,
    });
    expect(motion).toMatchObject({
      type: "motion",
      targetId: target.id,
      desired: {
        trigger: "hover",
        properties: ["opacity", "transform"],
        durationMs: 320,
        delayMs: 40,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
        respectReducedMotion: true,
      },
    });
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toEqual(["visual.target.capture", "visual.motion.preview"]);

    session.undo();
    expect(session.getDraft().intents).toEqual([]);
  });

  it("undoes bounded draft changes and restores a serialized session", () => {
    const bridge = createDevtoolsBridge();
    const session = new VisualIntentSession(bridge, {
      draftId: "visual-draft:history",
      historyLimit: 2,
    });
    session.captureTarget(target);
    session.previewMove(target.id, {
      ...target.geometry,
      x: 15,
    });
    session.addAnnotation({
      id: "annotation:history",
      type: "comment",
      targetIds: [target.id],
      text: "Keep this note",
      createdAt: 10,
    });
    expect(session.canUndo).toBe(true);

    session.undo();
    expect(session.getDraft().annotations).toEqual([]);
    session.undo();
    expect(session.getDraft().intents).toEqual([]);
    expect(session.undo()).toBeNull();

    const restored = {
      ...session.getDraft(),
      id: "visual-draft:restored",
      annotations: [
        {
          id: "annotation:restored",
          type: "comment" as const,
          targetIds: [target.id],
          text: "Recovered",
          createdAt: 20,
        },
      ],
      screenshotIds: ["screenshot:restored"],
    };
    session.restore(restored);
    restored.annotations[0]!.text = "Mutated outside";
    expect(session.getDraft()).toMatchObject({
      id: "visual-draft:restored",
      annotations: [{ text: "Recovered" }],
      screenshotIds: ["screenshot:restored"],
    });
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toContain("visual.draft.restore");
  });

  it("invalidates missing targets and repairs their dependent draft data", () => {
    const bridge = createDevtoolsBridge();
    const session = new VisualIntentSession(bridge, {
      draftId: "visual-draft:invalidate",
    });
    session.captureTarget(target);
    session.previewMove(target.id, { ...target.geometry, x: 30 });
    session.addAnnotation({
      id: "annotation:anchored",
      type: "comment",
      targetIds: [target.id],
      text: "Keep at the viewport point",
      from: { x: 15, y: 25 },
      createdAt: 1,
    });
    session.addAnnotation({
      id: "annotation:anchor-only",
      type: "comment",
      targetIds: [target.id],
      text: "Remove with the anchor",
      createdAt: 2,
    });

    session.invalidateTargets([target.id], "node-disappeared");

    expect(session.getDraft()).toMatchObject({
      targets: [],
      intents: [],
      annotations: [
        {
          id: "annotation:anchored",
          targetIds: [],
          from: { x: 15, y: 25 },
        },
      ],
    });
    expect(session.canUndo).toBe(false);
    expect(bridge.getPipelineState().records.at(-1)).toMatchObject({
      kind: "visual.target.invalidate",
      summary: `Invalidated visual target ${target.id}`,
    });
  });

  it("moves a ghost preview while leaving the business element unchanged", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-card");
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    shadow.append(button);
    document.body.append(host);
    bridge.registerComponent({
      id: "component:card",
      host,
      tag: "elf-card",
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 20,
      width: 120,
      height: 40,
    } as DOMRect);
    const before = button.outerHTML;
    const controller = new VisualToolsController(bridge, { document });
    controller.enable();

    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 15,
        clientY: 25,
      }),
    );
    button.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 20,
        clientY: 35,
      }),
    );
    button.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 20,
        clientY: 35,
      }),
    );

    expect(button.outerHTML).toBe(before);
    expect(controller.getDraft().intents).toMatchObject([
      {
        type: "move",
        before: { x: 10, y: 20, width: 120, height: 40 },
        desired: { x: 15, y: 30, width: 120, height: 40 },
      },
    ]);
    expect(
      document
        .querySelector("[data-elfui-devtools=visual-ghost]")
        ?.getAttribute("style"),
    ).toContain("left: 15px");
    controller.dispose();
  });

  it("previews styles in an overlay and restores the draft from storage", async () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-style-card");
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "Publish";
    button.style.cssText = "background-color:white;color:black";
    shadow.append(button);
    document.body.append(host);
    const templateNodes = new WeakMap<Node, object>([
      [
        button,
        {
          sourceId: "src/StyleCard.ts",
          templateNodeId: "src/StyleCard.ts:component:button:4:3",
          source: { file: "src/StyleCard.ts", line: 4, column: 3 },
        },
      ],
    ]);
    Object.defineProperty(
      globalThis,
      Symbol.for("elfui.devtools.template-node-registry"),
      { value: templateNodes, configurable: true },
    );
    bridge.registerComponent({
      id: "component:style-card",
      host,
      tag: "elf-style-card",
    });
    const bounds = vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 24,
      y: 36,
      width: 112,
      height: 40,
    } as DOMRect);
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        values.set(key, value);
      },
      removeItem: (key: string): void => {
        values.delete(key);
      },
    };
    const before = button.outerHTML;
    const controller = new VisualToolsController(bridge, {
      document,
      storage,
    });
    controller.setTool("style");
    controller.enable();
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 30,
        clientY: 42,
      }),
    );
    controller.setStyleProperty("background-color");
    controller.setStyleValue("rgb(15, 118, 110)");
    controller.previewSelectedStyle();

    expect(button.outerHTML).toBe(before);
    expect(
      document
        .querySelector<HTMLElement>(
          "[data-elfui-devtools=visual-style-preview]",
        )
        ?.style.getPropertyValue("background-color"),
    ).toBe("rgb(15, 118, 110)");
    expect(controller.getDraft().intents).toMatchObject([
      {
        type: "style",
        desired: { "background-color": "rgb(15, 118, 110)" },
      },
    ]);
    expect(values.get(DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY)).toContain(
      "background-color",
    );
    expect(
      JSON.parse(values.get(DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY) ?? "{}"),
    ).toMatchObject({
      route: `${location.pathname}${location.search}${location.hash}`,
      draft: {
        intents: [
          {
            type: "style",
            desired: { "background-color": "rgb(15, 118, 110)" },
          },
        ],
      },
    });
    controller.dispose();

    bounds.mockReturnValue({
      x: 12,
      y: 180,
      width: 180,
      height: 44,
    } as DOMRect);
    const restored = new VisualToolsController(bridge, {
      document,
      storage,
    });
    expect(restored.getDraft().intents).toMatchObject([
      {
        type: "style",
        desired: { "background-color": "rgb(15, 118, 110)" },
      },
    ]);
    expect(restored.selectedTool).toBe("style");
    expect(restored.selectedStyleTargetId).toContain(
      "src/StyleCard.ts:component:button:4:3",
    );
    expect(restored.getDraft().targets[0]?.geometry).toEqual({
      x: 12,
      y: 180,
      width: 180,
      height: 44,
    });
    expect(
      document
        .querySelector<HTMLElement>(
          "[data-elfui-devtools=visual-style-preview]",
        )
        ?.style.getPropertyValue("background-color"),
    ).toBe("rgb(15, 118, 110)");

    bounds.mockReturnValue({
      x: 8,
      y: 240,
      width: 200,
      height: 48,
    } as DOMRect);
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(restored.getDraft().targets[0]?.geometry).toEqual({
      x: 8,
      y: 240,
      width: 200,
      height: 48,
    });
    expect(
      document
        .querySelector<HTMLElement>(
          "[data-elfui-devtools=visual-style-preview]",
        )
        ?.style.getPropertyValue("top"),
    ).toBe("240px");

    restored.clear();
    expect(values.has(DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY)).toBe(false);
    restored.dispose();
    delete (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("elfui.devtools.template-node-registry")
    ];
  });

  it("previews motion in an overlay and restores structured timing", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-motion-card");
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "Open menu";
    shadow.append(button);
    document.body.append(host);
    const templateNodes = new WeakMap<Node, object>([
      [
        button,
        {
          sourceId: "src/MotionCard.ts",
          templateNodeId: "src/MotionCard.ts:component:button:5:3",
          source: { file: "src/MotionCard.ts", line: 5, column: 3 },
        },
      ],
    ]);
    Object.defineProperty(
      globalThis,
      Symbol.for("elfui.devtools.template-node-registry"),
      { value: templateNodes, configurable: true },
    );
    bridge.registerComponent({
      id: "component:motion-card",
      host,
      tag: "elf-motion-card",
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 30,
      y: 60,
      width: 124,
      height: 38,
    } as DOMRect);
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        values.set(key, value);
      },
      removeItem: (key: string): void => {
        values.delete(key);
      },
    };
    const before = button.outerHTML;
    const controller = new VisualToolsController(bridge, {
      document,
      storage,
    });
    controller.setTool("motion");
    controller.enable();
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 36,
        clientY: 68,
      }),
    );
    controller.setMotionProperties("opacity, transform");
    controller.setMotionTrigger("hover");
    controller.setMotionDurationMs(320);
    controller.setMotionDelayMs(40);
    controller.setMotionEasing("cubic-bezier(0.2, 0, 0, 1)");
    controller.setMotionRespectReducedMotion(false);
    controller.previewSelectedMotion();

    expect(button.outerHTML).toBe(before);
    expect(
      document.querySelector<HTMLElement>(
        "[data-elfui-devtools=visual-motion-preview]",
      )?.textContent,
    ).toBe(
      "opacity, transform · hover · 320ms + 40ms · cubic-bezier(0.2, 0, 0, 1) · always-motion",
    );
    expect(controller.getDraft().intents).toMatchObject([
      {
        type: "motion",
        desired: {
          properties: ["opacity", "transform"],
          trigger: "hover",
          durationMs: 320,
          delayMs: 40,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
          respectReducedMotion: false,
        },
      },
    ]);
    expect(values.get(DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY)).toContain(
      '"type":"motion"',
    );
    controller.dispose();

    const restored = new VisualToolsController(bridge, {
      document,
      storage,
    });
    expect(restored.selectedTool).toBe("motion");
    expect(restored.selectedMotionTargetId).toContain(
      "src/MotionCard.ts:component:button:5:3",
    );
    expect(restored.selectedMotionProperties).toBe("opacity, transform");
    expect(restored.selectedMotionDurationMs).toBe(320);
    expect(restored.selectedMotionDelayMs).toBe(40);
    expect(restored.selectedMotionEasing).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(restored.selectedMotionRespectReducedMotion).toBe(false);
    expect(
      document.querySelector("[data-elfui-devtools=visual-motion-preview]"),
    ).not.toBeNull();

    restored.clear();
    expect(values.has(DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY)).toBe(false);
    restored.dispose();
    delete (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("elfui.devtools.template-node-registry")
    ];
  });

  it("rebinds a visual target after an HMR component replacement", async () => {
    const bridge = createDevtoolsBridge();
    const templateNodeId = "src/HmrCard.ts:component:button:4:3";
    const templateNodes = new WeakMap<Node, object>();
    Object.defineProperty(
      globalThis,
      Symbol.for("elfui.devtools.template-node-registry"),
      { value: templateNodes, configurable: true },
    );
    const firstHost = document.createElement("elf-hmr-card");
    const firstRoot = firstHost.attachShadow({ mode: "open" });
    const firstButton = document.createElement("button");
    firstButton.textContent = "Before HMR";
    firstRoot.append(firstButton);
    document.body.append(firstHost);
    templateNodes.set(firstButton, {
      sourceId: "src/HmrCard.ts",
      templateNodeId,
      source: { file: "src/HmrCard.ts", line: 4, column: 3 },
    });
    bridge.registerComponent({
      id: "component:hmr-before",
      host: firstHost,
      tag: "elf-hmr-card",
    });
    vi.spyOn(firstButton, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 30,
      width: 100,
      height: 36,
    } as DOMRect);
    const controller = new VisualToolsController(bridge, {
      document,
      reconcileDelay: 0,
    });
    controller.setTool("style");
    controller.enable();
    firstButton.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 30,
        clientY: 40,
      }),
    );
    controller.setStyleProperty("color");
    controller.setStyleValue("rgb(15, 118, 110)");
    controller.previewSelectedStyle();
    controller.setTool("motion");
    firstButton.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 30,
        clientY: 40,
      }),
    );
    controller.setMotionTrigger("enter");
    controller.setMotionDurationMs(180);
    controller.previewSelectedMotion();
    const targetId = controller.getDraft().targets[0]!.id;

    bridge.unregisterComponent(firstHost);
    firstHost.remove();
    const nextHost = document.createElement("elf-hmr-card");
    const nextRoot = nextHost.attachShadow({ mode: "open" });
    const nextButton = document.createElement("button");
    nextButton.textContent = "After HMR";
    nextRoot.append(nextButton);
    document.body.append(nextHost);
    templateNodes.set(nextButton, {
      sourceId: "src/HmrCard.ts",
      templateNodeId,
      source: { file: "src/HmrCard.ts", line: 4, column: 3 },
    });
    vi.spyOn(nextButton, "getBoundingClientRect").mockReturnValue({
      x: 48,
      y: 160,
      width: 180,
      height: 44,
    } as DOMRect);
    bridge.registerComponent({
      id: "component:hmr-after",
      host: nextHost,
      tag: "elf-hmr-card",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(controller.getDraft().targets).toMatchObject([
      {
        id: targetId,
        componentId: "component:hmr-after",
        geometry: { x: 48, y: 160, width: 180, height: 44 },
        inspector: { templateNodeId },
      },
    ]);
    expect(controller.getDraft().intents).toMatchObject([
      { type: "style", targetId },
      { type: "motion", targetId, desired: { trigger: "enter" } },
    ]);
    expect(
      document
        .querySelector<HTMLElement>(
          "[data-elfui-devtools=visual-style-preview]",
        )
        ?.style.getPropertyValue("left"),
    ).toBe("48px");
    expect(
      document
        .querySelector<HTMLElement>(
          "[data-elfui-devtools=visual-motion-preview]",
        )
        ?.style.getPropertyValue("left"),
    ).toBe("48px");
    expect(
      bridge
        .getPipelineState()
        .records.some(
          (record) =>
            record.kind === "visual.target.rebind" &&
            record.summary === `Rebound visual target ${targetId}`,
        ),
    ).toBe(true);

    controller.dispose();
    delete (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("elfui.devtools.template-node-registry")
    ];
  });

  it("invalidates a visual target when its node disappears", async () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-removed-card");
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "Remove me";
    shadow.append(button);
    document.body.append(host);
    bridge.registerComponent({
      id: "component:removed-card",
      host,
      tag: "elf-removed-card",
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 30,
      width: 100,
      height: 36,
    } as DOMRect);
    const controller = new VisualToolsController(bridge, {
      document,
      reconcileDelay: 0,
    });
    controller.enable();
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 30,
        clientY: 40,
      }),
    );
    button.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 45,
        clientY: 55,
      }),
    );
    controller.setTool("comment");
    controller.setCommentText("Keep the intended location.");
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 30,
        clientY: 40,
      }),
    );
    button.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 30,
        clientY: 40,
      }),
    );
    controller.setTool("motion");
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 30,
        clientY: 40,
      }),
    );
    controller.previewSelectedMotion();
    expect(controller.getDraft().intents).toEqual([
      expect.objectContaining({ type: "move" }),
      expect.objectContaining({ type: "motion" }),
    ]);

    bridge.unregisterComponent(host);
    host.remove();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(controller.getDraft()).toMatchObject({
      targets: [],
      intents: [],
      annotations: [{ type: "comment", targetIds: [] }],
    });
    expect(
      bridge
        .getPipelineState()
        .records.map((record) => record.kind)
        .filter((kind) => kind === "visual.target.invalidate"),
    ).toHaveLength(1);
    controller.dispose();
  });

  it("invalidates and removes a persisted draft after page navigation", () => {
    const bridge = createDevtoolsBridge();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        values.set(key, value);
      },
      removeItem: (key: string): void => {
        values.delete(key);
      },
    };
    const originalRoute = `${location.pathname}${location.search}${location.hash}`;
    const controller = new VisualToolsController(bridge, {
      document,
      storage,
    });
    controller.restore({
      schemaVersion: 1,
      id: "visual-draft:route",
      targets: [],
      intents: [],
      annotations: [
        {
          id: "annotation:route",
          type: "rectangle",
          targetIds: [],
          geometry: { x: 10, y: 20, width: 30, height: 40 },
          createdAt: 1,
        },
      ],
      screenshotIds: [],
    });
    expect(values.has(DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY)).toBe(true);

    history.pushState({}, "", "/after-navigation?view=details#result");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(controller.getDraft()).toMatchObject({
      targets: [],
      intents: [],
      annotations: [],
      screenshotIds: [],
    });
    expect(values.has(DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY)).toBe(false);
    expect(bridge.getPipelineState().records.at(-1)).toMatchObject({
      kind: "visual.draft.invalidate",
      summary: "Invalidated visual draft: route-changed",
    });
    controller.dispose();
    history.replaceState({}, "", originalRoute);
  });

  it("supports legacy persisted drafts and rejects another route", () => {
    const bridge = createDevtoolsBridge();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        values.set(key, value);
      },
      removeItem: (key: string): void => {
        values.delete(key);
      },
    };
    const legacyDraft = {
      schemaVersion: 1,
      id: "visual-draft:legacy",
      targets: [target],
      intents: [
        {
          id: `visual-intent:move:${target.id}`,
          type: "move",
          targetId: target.id,
          before: target.geometry,
          desired: { ...target.geometry, x: 20 },
          relations: [],
        },
      ],
      annotations: [
        {
          id: "annotation:legacy",
          type: "rectangle" as const,
          targetIds: [],
          geometry: { x: 1, y: 2, width: 3, height: 4 },
          createdAt: 1,
        },
      ],
      screenshotIds: [],
    } satisfies VisualDraft;
    values.set(DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY, JSON.stringify(legacyDraft));
    const restored = new VisualToolsController(bridge, {
      document,
      storage,
    });
    expect(restored.getDraft().annotations).toHaveLength(1);
    expect(restored.getDraft().targets).toEqual([]);
    expect(restored.getDraft().intents).toEqual([]);
    expect(
      JSON.parse(values.get(DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY) ?? "{}"),
    ).toMatchObject({
      route: `${location.pathname}${location.search}${location.hash}`,
      draft: { id: "visual-draft:legacy" },
    });
    restored.dispose();

    values.set(
      DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY,
      JSON.stringify({ route: "/another-route", draft: legacyDraft }),
    );
    const rejected = new VisualToolsController(bridge, {
      document,
      storage,
    });
    expect(rejected.getDraft().annotations).toEqual([]);
    expect(values.has(DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY)).toBe(false);
    rejected.dispose();
  });

  it("keeps template-node precision for style targets in a closed root", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-closed-style-card");
    const root = host.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    button.textContent = "Closed publish";
    root.append(button);
    document.body.append(host);
    const renderRoots = new WeakMap<HTMLElement, ShadowRoot>([[host, root]]);
    const templateNodes = new WeakMap<Node, object>([
      [
        button,
        {
          sourceId: "src/ClosedStyle.ts",
          templateNodeId: "src/ClosedStyle.ts:component:button:4:3",
          source: { file: "src/ClosedStyle.ts", line: 4, column: 3 },
        },
      ],
    ]);
    Object.defineProperty(
      globalThis,
      Symbol.for("elfui.devtools.render-root-registry"),
      { value: renderRoots, configurable: true },
    );
    Object.defineProperty(
      globalThis,
      Symbol.for("elfui.devtools.template-node-registry"),
      { value: templateNodes, configurable: true },
    );
    bridge.registerComponent({
      id: "component:closed-style",
      host,
      tag: "elf-closed-style-card",
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 16,
      y: 24,
      width: 120,
      height: 40,
    } as DOMRect);
    const controller = new VisualToolsController(bridge, { document });
    controller.setTool("style");
    controller.enable();
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 20,
        clientY: 30,
      }),
    );

    expect(controller.getDraft().targets).toMatchObject([
      {
        id: expect.stringContaining("src/ClosedStyle.ts:component:button:4:3"),
        inspector: {
          sourcePrecision: "template-node",
          templateNodeId: "src/ClosedStyle.ts:component:button:4:3",
        },
      },
    ]);
    controller.dispose();
    delete (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("elfui.devtools.render-root-registry")
    ];
    delete (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("elfui.devtools.template-node-registry")
    ];
  });

  it("infers semantic relations for a ghost drop target", () => {
    expect(
      inferVisualRelations(
        { x: 20, y: 80, width: 100, height: 32 },
        { x: 20, y: 32, width: 100, height: 36 },
      ),
    ).toEqual(["after", "align-with", "near"]);
    expect(
      inferVisualRelations(
        { x: 60, y: 50, width: 40, height: 20 },
        { x: 20, y: 20, width: 120, height: 80 },
      ),
    ).toEqual(["inside", "align-with", "near"]);
  });

  it("attaches inferred relations to a move intent", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-relation-card");
    const shadow = host.attachShadow({ mode: "open" });
    const moving = document.createElement("button");
    moving.textContent = "Move";
    const anchor = document.createElement("button");
    anchor.textContent = "Anchor";
    shadow.append(moving, anchor);
    document.body.append(host);
    bridge.registerComponent({
      id: "component:relation-card",
      host,
      tag: "elf-relation-card",
    });
    vi.spyOn(moving, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 20,
      width: 100,
      height: 32,
    } as DOMRect);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 70,
      width: 100,
      height: 36,
    } as DOMRect);
    const originalElementsFromPoint = document.elementsFromPoint;
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [anchor],
    });
    const controller = new VisualToolsController(bridge, { document });
    controller.enable();
    moving.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 24,
        clientY: 24,
      }),
    );
    moving.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 24,
        clientY: 132,
      }),
    );

    expect(controller.getDraft().intents).toMatchObject([
      {
        type: "move",
        relations: [
          { type: "after", targetId: expect.stringContaining("button") },
          { type: "align-with", targetId: expect.stringContaining("button") },
          { type: "near", targetId: expect.stringContaining("button") },
        ],
      },
    ]);
    expect(
      document.querySelector<HTMLElement>(
        "[data-elfui-devtools=visual-relation-hint]",
      )?.textContent,
    ).toContain("after");
    controller.dispose();
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: originalElementsFromPoint,
    });
  });

  it("adds a rectangle annotation without changing the page", () => {
    const bridge = createDevtoolsBridge();
    const controller = new VisualToolsController(bridge, { document });
    controller.setTool("rectangle");
    controller.enable();
    const businessNode = document.createElement("p");
    businessNode.textContent = "Business content";
    document.body.append(businessNode);
    const before = businessNode.outerHTML;
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 30,
        clientY: 40,
      }),
    );
    document.body.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 90,
        clientY: 100,
      }),
    );

    expect(controller.getDraft().annotations).toMatchObject([
      {
        type: "rectangle",
        targetIds: [],
        geometry: { x: 30, y: 40, width: 60, height: 60 },
      },
    ]);
    expect(
      document.querySelector(
        "[data-elfui-devtools=visual-annotation-layer] [data-annotation-type=rectangle]",
      ),
    ).not.toBeNull();
    expect(businessNode.outerHTML).toBe(before);
    controller.dispose();
  });

  it("does not turn DevTools Shadow DOM controls into annotations", () => {
    const bridge = createDevtoolsBridge();
    const controller = new VisualToolsController(bridge, { document });
    controller.setTool("rectangle");
    controller.enable();
    const host = document.createElement("div");
    host.dataset.elfuiDevtools = "host";
    const root = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "Prepare request";
    root.append(button);
    document.body.append(host);

    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 30,
        clientY: 40,
      }),
    );
    button.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 90,
        clientY: 100,
      }),
    );

    expect(controller.getDraft().annotations).toEqual([]);
    controller.dispose();
  });

  it("marks a screenshot redaction region in the annotation layer", () => {
    const bridge = createDevtoolsBridge();
    const controller = new VisualToolsController(bridge, { document });
    controller.setTool("redaction");
    controller.enable();
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 12,
        clientY: 18,
      }),
    );
    document.body.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 72,
        clientY: 48,
      }),
    );

    expect(controller.getDraft().annotations).toMatchObject([
      {
        type: "redaction",
        geometry: { x: 12, y: 18, width: 60, height: 30 },
      },
    ]);
    expect(
      document
        .querySelector<HTMLElement>(
          "[data-elfui-devtools=visual-annotation-layer] [data-annotation-type=redaction]",
        )
        ?.style.getPropertyValue("background"),
    ).toBe("rgb(17, 24, 39)");
    controller.dispose();
  });

  it("resizes only the ghost and preserves the business element", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-resize-card");
    const shadow = host.attachShadow({ mode: "open" });
    const card = document.createElement("article");
    card.setAttribute("style", "width:120px;height:40px");
    shadow.append(card);
    document.body.append(host);
    bridge.registerComponent({
      id: "component:resize-card",
      host,
      tag: "elf-resize-card",
    });
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 20,
      width: 120,
      height: 40,
    } as DOMRect);
    const before = card.outerHTML;
    const controller = new VisualToolsController(bridge, { document });
    controller.setTool("resize");
    controller.enable();

    card.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 130,
        clientY: 60,
      }),
    );
    card.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 155,
        clientY: 72,
      }),
    );

    expect(controller.getDraft().intents).toMatchObject([
      {
        type: "resize",
        before: { width: 120, height: 40 },
        desired: { width: 145, height: 52 },
      },
    ]);
    expect(card.outerHTML).toBe(before);
    expect(
      document
        .querySelector("[data-elfui-devtools=visual-ghost]")
        ?.getAttribute("style"),
    ).toContain("width: 145px");
    controller.dispose();
  });

  it("anchors a comment to an ElfUI target without dispatching its action", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-comment-card");
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "Submit";
    shadow.append(button);
    document.body.append(host);
    bridge.registerComponent({
      id: "component:comment-card",
      host,
      tag: "elf-comment-card",
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 30,
      width: 100,
      height: 36,
    } as DOMRect);
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const controller = new VisualToolsController(bridge, { document });
    controller.setTool("comment");
    controller.setCommentText("Move this action closer to the title.");
    controller.enable();

    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 40,
        clientY: 45,
      }),
    );
    button.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 40,
        clientY: 45,
      }),
    );

    expect(controller.getDraft().annotations).toMatchObject([
      {
        type: "comment",
        targetIds: [expect.stringContaining("component:comment-card")],
        text: "Move this action closer to the title.",
        from: { x: 40, y: 45 },
      },
    ]);
    expect(
      document.querySelector(
        "[data-elfui-devtools=visual-annotation-layer] [data-annotation-type=comment]",
      )?.textContent,
    ).toBe("Move this action closer to the title.");
    expect(clicked).not.toHaveBeenCalled();
    controller.dispose();
  });
});
