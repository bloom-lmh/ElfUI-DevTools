import { afterEach, describe, expect, it, vi } from "vitest";

import { createDevtoolsBridge } from "@elfui/devtools-runtime";
import {
  ELFUI_TEMPLATE_NODE_DEBUG_KEY,
  type TemplateNodeDebugInfo,
} from "@elfui/devtools-shared";

import {
  ComponentInspector,
  createVisualTargetSnapshot,
  findTemplateNode,
} from "./index";

const TEMPLATE_NODE_REGISTRY_KEY = Symbol.for(
  "elfui.devtools.template-node-registry",
);

const installTemplateNodeRegistry = (
  registry: WeakMap<Node, TemplateNodeDebugInfo>,
): void => {
  Object.defineProperty(globalThis, TEMPLATE_NODE_REGISTRY_KEY, {
    value: registry,
    configurable: true,
  });
};

describe("ComponentInspector", () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete (globalThis as unknown as Record<symbol, unknown>)[
      TEMPLATE_NODE_REGISTRY_KEY
    ];
    vi.restoreAllMocks();
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

  it("captures a provider-neutral visual target without mutating the page", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-card");
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    shadow.append(button);
    document.body.append(host);
    const componentId = bridge.registerComponent({
      host,
      tag: "elf-card",
      props: () => ({ tone: "primary" }),
      source: { file: "src/Card.ts", line: 1, column: 1 },
    });
    const marker: TemplateNodeDebugInfo = {
      sourceId: "src/Card.ts",
      templateNodeId: "src/Card.ts:component:button:4:3",
      source: { file: "src/Card.ts", line: 4, column: 3 },
    };
    installTemplateNodeRegistry(new WeakMap([[button, marker]]));
    const bounds = {
      x: 12,
      y: 20,
      width: 120,
      height: 40,
    };
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      bounds as DOMRect,
    );
    const before = button.outerHTML;
    const target = createVisualTargetSnapshot(
      bridge,
      componentId,
      button,
      host,
    );

    expect(target).toMatchObject({
      id: `visual-target:${componentId}:${marker.templateNodeId}`,
      runtimeNodeId: marker.templateNodeId,
      componentId,
      geometry: bounds,
      source: {
        sourceId: marker.sourceId,
        templateNodeId: marker.templateNodeId,
        range: marker.source,
      },
      props: {
        kind: "object",
        entries: [{ key: "tone", value: { value: "primary" } }],
      },
    });
    expect(button.outerHTML).toBe(before);
  });

  it("reads registry metadata when the node Symbol mirror cannot be defined", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-native-select");
    const selectElement = document.createElement("select");
    host.attachShadow({ mode: "open" }).append(selectElement);
    document.body.append(host);
    const componentId = bridge.registerComponent({
      host,
      tag: "elf-native-select",
    });
    const marker: TemplateNodeDebugInfo = {
      sourceId: "src/NativeSelect.ts",
      templateNodeId: "src/NativeSelect.ts:component:select:8:3",
      source: { file: "src/NativeSelect.ts", line: 8, column: 3 },
    };
    const registry = new WeakMap<Node, TemplateNodeDebugInfo>();
    registry.set(selectElement, marker);
    installTemplateNodeRegistry(registry);

    const originalDefineProperty = Object.defineProperty;
    const defineProperty = vi
      .spyOn(Object, "defineProperty")
      .mockImplementation((target, key, descriptor) => {
        if (
          target === selectElement &&
          key === Symbol.for(ELFUI_TEMPLATE_NODE_DEBUG_KEY)
        )
          throw new TypeError("Symbol descriptors are unavailable");
        return originalDefineProperty(target, key, descriptor);
      });
    expect(() =>
      Object.defineProperty(
        selectElement,
        Symbol.for(ELFUI_TEMPLATE_NODE_DEBUG_KEY),
        { value: marker },
      ),
    ).toThrow("Symbol descriptors are unavailable");
    defineProperty.mockRestore();

    const select = vi.fn();
    const inspector = new ComponentInspector(bridge, { onSelect: select });
    inspector.enable();
    selectElement.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, composed: true }),
    );
    selectElement.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );

    expect(select).toHaveBeenCalledWith(
      componentId,
      expect.objectContaining({
        sourcePrecision: "template-node",
        templateNodeId: marker.templateNodeId,
        source: marker.source,
      }),
    );
    inspector.dispose();
  });

  it("finds a template node from the registry before the legacy mirror", () => {
    const host = document.createElement("elf-registry-card");
    const button = document.createElement("button");
    host.attachShadow({ mode: "open" }).append(button);
    const registryMarker: TemplateNodeDebugInfo = {
      sourceId: "src/RegistryCard.ts",
      templateNodeId: "src/RegistryCard.ts:component:button:5:3",
      source: { file: "src/RegistryCard.ts", line: 5, column: 3 },
    };
    const registry = new WeakMap<Node, TemplateNodeDebugInfo>();
    registry.set(button, registryMarker);
    installTemplateNodeRegistry(registry);
    (button as unknown as Record<symbol, unknown>)[
      Symbol.for(ELFUI_TEMPLATE_NODE_DEBUG_KEY)
    ] = {
      ...registryMarker,
      templateNodeId: "legacy-template-node",
    };

    expect(findTemplateNode(host, registryMarker.templateNodeId)).toBe(button);
    expect(findTemplateNode(host, "legacy-template-node")).toBeNull();
  });

  it("coalesces hover layout work into one animation frame", () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callbacks.push(callback);
        return callbacks.length;
      });
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-frame-card");
    const button = document.createElement("button");
    host.attachShadow({ mode: "open" }).append(button);
    document.body.append(host);
    bridge.registerComponent({ host, tag: "elf-frame-card" });
    const readBounds = vi.spyOn(button, "getBoundingClientRect");
    const inspector = new ComponentInspector(bridge);
    inspector.enable();

    for (let index = 0; index < 5; index += 1)
      button.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, composed: true }),
      );

    expect(requestFrame).toHaveBeenCalledOnce();
    expect(readBounds).not.toHaveBeenCalled();
    callbacks[0]?.(performance.now());
    expect(readBounds).toHaveBeenCalledOnce();
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
