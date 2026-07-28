import { describe, expect, it, vi } from "vitest";

import { createDevtoolsBridge } from "@elfui/devtools-runtime";
import type { VisualTarget } from "@elfui/devtools-shared";

import { VisualIntentSession, VisualToolsController } from "./visual";

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
