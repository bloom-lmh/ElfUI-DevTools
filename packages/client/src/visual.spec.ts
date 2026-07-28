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
});
