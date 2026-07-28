import { DevtoolsPanel } from "../../packages/client/dist/index.js";
import { createDevtoolsBridge } from "../../packages/runtime/dist/index.js";

interface GateCheck {
  name: string;
  detail: string;
}

interface GateResult {
  ok: boolean;
  checks: GateCheck[];
  error?: string;
}

const templateNodeId = "src/BrowserGate.ts:component:button:7:5";
const renderRoots = new WeakMap<HTMLElement, ShadowRoot>();
const templateNodes = new WeakMap<Node, object>();
const buttons = new WeakMap<HTMLElement, HTMLButtonElement>();

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

class BrowserGateCard extends HTMLElement {
  public constructor() {
    super();
    const root = this.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Closed root action";
    button.style.cssText = [
      "width:220px",
      "height:48px",
      "border:0",
      "border-radius:12px",
      "background:#2563eb",
      "color:white",
      "font:600 15px system-ui",
      "cursor:pointer",
    ].join(";");
    root.append(button);
    renderRoots.set(this, root);
    templateNodes.set(button, {
      sourceId: "src/BrowserGate.ts",
      templateNodeId,
      source: {
        file: "src/BrowserGate.ts",
        line: 7,
        column: 5,
        endLine: 7,
        endColumn: 57,
      },
    });
    buttons.set(this, button);
  }
}

customElements.define("elf-browser-gate-card", BrowserGateCard);

const bridge = createDevtoolsBridge();
const fixture = document.querySelector("#fixture")!;
let host = document.createElement("elf-browser-gate-card");
fixture.append(host);
bridge.registerComponent({
  host,
  tag: "elf-browser-gate-card",
  source: { file: "src/BrowserGate.ts", line: 1, column: 1 },
});
const panel = new DevtoolsPanel(bridge, document);

const frame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

const assert = (
  condition: unknown,
  name: string,
  detail: string,
  checks: GateCheck[],
): void => {
  if (!condition) throw new Error(`${name}: ${detail}`);
  checks.push({ name, detail });
};

const report = async (result: GateResult): Promise<void> => {
  const results = document.querySelector<HTMLElement>("#results")!;
  results.dataset.status = result.ok ? "passed" : "failed";
  results.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = result.ok
    ? "P1 browser gate passed"
    : "P1 browser gate failed";
  const list = document.createElement("ol");
  for (const check of result.checks) {
    const item = document.createElement("li");
    item.textContent = `${check.name}: ${check.detail}`;
    list.append(item);
  }
  results.append(heading, list);
  if (result.error) {
    const error = document.createElement("pre");
    error.textContent = result.error;
    results.append(error);
  }
  await fetch("/__elfui_devtools_gate_result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
};

const run = async (): Promise<void> => {
  const checks: GateCheck[] = [];
  try {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "c",
        ctrlKey: true,
        shiftKey: true,
      }),
    );
    const button = buttons.get(host)!;
    button.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, composed: true }),
    );
    await frame();
    await frame();
    const overlay = document.querySelector<HTMLElement>(
      `[data-template-node-id="${templateNodeId}"]`,
    );
    assert(
      overlay?.dataset.sourcePrecision === "template-node",
      "registry-only closed root",
      "Inspector resolved the exact inner template node without host Symbol mirrors.",
      checks,
    );
    button.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
    assert(
      bridge
        .getPipelineState()
        .records.some((record) => record.kind === "element.select"),
      "closed-root selection",
      "The inner button produced an element.select target snapshot.",
      checks,
    );

    const previous = host;
    const replacement = document.createElement("elf-browser-gate-card");
    previous.replaceWith(replacement);
    bridge.unregisterComponent(previous);
    host = replacement;
    bridge.registerComponent({
      host,
      tag: "elf-browser-gate-card",
      source: { file: "src/BrowserGate.ts", line: 1, column: 1 },
    });
    await Promise.resolve();
    await frame();
    assert(
      bridge
        .getPipelineState()
        .records.some((record) => record.kind === "selection.restore"),
      "HMR selection recovery",
      "The component and template-node selection survived replacement.",
      checks,
    );

    const replacementButton = buttons.get(host)!;
    const originalBounds =
      replacementButton.getBoundingClientRect.bind(replacementButton);
    let layoutReads = 0;
    replacementButton.getBoundingClientRect = () => {
      layoutReads += 1;
      return originalBounds();
    };
    for (let index = 0; index < 25; index += 1)
      replacementButton.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, composed: true }),
      );
    await frame();
    await frame();
    replacementButton.getBoundingClientRect = originalBounds;
    assert(
      layoutReads === 1,
      "Inspector hover budget",
      `25 pointer moves were coalesced into ${layoutReads} layout read.`,
      checks,
    );
    panel.dispose();
    await report({ ok: true, checks });
  } catch (error) {
    panel.dispose();
    await report({
      ok: false,
      checks,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
};

void run();
