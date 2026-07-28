import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDevtoolsBridge,
  createInPageDevtoolsTransport,
} from "@elfui/devtools-runtime";
import { ELFUI_TEMPLATE_NODE_DEBUG_KEY } from "@elfui/devtools-shared";
import {
  DEVTOOLS_LAYOUT_STORAGE_KEY,
  DEVTOOLS_PREFERENCES_STORAGE_KEY,
  DevtoolsPanel,
} from "./panel";
import { DevtoolsRpcClient } from "./rpc-client";

describe("DevtoolsPanel", () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    delete (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("elfui.devtools.template-node-registry")
    ];
    delete (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("elfui.devtools.render-root-registry")
    ];
  });
  it("renders a component tree, opens its source, and shows details", async () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-counter");
    const componentId = bridge.registerComponent({
      host,
      tag: "elf-counter",
      props: () => ({ count: 2 }),
      source: { file: "/src/Counter.elf", line: 2, column: 3 },
    });
    bridge.emitReactivityEvent({
      type: "reactivity:effect",
      triggerId: "trigger:counter",
      effectId: "effect:counter-text",
      componentId,
      debug: {
        kind: "binding",
        name: "text:count",
        source: { line: 3, column: 5 },
      },
      duration: 0.75,
    });
    bridge.ingestCompilerArtifact({
      revision: 1,
      capturedAt: 10,
      id: "/project/src/Counter.elf",
      sourceId: "src/Counter.elf",
      kind: "metadata",
      payload: {
        schemaVersion: 2,
        sourceId: "src/Counter.elf",
        components: [{ name: "elf-counter" }],
        fragments: [
          {
            name: "CountLabel",
            ownerComponents: ["elf-counter"],
            source: { line: 4, column: 3 },
          },
        ],
      },
    });
    bridge.ingestCompilerArtifact({
      revision: 2,
      capturedAt: 11,
      id: "/project/src/Counter.elf:diagnostics",
      sourceId: "src/Counter.elf",
      kind: "diagnostics",
      payload: [
        {
          severity: "warning",
          code: "ELF_COUNTER_HINT",
          message: "Counter label can be simplified.",
          component: "elf-counter",
          line: 4,
          column: 5,
        },
      ],
    });
    const openSource = vi.fn().mockResolvedValue(undefined);
    const panel = new DevtoolsPanel(bridge, document, undefined, openSource);
    const panelHost = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    );
    const shadow = panelHost?.shadowRoot;
    const panelNode = shadow?.querySelector<HTMLElement>(
      "[data-elfui-devtools=panel]",
    );
    expect(panel.opened).toBe(false);
    expect(panelNode?.hidden).toBe(true);
    shadow
      ?.querySelector<HTMLButtonElement>('[aria-label="Toggle ElfUI DevTools"]')
      ?.click();
    expect(panel.opened).toBe(true);
    expect(panelNode?.hidden).toBe(false);
    const componentButton = Array.from(
      shadow?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "<elf-counter>");
    componentButton?.click();
    expect(panelNode?.textContent).toContain("count: 2");
    expect(panelNode?.textContent).toContain("elf-counter");
    expect(panelNode?.textContent).toContain("/src/Counter.elf:2:3");
    expect(panelNode?.textContent).toContain("text:count");
    expect(panelNode?.textContent).toContain("ELF_COUNTER_HINT");
    expect(
      shadow?.querySelector("[data-elfui-devtools=compiler-state]")
        ?.textContent,
    ).toContain("1 fragments");
    expect(
      shadow?.querySelector("[data-elfui-devtools=compiler-json]")?.textContent,
    ).toContain("CountLabel");
    expect(
      shadow?.querySelector("[data-elfui-devtools=pipeline]")?.textContent,
    ).toContain("target-snapshot");
    expect(
      shadow?.querySelector("[data-elfui-devtools=pipeline-json]")?.textContent,
    ).toContain('"kind": "component.select"');
    shadow
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Open component source in editor"]',
      )
      ?.click();
    await vi.waitFor(() => {
      expect(openSource).toHaveBeenCalledWith({
        file: "/src/Counter.elf",
        line: 2,
        column: 3,
      });
    });
    bridge.notifyUpdate(host);
    await Promise.resolve();
    expect(
      shadow?.querySelector("[data-elfui-devtools=timeline]")?.textContent,
    ).toContain("component:update");
    shadow
      ?.querySelector<HTMLButtonElement>('[aria-label="Pause timeline"]')
      ?.click();
    bridge.notifyUpdate(host);
    expect(bridge.getTimelineStatus()).toMatchObject({
      paused: true,
      droppedEvents: 1,
    });
    expect(
      shadow?.querySelector<HTMLButtonElement>(
        '[aria-label="Resume timeline"]',
      ),
    ).not.toBeNull();
    shadow
      ?.querySelector<HTMLButtonElement>('[aria-label="Clear timeline"]')
      ?.click();
    expect(bridge.getTimeline()).toHaveLength(0);
    shadow
      ?.querySelector<HTMLButtonElement>('[aria-label="Clear data pipeline"]')
      ?.click();
    expect(bridge.getPipelineState()).toEqual({
      droppedRecords: 0,
      records: [],
    });
    panel.dispose();
  });

  it("filters, collapses, and links component-tree selection to details", () => {
    const bridge = createDevtoolsBridge();
    const root = document.createElement("elf-root");
    const child = document.createElement("elf-select");
    const sibling = document.createElement("elf-button");
    const rootId = bridge.registerComponent({ host: root, tag: "elf-root" });
    const childId = bridge.registerComponent({
      host: child,
      parentId: rootId,
      tag: "elf-select",
      props: () => ({ modelValue: "A" }),
    });
    bridge.registerComponent({
      host: sibling,
      parentId: rootId,
      tag: "elf-button",
    });
    const panel = new DevtoolsPanel(bridge, document);
    const shadow = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    )?.shadowRoot;

    shadow
      ?.querySelector<HTMLButtonElement>('[aria-label="Collapse <elf-root>"]')
      ?.click();
    expect(
      shadow?.querySelector("[data-elfui-devtools=component-tree]")
        ?.textContent,
    ).not.toContain("elf-select");
    shadow
      ?.querySelector<HTMLButtonElement>('[aria-label="Expand <elf-root>"]')
      ?.click();

    const search = shadow?.querySelector<HTMLInputElement>(
      '[aria-label="Filter components"]',
    );
    if (search) {
      search.value = "select";
      search.dispatchEvent(new Event("input"));
    }
    const treeText = shadow?.querySelector(
      "[data-elfui-devtools=component-tree]",
    )?.textContent;
    expect(treeText).toContain("elf-root");
    expect(treeText).toContain("elf-select");
    expect(treeText).not.toContain("elf-button");

    const selectButton = Array.from(
      shadow?.querySelectorAll<HTMLButtonElement>("button.component") ?? [],
    ).find((button) => button.textContent === "<elf-select>");
    selectButton?.click();
    expect(
      Array.from(
        shadow?.querySelectorAll<HTMLButtonElement>("button.component") ?? [],
      )
        .find((button) => button.textContent === "<elf-select>")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      shadow?.querySelector("[data-elfui-devtools=component-detail]")
        ?.textContent,
    ).toContain('modelValue: "A"');
    expect(bridge.getComponentDetail(childId)?.tag).toBe("elf-select");

    panel.dispose();
  });

  it("supports keyboard navigation, inspector shortcuts, focus, and tree ARIA", async () => {
    const bridge = createDevtoolsBridge();
    const rootId = bridge.registerComponent({
      host: document.createElement("elf-root"),
      tag: "elf-root",
    });
    bridge.registerComponent({
      host: document.createElement("elf-child"),
      parentId: rootId,
      tag: "elf-child",
    });
    const panel = new DevtoolsPanel(bridge, document);
    const shadow = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    )?.shadowRoot;
    const panelToggle = shadow?.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle ElfUI DevTools"]',
    );
    panelToggle?.click();
    await Promise.resolve();
    expect(
      (shadow?.activeElement as HTMLElement | null)?.dataset.devtoolsTab,
    ).toBe("components");

    const componentsTab = shadow?.querySelector<HTMLButtonElement>(
      '[data-devtools-tab="components"]',
    );
    componentsTab?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight" }),
    );
    expect(
      (shadow?.activeElement as HTMLElement | null)?.dataset.devtoolsTab,
    ).toBe("timeline");

    shadow
      ?.querySelector<HTMLButtonElement>('[data-devtools-tab="components"]')
      ?.click();
    const tree = shadow?.querySelector<HTMLElement>(
      "[data-elfui-devtools=component-tree]",
    );
    expect(tree?.getAttribute("role")).toBe("tree");
    const rootButton = Array.from(
      tree?.querySelectorAll<HTMLButtonElement>("button.component") ?? [],
    ).find((button) => button.textContent === "<elf-root>");
    expect(rootButton).toMatchObject({
      tabIndex: 0,
    });
    expect(rootButton?.getAttribute("role")).toBe("treeitem");
    expect(rootButton?.getAttribute("aria-expanded")).toBe("true");
    rootButton?.focus();
    rootButton?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown" }),
    );
    expect((shadow?.activeElement as HTMLElement | null)?.textContent).toBe(
      "<elf-child>",
    );
    (shadow?.activeElement as HTMLElement | null)?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft" }),
    );
    expect((shadow?.activeElement as HTMLElement | null)?.textContent).toBe(
      "<elf-root>",
    );
    (shadow?.activeElement as HTMLElement | null)?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft" }),
    );
    await Promise.resolve();
    expect(
      tree
        ?.querySelector<HTMLButtonElement>(
          'button.component[data-component-id="' + rootId + '"]',
        )
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(tree?.textContent).not.toContain("elf-child");

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "c",
        ctrlKey: true,
        shiftKey: true,
      }),
    );
    const inspectorToggle = shadow?.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle Component Inspector"]',
    );
    expect(inspectorToggle?.getAttribute("aria-pressed")).toBe("true");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(inspectorToggle?.getAttribute("aria-pressed")).toBe("false");
    expect(panel.opened).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel.opened).toBe(false);
    expect(shadow?.activeElement).toBe(panelToggle);
    panel.dispose();
  });

  it("filters apps and persists navigation and theme preferences", () => {
    window.localStorage.setItem(
      DEVTOOLS_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        activeTab: "timeline",
        theme: "light",
        appId: "app:alpha",
      }),
    );
    const bridge = createDevtoolsBridge();
    bridge.registerApp("app:alpha", "Alpha app");
    bridge.registerApp("app:beta", "Beta app");
    bridge.registerComponent({
      host: document.createElement("elf-alpha-card"),
      appId: "app:alpha",
      tag: "elf-alpha-card",
    });
    bridge.registerComponent({
      host: document.createElement("elf-beta-card"),
      appId: "app:beta",
      tag: "elf-beta-card",
    });

    const panel = new DevtoolsPanel(bridge, document);
    const host = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    );
    const shadow = host?.shadowRoot;
    expect(host?.dataset.theme).toBe("light");
    expect(
      shadow
        ?.querySelector('[data-devtools-tab="timeline"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      shadow?.querySelector<HTMLElement>(
        "[data-elfui-devtools=components-view]",
      )?.hidden,
    ).toBe(true);
    expect(
      shadow?.querySelector<HTMLElement>("#elfui-devtools-view-timeline")
        ?.hidden,
    ).toBe(false);
    expect(
      shadow?.querySelector<HTMLSelectElement>(
        '[aria-label="Select ElfUI app"]',
      )?.value,
    ).toBe("app:alpha");
    expect(
      shadow?.querySelector("[data-elfui-devtools=component-tree]")
        ?.textContent,
    ).toContain("elf-alpha-card");
    expect(
      shadow?.querySelector("[data-elfui-devtools=component-tree]")
        ?.textContent,
    ).not.toContain("elf-beta-card");

    shadow
      ?.querySelector<HTMLButtonElement>('[data-devtools-tab="pipeline"]')
      ?.click();
    const theme = shadow?.querySelector<HTMLSelectElement>(
      '[aria-label="DevTools theme"]',
    );
    if (theme) {
      theme.value = "dark";
      theme.dispatchEvent(new Event("change"));
    }
    const app = shadow?.querySelector<HTMLSelectElement>(
      '[aria-label="Select ElfUI app"]',
    );
    if (app) {
      app.value = "app:beta";
      app.dispatchEvent(new Event("change"));
    }

    expect(
      JSON.parse(
        window.localStorage.getItem(DEVTOOLS_PREFERENCES_STORAGE_KEY) ?? "null",
      ),
    ).toEqual({
      activeTab: "pipeline",
      theme: "dark",
      appId: "app:beta",
    });
    expect(host?.dataset.theme).toBe("dark");
    expect(
      shadow?.querySelector("[data-elfui-devtools=component-tree]")
        ?.textContent,
    ).toContain("elf-beta-card");
    panel.dispose();

    const restored = new DevtoolsPanel(bridge, document);
    const restoredHost = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    );
    expect(restoredHost?.dataset.theme).toBe("dark");
    expect(
      restoredHost?.shadowRoot
        ?.querySelector('[data-devtools-tab="pipeline"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      restoredHost?.shadowRoot?.querySelector<HTMLSelectElement>(
        '[aria-label="Select ElfUI app"]',
      )?.value,
    ).toBe("app:beta");
    restored.dispose();
  });

  it("records an inspected template element as a visible target snapshot", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-form");
    const button = document.createElement("button");
    button.textContent = "Submit";
    (button as unknown as Record<symbol, unknown>)[
      Symbol.for(ELFUI_TEMPLATE_NODE_DEBUG_KEY)
    ] = {
      sourceId: "src/Form.ts",
      templateNodeId: "src/Form.ts:button:8:5",
      source: { file: "src/Form.ts", line: 8, column: 5 },
    };
    host.attachShadow({ mode: "open" }).appendChild(button);
    document.body.appendChild(host);
    bridge.registerComponent({ host, tag: "elf-form" });
    const panel = new DevtoolsPanel(bridge, document);
    const shadow = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    )?.shadowRoot;
    shadow
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Toggle Component Inspector"]',
      )
      ?.click();

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

    const pipelineJson = shadow?.querySelector(
      "[data-elfui-devtools=pipeline-json]",
    )?.textContent;
    expect(pipelineJson).toContain('"kind": "element.select"');
    expect(pipelineJson).toContain('"templateNodeId"');
    expect(pipelineJson).toContain("src/Form.ts:button:8:5");
    expect(pipelineJson).toContain('"key": "sourcePrecision"');
    expect(pipelineJson).toContain('"value": "template-node"');
    panel.dispose();
  });

  it("restores a template-node selection after an HMR replacement", async () => {
    const bridge = createDevtoolsBridge();
    const markerKey = Symbol.for(ELFUI_TEMPLATE_NODE_DEBUG_KEY);
    const createHost = (label: string): [HTMLElement, HTMLButtonElement] => {
      const host = document.createElement("elf-hmr-card");
      const button = document.createElement("button");
      button.textContent = label;
      (button as unknown as Record<symbol, unknown>)[markerKey] = {
        sourceId: "src/HmrCard.ts",
        templateNodeId: "src/HmrCard.ts:component:button:6:3",
        source: { file: "src/HmrCard.ts", line: 6, column: 3 },
      };
      host.attachShadow({ mode: "open" }).append(button);
      return [host, button];
    };
    const [oldHost, oldButton] = createHost("before");
    document.body.append(oldHost);
    bridge.registerComponent({
      host: oldHost,
      tag: "elf-hmr-card",
      source: { file: "src/HmrCard.ts", line: 1, column: 1 },
    });
    const panel = new DevtoolsPanel(bridge, document);
    const shadow = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    )?.shadowRoot;
    shadow
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Toggle Component Inspector"]',
      )
      ?.click();
    oldButton.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, composed: true }),
    );
    oldButton.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );

    const [newHost] = createHost("after");
    oldHost.replaceWith(newHost);
    bridge.unregisterComponent(oldHost);
    const replacementId = bridge.registerComponent({
      host: newHost,
      tag: "elf-hmr-card",
      source: { file: "src/HmrCard.ts", line: 1, column: 1 },
    });

    await vi.waitFor(() => {
      expect(
        bridge
          .getPipelineState()
          .records.some((record) => record.kind === "selection.restore"),
      ).toBe(true);
      expect(
        shadow?.querySelector<HTMLButtonElement>(
          `button.component[aria-pressed="true"]`,
        )?.textContent,
      ).toBe("<elf-hmr-card>");
      expect(
        shadow?.querySelector("[data-elfui-devtools=pipeline-json]")
          ?.textContent,
      ).toContain(replacementId);
      expect(
        shadow?.querySelector("[data-elfui-devtools=pipeline-json]")
          ?.textContent,
      ).toContain("src/HmrCard.ts:component:button:6:3");
    });
    panel.dispose();
  });

  it("invalidates a removed selection when HMR has no replacement", async () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-hmr-removed");
    bridge.registerComponent({
      host,
      tag: "elf-hmr-removed",
      source: { file: "src/Removed.ts", line: 1, column: 1 },
    });
    const panel = new DevtoolsPanel(bridge, document);
    const shadow = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    )?.shadowRoot;
    shadow?.querySelector<HTMLButtonElement>("button.component")?.click();
    bridge.unregisterComponent(host);

    await vi.waitFor(() => {
      expect(
        bridge
          .getPipelineState()
          .records.some((record) => record.kind === "selection.invalidate"),
      ).toBe(true);
      expect(
        shadow?.querySelector("[data-elfui-devtools=component-detail]"),
      ).toBeNull();
    });
    panel.dispose();
  });

  it("inspects template nodes inside a registry-only closed shadow root", () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-closed-card");
    const root = host.attachShadow({ mode: "closed" });
    const renderRoots = new WeakMap<HTMLElement, ShadowRoot>();
    renderRoots.set(host, root);
    Object.defineProperty(
      globalThis,
      Symbol.for("elfui.devtools.render-root-registry"),
      {
        value: renderRoots,
        configurable: true,
      },
    );
    const templateNodes = new WeakMap<Node, unknown>();
    const button = document.createElement("button");
    button.textContent = "Closed action";
    templateNodes.set(button, {
      sourceId: "src/ClosedCard.ts",
      templateNodeId: "src/ClosedCard.ts:component:button:4:3",
      source: { file: "src/ClosedCard.ts", line: 4, column: 3 },
    });
    Object.defineProperty(
      globalThis,
      Symbol.for("elfui.devtools.template-node-registry"),
      {
        value: templateNodes,
        configurable: true,
      },
    );
    root.append(button);
    document.body.append(host);
    bridge.registerComponent({ host, tag: "elf-closed-card" });
    const panel = new DevtoolsPanel(bridge, document);
    const shadow = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    )?.shadowRoot;
    shadow
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Toggle Component Inspector"]',
      )
      ?.click();

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
      shadow?.querySelector("[data-elfui-devtools=pipeline-json]")?.textContent,
    ).toContain("src/ClosedCard.ts:component:button:4:3");
    panel.dispose();
  });

  it("reads panel data and controls the timeline through RPC", async () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-rpc-panel");
    bridge.registerComponent({ host, tag: "elf-rpc-panel" });
    const rpc = new DevtoolsRpcClient(createInPageDevtoolsTransport(bridge));
    await rpc.connect();
    const panel = new DevtoolsPanel(bridge, document, rpc);
    const shadow = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    )?.shadowRoot;

    await vi.waitFor(() => {
      expect(shadow?.textContent).toContain("<elf-rpc-panel>");
    });
    shadow
      ?.querySelector<HTMLButtonElement>('[aria-label="Pause timeline"]')
      ?.click();
    await vi.waitFor(() => {
      expect(bridge.getTimelineStatus().paused).toBe(true);
      expect(
        shadow?.querySelector('[aria-label="Resume timeline"]'),
      ).not.toBeNull();
    });

    panel.dispose();
    rpc.dispose();
  });

  it("freezes a visual draft into an auditable AI request without contacting a provider", async () => {
    const bridge = createDevtoolsBridge({ now: () => 90 });
    const panel = new DevtoolsPanel(bridge, document);
    const shadow = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    )?.shadowRoot;

    shadow
      ?.querySelector<HTMLButtonElement>('[aria-label="Toggle Visual Draft"]')
      ?.click();
    const tool = await vi.waitFor(() => {
      const element = shadow?.querySelector<HTMLSelectElement>(
        '[aria-label="Visual draft tool"]',
      );
      expect(element).not.toBeNull();
      return element;
    });
    if (tool) {
      tool.value = "rectangle";
      tool.dispatchEvent(new Event("change"));
    }
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 20,
      }),
    );
    document.body.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 60,
        clientY: 70,
      }),
    );

    await vi.waitFor(() => {
      expect(
        shadow?.querySelector<HTMLButtonElement>(
          '[aria-label="Prepare AI change request"]',
        )?.disabled,
      ).toBe(false);
    });
    shadow
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Prepare AI change request"]',
      )
      ?.click();

    const records = bridge.getPipelineState().records;
    expect(records.map((record) => record.kind)).toContain("ai.context.bundle");
    expect(records.map((record) => record.kind)).toContain("ai.request.create");
    expect(
      shadow?.querySelector('[data-elfui-devtools="pipeline-json"]')
        ?.textContent,
    ).toContain("ai-change:");
    panel.dispose();
  });

  it("captures a phased viewport screenshot and includes only its metadata in the AI request", async () => {
    const bridge = createDevtoolsBridge({ now: () => 95 });
    const capture = vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,AAAA",
      mimeType: "image/png",
      width: 1280,
      height: 720,
      devicePixelRatio: 2,
    });
    const panel = new DevtoolsPanel(
      bridge,
      document,
      undefined,
      vi.fn().mockResolvedValue(undefined),
      { capture },
    );
    const shadow = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    )?.shadowRoot;

    shadow
      ?.querySelector<HTMLButtonElement>('[aria-label="Toggle Visual Draft"]')
      ?.click();
    const tool = await vi.waitFor(() => {
      const element = shadow?.querySelector<HTMLSelectElement>(
        '[aria-label="Visual draft tool"]',
      );
      expect(element).not.toBeNull();
      return element;
    });
    if (tool) {
      tool.value = "redaction";
      tool.dispatchEvent(new Event("change"));
    }
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 20,
        clientY: 30,
      }),
    );
    document.body.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 80,
        clientY: 70,
      }),
    );
    const captureButton = await vi.waitFor(() => {
      const element = shadow?.querySelector<HTMLButtonElement>(
        '[aria-label="Capture visual screenshot"]',
      );
      expect(element?.disabled).toBe(false);
      return element;
    });
    captureButton?.click();

    await vi.waitFor(() => {
      expect(capture).toHaveBeenCalledWith({
        kind: "viewport",
        excludedRegions: [{ x: 20, y: 30, width: 60, height: 40 }],
      });
      expect(shadow?.textContent).toContain(
        "Captured before viewport · 1280×720",
      );
    });
    shadow
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Prepare AI change request"]',
      )
      ?.click();

    const requestRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "ai.request.create");
    const payload = JSON.stringify(requestRecord?.payload);
    expect(payload).toContain("screenshot:");
    expect(payload).toContain("before");
    expect(payload).not.toContain("data:image/png");
    panel.dispose();
  });

  it("docks, resizes, enters fullscreen, and restores persisted layout", () => {
    window.localStorage.setItem(
      DEVTOOLS_LAYOUT_STORAGE_KEY,
      JSON.stringify({ dock: "right", width: 512, height: 444 }),
    );
    const bridge = createDevtoolsBridge();
    const panel = new DevtoolsPanel(bridge, document);
    const shadow = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    )?.shadowRoot;
    const panelNode = shadow?.querySelector<HTMLElement>(
      "[data-elfui-devtools=panel]",
    );

    expect(panelNode?.dataset.dock).toBe("right");
    expect(panelNode?.style.getPropertyValue("--elfui-devtools-width")).toBe(
      "512px",
    );
    expect(panelNode?.style.getPropertyValue("--elfui-devtools-height")).toBe(
      "444px",
    );

    const dock = shadow?.querySelector<HTMLSelectElement>(
      '[aria-label="Dock position"]',
    );
    if (dock) {
      dock.value = "bottom";
      dock.dispatchEvent(new Event("change"));
    }
    expect(panelNode?.dataset.dock).toBe("bottom");

    shadow
      ?.querySelector<HTMLButtonElement>('[aria-label="Enter fullscreen"]')
      ?.click();
    expect(panelNode?.dataset.fullscreen).toBe("true");
    shadow
      ?.querySelector<HTMLButtonElement>('[aria-label="Exit fullscreen"]')
      ?.click();
    expect(panelNode?.dataset.fullscreen).toBe("false");

    const resizeHandle = shadow?.querySelector<HTMLElement>(
      '[aria-label="Resize ElfUI DevTools"]',
    );
    resizeHandle?.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 100, clientY: 200 }),
    );
    expect(shadow?.activeElement).toBe(resizeHandle);
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 100, clientY: 160 }),
    );
    window.dispatchEvent(new MouseEvent("pointerup"));
    expect(panelNode?.style.getPropertyValue("--elfui-devtools-height")).toBe(
      "484px",
    );
    resizeHandle?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp" }),
    );
    expect(panelNode?.style.getPropertyValue("--elfui-devtools-height")).toBe(
      "500px",
    );
    expect(
      JSON.parse(
        window.localStorage.getItem(DEVTOOLS_LAYOUT_STORAGE_KEY) ?? "null",
      ),
    ).toEqual({ dock: "bottom", width: 512, height: 500 });

    panel.dispose();
    const restored = new DevtoolsPanel(createDevtoolsBridge(), document);
    const restoredNode = document
      .querySelector<HTMLElement>("[data-elfui-devtools=host]")
      ?.shadowRoot?.querySelector<HTMLElement>("[data-elfui-devtools=panel]");
    expect(restoredNode?.dataset.dock).toBe("bottom");
    expect(
      restoredNode?.style.getPropertyValue("--elfui-devtools-height"),
    ).toBe("500px");
    restored.dispose();
  });
});
