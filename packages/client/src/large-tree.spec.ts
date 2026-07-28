import { afterEach, describe, expect, it } from "vitest";
import { createDevtoolsBridge } from "@elfui/devtools-runtime";

import { COMPONENT_TREE_VIRTUALIZE_THRESHOLD, DevtoolsPanel } from "./panel";

const COMPONENT_COUNT = 5_000;
const INITIAL_RENDER_BUDGET_MS = 2_500;
const SEARCH_RENDER_BUDGET_MS = 750;

describe("DevtoolsPanel large component tree", () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
  });

  it("virtualizes 5,000 components and keeps search within its budget", () => {
    const bridge = createDevtoolsBridge({ maxTimelineEvents: 50 });
    const root = document.createElement("elf-large-root");
    const rootId = bridge.registerComponent({
      id: "large:root",
      host: root,
      tag: "elf-large-root",
    });
    for (let index = 1; index < COMPONENT_COUNT; index += 1) {
      bridge.registerComponent({
        id: `large:${index}`,
        host: document.createElement("elf-large-item"),
        parentId: rootId,
        tag:
          index === COMPONENT_COUNT - 1 ? "elf-final-target" : "elf-large-item",
        displayName: `LargeItem${index}`,
      });
    }

    const renderStartedAt = performance.now();
    const panel = new DevtoolsPanel(bridge, document);
    const renderDuration = performance.now() - renderStartedAt;
    const shadow = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    )?.shadowRoot;
    const tree = shadow?.querySelector<HTMLElement>(
      "[data-elfui-devtools=component-tree]",
    );

    expect(COMPONENT_COUNT).toBeGreaterThan(
      COMPONENT_TREE_VIRTUALIZE_THRESHOLD,
    );
    expect(renderDuration).toBeLessThan(INITIAL_RENDER_BUDGET_MS);
    expect(tree?.dataset.virtualized).toBe("true");
    expect(Number(tree?.dataset.renderedRows)).toBeLessThan(40);
    expect(tree?.querySelectorAll(".component-row").length).toBeLessThan(40);

    const search = shadow?.querySelector<HTMLInputElement>(
      '[aria-label="Filter components"]',
    );
    const searchStartedAt = performance.now();
    if (search) {
      search.value = "final-target";
      search.dispatchEvent(new Event("input"));
    }
    const searchDuration = performance.now() - searchStartedAt;

    expect(searchDuration).toBeLessThan(SEARCH_RENDER_BUDGET_MS);
    expect(tree?.dataset.virtualized).toBe("false");
    expect(tree?.textContent).toContain("elf-large-root");
    expect(tree?.textContent).toContain("elf-final-target");
    expect(tree?.textContent).not.toContain("elf-large-item");
    panel.dispose();
  });
});
