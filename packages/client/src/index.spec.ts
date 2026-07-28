import { afterEach, describe, expect, it, vi } from "vitest";

import { createDevtoolsBridge } from "@elfui/devtools-runtime";
import { ELFUI_TEMPLATE_NODE_DEBUG_KEY } from "@elfui/devtools-shared";

import { ComponentInspector } from "./index";

describe("ComponentInspector", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("selects a registered Custom Element across a shadow root", () => {
    const bridge = createDevtoolsBridge();
    const root = document.createElement("elf-root");
    const child = document.createElement("elf-counter");
    const select = vi.fn();
    root.attachShadow({ mode: "open" }).appendChild(child);
    document.body.appendChild(root);
    bridge.registerComponent({ host: root, tag: "elf-root" });
    const childId = bridge.registerComponent({
      host: child,
      tag: "elf-counter",
    });
    const inspector = new ComponentInspector(bridge, { onSelect: select });
    inspector.enable();

    child.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, composed: true }),
    );
    const clicked = child.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );

    expect(
      document
        .querySelector("[data-component-id]")
        ?.getAttribute("data-component-id"),
    ).toBe(childId);
    expect(select).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        componentId: childId,
        sourcePrecision: "unresolved",
        element: expect.objectContaining({ tag: "elf-counter" }),
      }),
    );
    expect(clicked).toBe(false);
    inspector.dispose();
  });

  it("selects the concrete inner element and reads template source markers", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-card");
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.className = "primary action";
    button.textContent = "Save";
    (button as unknown as Record<symbol, unknown>)[
      Symbol.for(ELFUI_TEMPLATE_NODE_DEBUG_KEY)
    ] = {
      sourceId: "src/Card.ts",
      templateNodeId: "src/Card.ts:button:4:3",
      fragment: "CardActions",
      source: {
        file: "src/Card.ts",
        line: 4,
        column: 3,
        endLine: 4,
        endColumn: 37,
      },
    };
    shadow.appendChild(button);
    document.body.appendChild(host);
    const componentId = bridge.registerComponent({
      host,
      tag: "elf-card",
      source: { file: "src/Card.ts", line: 1, column: 1 },
    });
    const select = vi.fn();
    const inspector = new ComponentInspector(bridge, { onSelect: select });
    inspector.enable();

    button.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, composed: true }),
    );
    button.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );

    expect(
      document.querySelector<HTMLElement>("[data-template-node-id]")?.dataset,
    ).toMatchObject({
      componentId,
      sourcePrecision: "template-node",
      templateNodeId: "src/Card.ts:button:4:3",
    });
    expect(select).toHaveBeenCalledWith(componentId, {
      componentId,
      domPath: "elf-card > button",
      element: {
        tag: "button",
        classes: ["primary", "action"],
        text: "Save",
      },
      sourcePrecision: "template-node",
      source: {
        file: "src/Card.ts",
        line: 4,
        column: 3,
        endLine: 4,
        endColumn: 37,
      },
      sourceId: "src/Card.ts",
      templateNodeId: "src/Card.ts:button:4:3",
      fragment: "CardActions",
    });
    inspector.dispose();
  });

  it("reports component-level precision when an inner node has no marker", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-static-card");
    const label = document.createElement("span");
    label.textContent = "Static label";
    host.attachShadow({ mode: "open" }).appendChild(label);
    document.body.appendChild(host);
    const componentId = bridge.registerComponent({
      host,
      tag: "elf-static-card",
      source: { file: "src/StaticCard.ts", line: 12, column: 1 },
    });
    const select = vi.fn();
    const inspector = new ComponentInspector(bridge, { onSelect: select });
    inspector.enable();

    label.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, composed: true }),
    );
    label.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );

    expect(select).toHaveBeenCalledWith(
      componentId,
      expect.objectContaining({
        domPath: "elf-static-card > span",
        sourcePrecision: "component",
        source: { file: "src/StaticCard.ts", line: 12, column: 1 },
      }),
    );
    inspector.dispose();
  });

  it("stops inspecting on Escape and cleans up its overlay", () => {
    const inspector = new ComponentInspector(createDevtoolsBridge());
    inspector.enable();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(inspector.enabled).toBe(false);
    inspector.dispose();
    expect(document.querySelector("[aria-hidden=true]")).toBeNull();
  });
});
