import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDevtoolsBridge,
  createInPageDevtoolsTransport,
} from "@elfui/devtools-runtime";
import {
  ELFUI_TEMPLATE_NODE_DEBUG_KEY,
  type AIChangeRequest,
} from "@elfui/devtools-shared";
import {
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  type PatchProposalDecisionRequest,
  type PatchProposalReview,
} from "@elfui/devtools-ai";
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
    window.sessionStorage.clear();
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
        diagnostics: { errors: 0, warnings: 1, codes: ["ELF_COUNTER_HINT"] },
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
    expect(panelNode?.lang).toBe("zh-CN");
    expect(panelNode?.style.getPropertyValue("--elfui-devtools-width")).toBe(
      "640px",
    );
    expect(panelNode?.style.getPropertyValue("--elfui-devtools-height")).toBe(
      "720px",
    );
    expect(
      Number(
        document.querySelector<HTMLElement>(
          '[data-elfui-devtools="inspector-overlay"]',
        )?.style.zIndex,
      ),
    ).toBeLessThan(
      Number(
        document.querySelector<HTMLElement>("[data-elfui-devtools=host]")?.style
          .zIndex,
      ),
    );
    expect(panelNode?.textContent).toContain("组件");
    expect(panelNode?.textContent).toContain("时间线");
    expect(panelNode?.textContent).toContain("编译器");
    expect(panelNode?.textContent).toContain("数据管线");
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
    ).toContain("1 个组件");
    expect(
      shadow?.querySelector("[data-elfui-devtools=compiler-json]")?.textContent,
    ).toContain("ELF_COUNTER_HINT");
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

  it("previews a selected element style without mutating the business node", async () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-style-panel-card");
    const root = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "Publish";
    button.style.cssText = "background-color:white;color:black";
    root.append(button);
    document.body.append(host);
    bridge.registerComponent({
      id: "component:style-panel",
      host,
      tag: "elf-style-panel-card",
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 24,
      y: 40,
      width: 112,
      height: 40,
    } as DOMRect);
    const before = button.outerHTML;
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
      tool.value = "style";
      tool.dispatchEvent(new Event("change"));
    }
    await vi.waitFor(() => {
      expect(
        shadow?.querySelector<HTMLInputElement>(
          '[aria-label="Style preview CSS value"]',
        )?.disabled,
      ).toBe(false);
    });
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 30,
        clientY: 48,
      }),
    );
    const valueInput = await vi.waitFor(() => {
      const element = shadow?.querySelector<HTMLInputElement>(
        '[aria-label="Style preview CSS value"]',
      );
      expect(
        shadow?.querySelector('[data-elfui-devtools="visual-draft"]')
          ?.textContent,
      ).toContain("目标：");
      return element;
    });
    if (valueInput) {
      valueInput.value = "rgb(15, 118, 110)";
      valueInput.dispatchEvent(new Event("input"));
    }
    const preview = shadow?.querySelector<HTMLButtonElement>(
      '[aria-label="Preview selected element style"]',
    );
    expect(preview?.disabled).toBe(false);
    preview?.click();

    expect(button.outerHTML).toBe(before);
    expect(
      document
        .querySelector<HTMLElement>(
          "[data-elfui-devtools=visual-style-preview]",
        )
        ?.style.getPropertyValue("background-color"),
    ).toBe("rgb(15, 118, 110)");
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toContain("visual.style.preview");
    expect(
      window.sessionStorage.getItem("elfui-devtools:visual-draft:v1"),
    ).toContain("background-color");
    panel.dispose();
  });

  it("previews structured motion and carries it into the AI request", async () => {
    const bridge = createDevtoolsBridge();
    const host = document.createElement("elf-motion-panel-card");
    const root = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "Open menu";
    root.append(button);
    document.body.append(host);
    bridge.registerComponent({
      id: "component:motion-panel",
      host,
      tag: "elf-motion-panel-card",
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 32,
      y: 54,
      width: 120,
      height: 40,
    } as DOMRect);
    const before = button.outerHTML;
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
      tool.value = "motion";
      tool.dispatchEvent(new Event("change"));
    }
    await vi.waitFor(() => {
      expect(
        shadow?.querySelector<HTMLInputElement>(
          '[aria-label="Motion CSS properties"]',
        )?.disabled,
      ).toBe(false);
    });
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 40,
        clientY: 62,
      }),
    );
    await vi.waitFor(() => {
      expect(
        shadow?.querySelector('[data-elfui-devtools="visual-draft"]')
          ?.textContent,
      ).toContain("目标：");
    });
    const properties = shadow?.querySelector<HTMLInputElement>(
      '[aria-label="Motion CSS properties"]',
    );
    const trigger = shadow?.querySelector<HTMLSelectElement>(
      '[aria-label="Motion trigger"]',
    );
    const duration = shadow?.querySelector<HTMLInputElement>(
      '[aria-label="Motion duration milliseconds"]',
    );
    const delay = shadow?.querySelector<HTMLInputElement>(
      '[aria-label="Motion delay milliseconds"]',
    );
    const easing = shadow?.querySelector<HTMLSelectElement>(
      '[aria-label="Motion easing"]',
    );
    const reducedMotion = shadow?.querySelector<HTMLInputElement>(
      '[aria-label="Respect reduced motion"]',
    );
    if (properties) {
      properties.value = "opacity, transform";
      properties.dispatchEvent(new Event("input"));
    }
    if (trigger) {
      trigger.value = "hover";
      trigger.dispatchEvent(new Event("change"));
    }
    if (duration) {
      duration.value = "320";
      duration.dispatchEvent(new Event("input"));
    }
    if (delay) {
      delay.value = "40";
      delay.dispatchEvent(new Event("input"));
    }
    if (easing) {
      easing.value = "cubic-bezier(0.2, 0, 0, 1)";
      easing.dispatchEvent(new Event("change"));
    }
    if (reducedMotion) {
      reducedMotion.checked = false;
      reducedMotion.dispatchEvent(new Event("change"));
    }
    const preview = shadow?.querySelector<HTMLButtonElement>(
      '[aria-label="Preview selected element motion"]',
    );
    expect(preview?.disabled).toBe(false);
    preview?.click();

    expect(button.outerHTML).toBe(before);
    expect(
      document.querySelector("[data-elfui-devtools=visual-motion-preview]")
        ?.textContent,
    ).toContain(
      "opacity, transform · hover · 320ms + 40ms · cubic-bezier(0.2, 0, 0, 1) · always-motion",
    );
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toContain("visual.motion.preview");

    const prepare = await vi.waitFor(() => {
      const element = shadow?.querySelector<HTMLButtonElement>(
        '[aria-label="Prepare AI change request"]',
      );
      expect(element?.disabled).toBe(false);
      return element;
    });
    prepare?.click();
    const requestRecord = await vi.waitFor(() => {
      const record = bridge
        .getPipelineState()
        .records.find((candidate) => candidate.kind === "ai.request.create");
      expect(record).toBeDefined();
      return record;
    });
    const serializedRequest = JSON.stringify(requestRecord?.payload);
    for (const fact of [
      "intents",
      "motion",
      "hover",
      "durationMs",
      "320",
      "delayMs",
      "40",
      "cubic-bezier(0.2, 0, 0, 1)",
      "respectReducedMotion",
    ])
      expect(serializedRequest).toContain(fact);
    panel.dispose();
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

    const records = await vi.waitFor(() => {
      const current = bridge.getPipelineState().records;
      expect(current.map((record) => record.kind)).toContain(
        "ai.request.create",
      );
      return current;
    });
    expect(records.map((record) => record.kind)).toContain("ai.context.bundle");
    expect(records.map((record) => record.kind)).toContain("ai.request.create");
    expect(
      shadow?.querySelector('[data-elfui-devtools="pipeline-json"]')
        ?.textContent,
    ).toContain("ai-change:");
    panel.dispose();
  });

  it("renders read-only AI conversations and requires explicit source approval", async () => {
    const bridge = createDevtoolsBridge({ now: () => 92 });
    for (const [revision, sourceId] of [
      [1, "src/One.elf"],
      [2, "src/Two.elf"],
    ] as const)
      bridge.ingestCompilerArtifact({
        revision,
        capturedAt: revision,
        id: sourceId,
        sourceId,
        kind: "metadata",
        payload: {
          schemaVersion: 2,
          sourceId,
          components: [],
        },
      });
    const sourceReader = vi
      .fn()
      .mockImplementation(async ({ sourceId }: { sourceId: string }) => {
        const content =
          sourceId === "src/One.elf"
            ? 'const apiKey = "secret-value";\nexport const one = true;'
            : "export const two = true;";
        return {
          sourceId,
          range: { startLine: 1, endLine: 2 },
          content,
          totalLines: 2,
          characterCount: content.length,
          truncated: false,
        };
      });
    const panel = new DevtoolsPanel(
      bridge,
      document,
      undefined,
      undefined,
      undefined,
      sourceReader,
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

    const conversation = await vi.waitFor(() => {
      const current = shadow?.querySelector(
        '[data-elfui-devtools="ai-conversation"]',
      );
      expect(current).not.toBeNull();
      return current;
    });
    expect(conversation?.textContent).toContain("尚未连接模型");
    expect(conversation?.textContent).toContain("源码 0/12 块");
    expect(conversation?.textContent).toContain("省略 2 项");
    expect(conversation?.textContent).toContain("src/One.elf");
    expect(conversation?.textContent).toContain("src/Two.elf");
    expect(
      shadow
        ?.querySelector<HTMLButtonElement>(
          '[aria-label="AI conversation mode explain"]',
        )
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      shadow?.querySelector('[data-elfui-devtools="ai-conversation-messages"]')
        ?.textContent,
    ).toContain("1 个稳定引用");
    expect(
      shadow
        ?.querySelector('[data-elfui-devtools="ai-workflow"]')
        ?.getAttribute("data-stage"),
    ).toBe("request");
    expect(
      shadow?.querySelector('[data-elfui-devtools="ai-workflow"]')?.textContent,
    ).toContain("AI 工作流");

    const approveOne = shadow?.querySelector<HTMLInputElement>(
      '[aria-label="Approve source src/One.elf"]',
    );
    if (approveOne) {
      approveOne.checked = true;
      approveOne.dispatchEvent(new Event("change"));
    }
    const approveSelected = shadow?.querySelector<HTMLButtonElement>(
      '[aria-label="Approve selected source context"]',
    );
    expect(approveSelected?.disabled).toBe(false);
    approveSelected?.click();

    await vi.waitFor(() => {
      expect(sourceReader).toHaveBeenCalledWith({
        sourceId: "src/One.elf",
      });
      expect(
        shadow?.querySelector('[data-elfui-devtools="ai-context-governance"]')
          ?.textContent,
      ).toContain("源码 1/12 块");
    });
    expect(
      shadow?.querySelector('[data-elfui-devtools="ai-context-governance"]')
        ?.textContent,
    ).toContain("已批准 1 个额外 sourceId");
    expect(
      shadow?.querySelector('[data-elfui-devtools="ai-context-governance"]')
        ?.textContent,
    ).toContain("脱敏 1 处");
    expect(
      shadow?.querySelector('[data-elfui-devtools="ai-source-read-status"]')
        ?.textContent,
    ).toContain("已读取 1 个最小源码片段");
    expect(
      shadow?.querySelector('[data-elfui-devtools="ai-source-approval"]')
        ?.textContent,
    ).toContain("src/Two.elf");
    expect(
      shadow?.querySelector('[data-elfui-devtools="ai-source-approval"]')
        ?.textContent,
    ).not.toContain("src/One.elf");

    const requestRecords = bridge
      .getPipelineState()
      .records.filter((record) => record.kind === "ai.request.create");
    expect(requestRecords).toHaveLength(2);
    const approvedRequestPayload = JSON.stringify(
      requestRecords.at(-1)?.payload,
    );
    expect(approvedRequestPayload).toContain(
      "source-context:compiler:src/One.elf",
    );
    expect(approvedRequestPayload).toContain("approvedSourceIds");
    expect(approvedRequestPayload).toContain("pendingSourceApprovals");
    expect(approvedRequestPayload).toContain("src/Two.elf");
    expect(approvedRequestPayload).toContain("[REDACTED]");
    expect(approvedRequestPayload).not.toContain("secret-value");
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toContain("ai.context.approval");
    const retentionRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "ai.conversation.retention");
    expect(retentionRecord).toMatchObject({
      stage: "ai-request",
      source: "ai",
    });
    const retentionPayload = JSON.stringify(retentionRecord?.payload);
    expect(retentionPayload).toContain("maxRequestHistoryPerMode");
    expect(retentionPayload).toContain("sourceContentPersisted");
    expect(retentionPayload).toContain("screenshotDataPersisted");
    expect(retentionPayload).toContain("ai-change:");
    expect(retentionPayload).not.toContain("secret-value");
    expect(retentionPayload).not.toContain("export const one");

    const planMode = await vi.waitFor(() => {
      const button = shadow?.querySelector<HTMLButtonElement>(
        '[aria-label="AI conversation mode plan"]',
      );
      expect(button).not.toBeNull();
      return button;
    });
    planMode?.click();
    expect(
      shadow
        ?.querySelector<HTMLButtonElement>(
          '[aria-label="AI conversation mode plan"]',
        )
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      shadow?.querySelector('[data-elfui-devtools="ai-conversation"]')
        ?.textContent,
    ).toContain("生成请求后可在此检查会话引用和上下文范围。");
    shadow
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Prepare AI change request"]',
      )
      ?.click();
    await vi.waitFor(() => {
      expect(
        shadow?.querySelector(
          '[data-elfui-devtools="ai-conversation-messages"]',
        )?.textContent,
      ).toContain("基于当前视觉草稿整理可审核的实现方案。");
    });
    expect(
      bridge
        .getPipelineState()
        .records.filter((record) => record.kind === "ai.conversation.create"),
    ).toHaveLength(2);
    expect(
      bridge
        .getPipelineState()
        .records.some(
          (record) =>
            record.stage === "provider-request" || record.source === "provider",
        ),
    ).toBe(false);
    panel.dispose();
  });

  it("streams readonly AI output and recovers from a retryable failure", async () => {
    const bridge = createDevtoolsBridge({ now: () => 94 });
    let executionCount = 0;
    const execute = vi.fn(async function* (request: {
      executionId: string;
      mode: "explain" | "plan";
      changeRequest: AIChangeRequest;
    }) {
      executionCount += 1;
      yield {
        schemaVersion: 1 as const,
        type: "started" as const,
        executionId: request.executionId,
        sequence: 1,
        at: 1,
        providerId: "test-provider",
        mode: request.mode,
        context: {
          sourceBlocks: 0,
          sourceCharacters: 0,
          redactions: 0,
          omissions: 0,
        },
      };
      yield {
        schemaVersion: 1 as const,
        type: "text-delta" as const,
        executionId: request.executionId,
        sequence: 2,
        at: 2,
        text: executionCount === 1 ? "部分结果" : "恢复后的完整解释",
      };
      if (executionCount === 1)
        yield {
          schemaVersion: 1 as const,
          type: "failed" as const,
          executionId: request.executionId,
          sequence: 3,
          at: 3,
          error: {
            code: "AI_RATE_LIMITED",
            message: "请稍后重试",
            retryable: true,
          },
        };
      else {
        yield {
          schemaVersion: 1 as const,
          type: "reference" as const,
          executionId: request.executionId,
          sequence: 3,
          at: 3,
          reference: {
            kind: "annotation" as const,
            id: request.changeRequest.annotations[0]!.id,
            label: "rectangle annotation",
          },
        };
        yield {
          schemaVersion: 1 as const,
          type: "completed" as const,
          executionId: request.executionId,
          sequence: 4,
          at: 4,
          finishReason: "stop" as const,
        };
      }
    });
    const panel = new DevtoolsPanel(
      bridge,
      document,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        execute,
        cancel: vi.fn().mockResolvedValue(undefined),
        listProviders: vi.fn().mockResolvedValue({
          schemaVersion: 1,
          defaultProviderId: "test-provider",
          providers: [
            {
              id: "test-provider",
              label: "Test Provider",
              capabilities: {
                text: true,
                imageInput: false,
                toolCalling: false,
                structuredOutput: false,
                reasoning: false,
                temperature: true,
              },
              models: [{ id: "test-model", label: "Test Model" }],
              defaultModelId: "test-model",
            },
          ],
        }),
      },
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
    const run = await vi.waitFor(() => {
      const button = shadow?.querySelector<HTMLButtonElement>(
        '[aria-label="Run AI execution"]',
      );
      expect(button).not.toBeNull();
      return button;
    });
    expect(
      shadow?.querySelector<HTMLSelectElement>('[aria-label="AI provider"]')
        ?.value,
    ).toBe("test-provider");
    expect(
      shadow?.querySelector<HTMLInputElement>('[aria-label="AI model ID"]')
        ?.value,
    ).toBe("test-model");
    expect(
      shadow?.querySelector('[data-elfui-devtools="ai-provider-config"]')
        ?.textContent,
    ).toContain("图片 降级");
    run?.click();

    await vi.waitFor(() => {
      expect(
        shadow?.querySelector(
          '[data-elfui-devtools="ai-conversation-messages"]',
        )?.textContent,
      ).toContain("AI_RATE_LIMITED");
      expect(
        shadow?.querySelector<HTMLButtonElement>(
          '[aria-label="Retry AI execution"]',
        )?.textContent,
      ).toBe("重试");
    });
    shadow
      ?.querySelector<HTMLButtonElement>('[aria-label="Retry AI execution"]')
      ?.click();
    await vi.waitFor(() => {
      expect(
        shadow?.querySelector(
          '[data-elfui-devtools="ai-conversation-messages"]',
        )?.textContent,
      ).toContain("恢复后的完整解释");
      expect(
        shadow?.querySelector(
          '[data-elfui-devtools="ai-conversation-messages"]',
        )?.textContent,
      ).toContain("completed");
    });
    const replyReference = shadow?.querySelector<HTMLButtonElement>(
      '[data-elfui-devtools="ai-message-references"] [data-reference-kind="annotation"]',
    );
    expect(replyReference?.textContent).toContain("rectangle annotation");
    replyReference?.click();
    expect(
      bridge
        .getPipelineState()
        .records.some((record) => record.kind === "ai.reference.trace"),
    ).toBe(true);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      retryOfExecutionId: expect.stringContaining("ai-execution:"),
    });
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toEqual(
      expect.arrayContaining([
        "ai.execution.start",
        "ai.execution.text-delta",
        "ai.execution.reference",
        "ai.execution.failed",
        "ai.execution.retry",
        "ai.execution.completed",
        "ai.execution.result",
      ]),
    );
    panel.dispose();
  });

  it("reviews a Node-owned PatchProposal and records approval without applying files", async () => {
    const bridge = createDevtoolsBridge({ now: () => 96 });
    const reviewFor = (requestId: string) => ({
      schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
      proposal: {
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        id: "proposal:panel",
        requestId,
        summary: "Move the selected item into the approved group.",
        assumptions: ["Keep the public component API unchanged."],
        affectedFiles: ["src/Panel.ts"],
        baseFileHashes: { "src/Panel.ts": "a".repeat(64) },
        unifiedDiff:
          "diff --git a/src/Panel.ts b/src/Panel.ts\n--- a/src/Panel.ts\n+++ b/src/Panel.ts\n@@ -1 +1 @@\n-old\n+new\n",
        validationPlan: [
          {
            id: "validation:typecheck",
            kind: "typecheck" as const,
            required: true,
            files: ["src/Panel.ts"],
          },
        ],
        risk: "low" as const,
      },
      status: "pending" as const,
      decisions: [],
      createdAt: 10,
      updatedAt: 10,
    });
    const reviews = new Map<string, PatchProposalReview>();
    let proposalRequestId: string | null = null;
    const listPatchProposals = vi.fn(async (requestId: string) => {
      if (proposalRequestId && requestId !== proposalRequestId)
        return {
          schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
          requestId,
          proposals: [],
        };
      proposalRequestId ??= requestId;
      const review = reviews.get(requestId) ?? reviewFor(requestId);
      reviews.set(requestId, review);
      return {
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        requestId,
        proposals: [review],
      };
    });
    const decidePatchProposal = vi.fn(
      async (input: PatchProposalDecisionRequest) => {
        const pending = reviewFor(input.requestId);
        const decided: PatchProposalReview = {
          ...pending,
          status: "approved" as const,
          decisions: [
            {
              schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
              id: "approval:panel",
              proposalId: input.proposalId,
              requestId: input.requestId,
              decision: "approve" as const,
              approvedFiles: [...pending.proposal.affectedFiles],
              approvedFileHashes: { ...pending.proposal.baseFileHashes },
              ...(input.comment ? { comment: input.comment } : {}),
              createdAt: 11,
            },
          ],
          updatedAt: 11,
        };
        reviews.set(input.requestId, decided);
        return decided;
      },
    );
    const rollbackPatchApplication = vi.fn(
      async (input: {
        applicationId: string;
        verificationId: string;
        proposalId: string;
        requestId: string;
      }) => ({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        ...input,
        approvalId: "approval:panel",
        status: "rolled-back" as const,
        reason: "user" as const,
        files: ["src/Panel.ts"],
        restoredFileHashes: { "src/Panel.ts": "a".repeat(64) },
        rolledBackAt: 13,
      }),
    );
    let proposalExecutionCount = 0;
    const execute = vi.fn(async function* (request: {
      executionId: string;
      mode: "explain" | "plan";
      changeRequest: { id: string };
    }) {
      proposalExecutionCount += 1;
      yield {
        schemaVersion: 1 as const,
        type: "started" as const,
        executionId: request.executionId,
        sequence: 1,
        at: 1,
        providerId: "proposal-provider",
        mode: request.mode,
        context: {
          sourceBlocks: 0,
          sourceCharacters: 0,
          redactions: 0,
          omissions: 0,
        },
      };
      if (proposalExecutionCount > 1) {
        yield {
          schemaVersion: 1 as const,
          type: "tool-call" as const,
          executionId: request.executionId,
          sequence: 2,
          at: 2,
          call: {
            id: "call:apply",
            name: "patch.applyApproved",
            arguments:
              '{"proposalId":"proposal:panel","approvalId":"approval:panel"}',
          },
        };
        yield {
          schemaVersion: 1 as const,
          type: "tool-result" as const,
          executionId: request.executionId,
          sequence: 3,
          at: 3,
          callId: "call:apply",
          name: "patch.applyApproved" as const,
          status: "completed" as const,
          outputCharacters: 512,
        };
        yield {
          schemaVersion: 1 as const,
          type: "patch-verification" as const,
          executionId: request.executionId,
          sequence: 4,
          at: 4,
          verification: {
            verificationId: "verification:panel",
            applicationId: "application:panel",
            proposalId: "proposal:panel",
            approvalId: "approval:panel",
            requestId: request.changeRequest.id,
            status: "verified" as const,
            files: [
              {
                sourceId: "src/Panel.ts",
                beforeHash: "a".repeat(64),
                afterHash: "b".repeat(64),
              },
            ],
            checks: [
              "format",
              "typecheck",
              "test-scoped",
              "build",
              "hmr",
              "diagnostics",
            ].map((step) => ({
              step: step as
                | "format"
                | "typecheck"
                | "test-scoped"
                | "build"
                | "hmr"
                | "diagnostics",
              status:
                step === "build" ? ("skipped" as const) : ("passed" as const),
              required: step !== "build",
              summary: `${step} safe summary`,
              durationMs: 1,
            })),
            diagnostics: [
              {
                step: "diagnostics" as const,
                severity: "warning" as const,
                code: "VERIFY_HINT",
                message: "Safe diagnostic summary",
                sourceId: "src/Panel.ts",
              },
            ],
            diagnosticsTruncated: false,
            appliedAt: 11,
            startedAt: 10,
            completedAt: 12,
          },
        };
        yield {
          schemaVersion: 1 as const,
          type: "completed" as const,
          executionId: request.executionId,
          sequence: 5,
          at: 5,
          finishReason: "stop" as const,
        };
        return;
      }
      yield {
        schemaVersion: 1 as const,
        type: "tool-call" as const,
        executionId: request.executionId,
        sequence: 2,
        at: 2,
        call: {
          id: "call:prepare",
          name: "patch.prepare",
          arguments: "{}",
        },
      };
      yield {
        schemaVersion: 1 as const,
        type: "tool-result" as const,
        executionId: request.executionId,
        sequence: 3,
        at: 3,
        callId: "call:prepare",
        name: "patch.prepare" as const,
        status: "completed" as const,
        outputCharacters: 120,
      };
      yield {
        schemaVersion: 1 as const,
        type: "completed" as const,
        executionId: request.executionId,
        sequence: 4,
        at: 4,
        finishReason: "stop" as const,
      };
    });
    const captureResultScreenshot = vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,UkVTVUxU",
      mimeType: "image/png" as const,
      width: 390,
      height: 844,
      devicePixelRatio: 1,
    });
    const panel = new DevtoolsPanel(
      bridge,
      document,
      undefined,
      undefined,
      { capture: captureResultScreenshot },
      undefined,
      {
        execute,
        cancel: vi.fn().mockResolvedValue(undefined),
        listPatchProposals,
        decidePatchProposal,
        rollbackPatchApplication,
      },
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
    const screenshotPhase = shadow?.querySelector<HTMLSelectElement>(
      '[aria-label="Screenshot phase"]',
    );
    if (screenshotPhase) {
      screenshotPhase.value = "before";
      screenshotPhase.dispatchEvent(new Event("change"));
    }
    shadow
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Capture visual screenshot"]',
      )
      ?.click();
    await vi.waitFor(() => {
      expect(captureResultScreenshot).toHaveBeenCalledTimes(1);
      expect(
        shadow?.querySelector<HTMLButtonElement>(
          '[aria-label="Capture visual screenshot"]',
        )?.disabled,
      ).toBe(false);
    });
    const desiredScreenshotPhase = shadow?.querySelector<HTMLSelectElement>(
      '[aria-label="Screenshot phase"]',
    );
    if (desiredScreenshotPhase) {
      desiredScreenshotPhase.value = "desired";
      desiredScreenshotPhase.dispatchEvent(new Event("change"));
    }
    shadow
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Capture visual screenshot"]',
      )
      ?.click();
    await vi.waitFor(() => {
      expect(captureResultScreenshot).toHaveBeenCalledTimes(2);
      expect(
        shadow?.querySelector('[data-elfui-devtools="visual-draft"]')
          ?.textContent,
      ).toContain("2 张截图");
    });
    const prepareInitialRequest = shadow?.querySelector<HTMLButtonElement>(
      '[aria-label="Prepare AI change request"]',
    );
    expect(prepareInitialRequest).not.toBeNull();
    prepareInitialRequest?.click();

    const proposalPlanMode = await vi.waitFor(() => {
      const button = shadow?.querySelector<HTMLButtonElement>(
        '[aria-label="AI conversation mode plan"]',
      );
      expect(button).not.toBeNull();
      return button;
    });
    proposalPlanMode?.click();
    expect(
      shadow
        ?.querySelector<HTMLButtonElement>(
          '[aria-label="AI conversation mode plan"]',
        )
        ?.getAttribute("aria-pressed"),
    ).toBe("true");

    const preparePlan = shadow?.querySelector<HTMLButtonElement>(
      '[aria-label="Prepare AI change request"]',
    );
    expect(preparePlan).not.toBeNull();
    preparePlan?.click();
    const run = await vi.waitFor(() => {
      const button = shadow?.querySelector<HTMLButtonElement>(
        '[aria-label="Run AI execution"]',
      );
      expect(button).not.toBeNull();
      return button;
    });
    await vi.waitFor(() => {
      expect(listPatchProposals).toHaveBeenCalled();
      expect(
        shadow
          ?.querySelector<HTMLButtonElement>(
            '[aria-label="AI conversation mode plan"]',
          )
          ?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        shadow?.querySelector('[data-elfui-devtools="ai-patch-proposals"]'),
      ).not.toBeNull();
    });
    run?.click();

    const proposalCard = await vi.waitFor(() => {
      const card = shadow?.querySelector<HTMLElement>(
        '[data-elfui-devtools="ai-patch-proposal"]',
      );
      expect(card).not.toBeNull();
      return card;
    });
    expect(proposalCard?.textContent).toContain(
      "Move the selected item into the approved group.",
    );
    expect(proposalCard?.textContent).toContain(
      "Keep the public component API unchanged.",
    );
    expect(
      proposalCard?.querySelector('[data-elfui-devtools="ai-patch-diff"]')
        ?.textContent,
    ).toContain("+new");
    const revise = proposalCard?.querySelector<HTMLButtonElement>(
      '[aria-label="Revise patch proposal proposal:panel"]',
    );
    expect(revise?.disabled).toBe(true);
    const comment = proposalCard?.querySelector<HTMLTextAreaElement>(
      '[aria-label="Patch proposal comment proposal:panel"]',
    );
    if (comment) {
      comment.value = "Keep the transition timing unchanged.";
      comment.dispatchEvent(new Event("input"));
    }
    expect(revise?.disabled).toBe(false);
    proposalCard
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Approve patch proposal proposal:panel"]',
      )
      ?.click();

    await vi.waitFor(() => {
      expect(
        shadow?.querySelector('[data-elfui-devtools="ai-patch-proposal"]')
          ?.textContent,
      ).toContain("已批准（尚未应用）");
    });
    expect(decidePatchProposal).toHaveBeenCalledWith({
      schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
      proposalId: "proposal:panel",
      requestId: expect.stringContaining("ai-change:"),
      decision: "approve",
      comment: "Keep the transition timing unchanged.",
    });
    expect(
      JSON.stringify(decidePatchProposal.mock.calls[0]?.[0]),
    ).not.toContain("unifiedDiff");
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toContain("ai.patch.proposal.approve");
    const approvalRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "ai.patch.proposal.approve");
    expect(JSON.stringify(approvalRecord?.payload)).toContain(
      '"key":"applied","value":{"kind":"primitive","value":false}',
    );

    const runApproved = await vi.waitFor(() => {
      const button = shadow?.querySelector<HTMLButtonElement>(
        '[aria-label="Run AI execution"]',
      );
      expect(button?.disabled).toBe(false);
      expect(button?.textContent).toBe("继续执行已批准 Patch");
      return button;
    });
    runApproved?.click();
    await vi.waitFor(() => {
      expect(proposalExecutionCount).toBe(2);
      expect(
        bridge.getPipelineState().records.map((record) => record.kind),
      ).toContain("patch.verification.verified");
    });
    const verificationRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "patch.verification.verified");
    expect(verificationRecord).toMatchObject({
      stage: "verification",
      source: "verification",
      diagnostics: [
        {
          severity: "warning",
          code: "VERIFY_HINT",
          message: "Safe diagnostic summary",
        },
      ],
    });
    expect(JSON.stringify(verificationRecord?.payload)).toContain(
      "verification:panel",
    );
    expect(JSON.stringify(verificationRecord?.payload)).toContain(
      "src/Panel.ts",
    );
    expect(JSON.stringify(verificationRecord?.payload)).not.toContain(
      "diff --git",
    );
    expect(
      shadow?.querySelector('[data-elfui-devtools="ai-patch-proposal"]')
        ?.textContent,
    ).toContain("已应用并验证");
    expect(
      shadow?.querySelector('[data-elfui-devtools="ai-patch-verification"]')
        ?.textContent,
    ).toContain("diagnostics · passed");
    expect(
      shadow?.querySelector('[data-elfui-devtools="ai-source-read-status"]')
        ?.textContent,
    ).toContain("已应用");
    const captureResult = shadow?.querySelector<HTMLButtonElement>(
      '[aria-label="Capture patch result screenshot proposal:panel"]',
    );
    expect(captureResult?.textContent).toBe("捕获结果截图");
    captureResult?.click();
    await vi.waitFor(() => {
      expect(captureResultScreenshot).toHaveBeenCalledTimes(3);
      expect(captureResultScreenshot).toHaveBeenLastCalledWith({
        kind: "viewport",
        excludedRegions: expect.any(Array),
      });
      expect(
        shadow?.querySelector('[data-elfui-devtools="ai-source-read-status"]')
          ?.textContent,
      ).toContain("已捕获");
      expect(
        bridge.getPipelineState().records.map((record) => record.kind),
      ).toContain("visual.result.capture");
    });
    const resultRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "visual.result.capture");
    const resultPayload = JSON.stringify(resultRecord?.payload);
    expect(resultRecord).toMatchObject({
      taskId: expect.stringContaining("ai-change:"),
      stage: "verification",
      source: "visual-tools",
    });
    expect(resultPayload).toContain("verification:panel");
    expect(resultPayload).toContain("application:panel");
    expect(resultPayload).toContain("proposal:panel");
    expect(resultPayload).toContain('"value":"result"');
    expect(resultPayload).not.toContain("data:image/png");
    expect(
      shadow?.querySelector(
        '[data-elfui-devtools="ai-patch-result-screenshot"]',
      )?.textContent,
    ).toContain("390×844");
    expect(
      shadow?.querySelector(
        '[data-elfui-devtools="ai-patch-result-screenshot"]',
      )?.textContent,
    ).toContain("关联 2 张");
    const comparison = shadow?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-patch-comparison"]',
    );
    expect(comparison?.textContent).toContain("修改前");
    expect(comparison?.textContent).toContain("期望效果");
    expect(comparison?.textContent).toContain("应用结果");
    expect(comparison?.querySelectorAll("img")).toHaveLength(3);
    expect(
      shadow?.querySelector('[data-elfui-devtools="visual-draft"]')
        ?.textContent,
    ).toContain("2 张截图");
    const visualReview = shadow?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-visual-result-review"]',
    );
    expect(visualReview?.textContent).toContain("意图与标注核对");
    expect(
      visualReview?.querySelector(
        '[data-elfui-devtools="ai-visual-result-review-summary"]',
      )?.textContent,
    ).toContain("待核对 1");
    const annotationReview = visualReview?.querySelector<HTMLSelectElement>(
      '[data-reference-kind="annotation"] select',
    );
    expect(annotationReview).not.toBeNull();
    if (annotationReview) {
      annotationReview.value = "met";
      annotationReview.dispatchEvent(new Event("change"));
    }
    await vi.waitFor(() => {
      expect(
        shadow?.querySelector(
          '[data-elfui-devtools="ai-visual-result-review-summary"]',
        )?.textContent,
      ).toContain("已满足 1");
      expect(
        shadow
          ?.querySelector(
            '[data-elfui-devtools="ai-visual-result-review-item"]',
          )
          ?.getAttribute("data-status"),
      ).toBe("met");
    });
    const visualReviewRecords = bridge
      .getPipelineState()
      .records.filter((record) =>
        record.kind.startsWith("visual.result.review"),
      );
    expect(visualReviewRecords.map((record) => record.kind)).toEqual([
      "visual.result.review.created",
      "visual.result.review.updated",
    ]);
    expect(JSON.stringify(visualReviewRecords)).not.toContain("data:image/png");
    const acceptVisualResult = shadow?.querySelector<HTMLButtonElement>(
      '[aria-label="Accept visual result proposal:panel"]',
    );
    const partialAcceptVisualResult = shadow?.querySelector<HTMLButtonElement>(
      '[aria-label="Partially accept visual result proposal:panel"]',
    );
    expect(acceptVisualResult?.disabled).toBe(false);
    expect(partialAcceptVisualResult?.disabled).toBe(true);
    acceptVisualResult?.click();
    await vi.waitFor(() => {
      expect(
        shadow?.querySelector(
          '[data-elfui-devtools="ai-visual-round-decision"][data-action="accept"]',
        ),
      ).not.toBeNull();
      expect(
        bridge.getPipelineState().records.map((record) => record.kind),
      ).toContain("visual.result.decision.accept");
    });
    shadow
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Revert visual result proposal:panel"]',
      )
      ?.click();
    await vi.waitFor(() => {
      expect(rollbackPatchApplication).toHaveBeenCalledWith({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        applicationId: "application:panel",
        verificationId: "verification:panel",
        proposalId: "proposal:panel",
        requestId: expect.stringContaining("ai-change:"),
      });
      expect(
        shadow?.querySelector('[data-elfui-devtools="ai-patch-proposal"]')
          ?.textContent,
      ).toContain("已由用户撤销");
      expect(
        bridge.getPipelineState().records.map((record) => record.kind),
      ).toContain("visual.result.decision.revert");
      expect(
        shadow?.querySelector(
          '[data-elfui-devtools="ai-visual-round-decision"][data-action="revert"]',
        ),
      ).not.toBeNull();
    });
    const regenerate = shadow?.querySelector<HTMLButtonElement>(
      '[aria-label="Regenerate visual result proposal:panel"]',
    );
    expect(regenerate?.disabled).toBe(false);
    regenerate?.click();
    await vi.waitFor(() => {
      expect(
        shadow?.querySelector('[data-elfui-devtools="ai-follow-up-context"]')
          ?.textContent,
      ).toContain("未满足 1");
      expect(
        shadow?.querySelector('[data-elfui-devtools="ai-context-governance"]')
          ?.textContent,
      ).toContain("截图 3 张");
      expect(
        shadow?.querySelector(
          '[data-elfui-devtools="ai-patch-proposals"][data-round="previous"]',
        ),
      ).not.toBeNull();
    });
    const followUpRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "ai.context.follow-up");
    const followUpPayload = JSON.stringify(followUpRecord?.payload);
    expect(followUpPayload).toContain('"value":"unmet"');
    expect(followUpPayload).toContain("verification:panel");
    expect(followUpPayload).toContain('"value":"screenshot:');
    expect(followUpPayload).not.toContain("data:image/png");
    expect(
      bridge
        .getPipelineState()
        .records.map((record) => record.kind)
        .filter((kind) => kind.startsWith("visual.result.decision.")),
    ).toEqual([
      "visual.result.decision.accept",
      "visual.result.decision.revert",
      "visual.result.decision.regenerate",
    ]);
    expect(
      shadow?.querySelector('[data-elfui-devtools="visual-draft"]')
        ?.textContent,
    ).toContain("2 张截图");
    shadow
      ?.querySelector<HTMLButtonElement>(
        '[data-elfui-devtools="ai-patch-proposals"][data-round="previous"] [aria-label^="Activate AI request ai-change:"]',
      )
      ?.click();
    await vi.waitFor(() => {
      expect(
        shadow?.querySelector(
          '[data-elfui-devtools="ai-patch-proposals"][data-round="current"] [data-elfui-devtools="ai-patch-proposal"]',
        ),
      ).not.toBeNull();
      expect(
        shadow?.querySelector('[data-elfui-devtools="ai-follow-up-context"]'),
      ).toBeNull();
    });
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toContain("ai.conversation.round.select");
    expect(rollbackPatchApplication).toHaveBeenCalledTimes(1);
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toContain("patch.rollback.user");
    expect(
      shadow?.querySelector<HTMLButtonElement>(
        '[aria-label="Run AI execution"]',
      )?.textContent,
    ).toBe("重试已批准 Patch");
    panel.dispose();
  });

  it("cancels a streaming readonly AI execution from the panel", async () => {
    const bridge = createDevtoolsBridge({ now: () => 95 });
    let releaseCancellation!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const execute = vi.fn(async function* (request: {
      executionId: string;
      mode: "explain" | "plan";
    }) {
      yield {
        schemaVersion: 1 as const,
        type: "started" as const,
        executionId: request.executionId,
        sequence: 1,
        at: 1,
        providerId: "test-provider",
        mode: request.mode,
        context: {
          sourceBlocks: 0,
          sourceCharacters: 0,
          redactions: 0,
          omissions: 0,
        },
      };
      await cancelled;
      yield {
        schemaVersion: 1 as const,
        type: "cancelled" as const,
        executionId: request.executionId,
        sequence: 2,
        at: 2,
        reason: "Cancelled by user",
      };
    });
    const cancel = vi.fn().mockImplementation(async () => {
      releaseCancellation();
    });
    const panel = new DevtoolsPanel(
      bridge,
      document,
      undefined,
      undefined,
      undefined,
      undefined,
      { execute, cancel },
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
    const run = await vi.waitFor(() => {
      const button = shadow?.querySelector<HTMLButtonElement>(
        '[aria-label="Run AI execution"]',
      );
      expect(button).not.toBeNull();
      return button;
    });
    run?.click();
    const cancelButton = await vi.waitFor(() => {
      const button = shadow?.querySelector<HTMLButtonElement>(
        '[aria-label="Cancel AI execution"]',
      );
      expect(button?.textContent).toBe("取消生成");
      return button;
    });
    cancelButton?.click();
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledOnce();
      expect(
        shadow?.querySelector(
          '[data-elfui-devtools="ai-conversation-messages"]',
        )?.textContent,
      ).toContain("cancelled");
    });
    expect(
      bridge.getPipelineState().records.map((record) => record.kind),
    ).toEqual(
      expect.arrayContaining([
        "ai.execution.cancel-request",
        "ai.execution.cancelled",
      ]),
    );
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
        "已截取修改前的当前视口 · 1280×720",
      );
    });
    shadow
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Prepare AI change request"]',
      )
      ?.click();

    const requestRecord = await vi.waitFor(() => {
      const record = bridge
        .getPipelineState()
        .records.find((item) => item.kind === "ai.request.create");
      expect(record).toBeDefined();
      return record;
    });
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
