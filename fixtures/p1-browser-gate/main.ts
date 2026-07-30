import {
  createAIExecutionClient,
  DevtoolsPanel,
  type ReadSourceContext,
  type ScreenshotCaptureAdapter,
} from "../../packages/client/dist/index.js";
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
bridge.ingestCompilerArtifact({
  revision: 1,
  capturedAt: Date.now(),
  id: "src/Supporting.ts",
  sourceId: "src/Supporting.ts",
  kind: "metadata",
  payload: {
    schemaVersion: 2,
    sourceId: "src/Supporting.ts",
    components: [],
  },
});
bridge.ingestCompilerArtifact({
  revision: 2,
  capturedAt: Date.now(),
  id: "src/BrowserGate.ts:diagnostics",
  sourceId: "src/BrowserGate.ts",
  kind: "diagnostics",
  payload: [
    {
      severity: "info",
      code: "ELF_BROWSER_GATE_HINT",
      message: "Closed-root visual state is ready for AI review.",
      component: "elf-browser-gate-card",
      line: 7,
      column: 5,
    },
  ],
});
const fixture = document.querySelector("#fixture")!;
let host = document.createElement("elf-browser-gate-card");
fixture.append(host);
bridge.registerComponent({
  host,
  tag: "elf-browser-gate-card",
  source: { file: "src/BrowserGate.ts", line: 1, column: 1 },
});
const sourceReader: ReadSourceContext = async ({ sourceId, range }) => {
  const content =
    sourceId === "src/Supporting.ts"
      ? 'const apiKey = "browser-gate-secret";\nexport const gap = 8;'
      : "export const BrowserGateCard = true;";
  return {
    sourceId,
    range: range ?? { startLine: 1, endLine: 2 },
    content,
    totalLines: 2,
    characterCount: content.length,
    truncated: false,
  };
};
sessionStorage.removeItem("elfui-devtools:visual-draft:v1");
let screenshotCaptureCount = 0;
const resultScreenshotAdapter = {
  async capture(input) {
    screenshotCaptureCount += 1;
    const width =
      input.kind === "selection" && input.selection
        ? Math.max(1, Math.round(input.selection.width))
        : window.innerWidth;
    const height =
      input.kind === "selection" && input.selection
        ? Math.max(1, Math.round(input.selection.height))
        : window.innerHeight;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Browser gate result canvas unavailable");
    context.fillStyle = "#0f172a";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#bae6fd";
    context.font = "16px system-ui";
    context.fillText(
      screenshotCaptureCount === 1
        ? "ElfUI before"
        : screenshotCaptureCount === 2
          ? "ElfUI desired"
          : "Verified ElfUI Patch result",
      16,
      28,
    );
    return {
      dataUrl: canvas.toDataURL("image/png"),
      mimeType: "image/png" as const,
      width,
      height,
      devicePixelRatio: window.devicePixelRatio,
    };
  },
} satisfies ScreenshotCaptureAdapter;
const panel = new DevtoolsPanel(
  bridge,
  document,
  undefined,
  undefined,
  resultScreenshotAdapter,
  sourceReader,
  createAIExecutionClient("browser-gate-ai-capability"),
);

const frame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));
const settleVisualLifecycle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 40));

const assert = (
  condition: unknown,
  name: string,
  detail: string,
  checks: GateCheck[],
): void => {
  if (!condition) throw new Error(`${name}: ${detail}`);
  checks.push({ name, detail });
};

const matchesCssPixel = (value: string, expected: number): boolean => {
  const actual = Number.parseFloat(value);
  return Number.isFinite(actual) && Math.abs(actual - expected) <= 0.05;
};

const report = async (result: GateResult): Promise<void> => {
  const results = document.querySelector<HTMLElement>("#results")!;
  results.dataset.status = result.ok ? "passed" : "failed";
  results.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = result.ok
    ? "Browser gate passed"
    : "Browser gate failed";
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

const showDemoResult = (result: GateResult): void => {
  const results = document.querySelector<HTMLElement>("#results")!;
  results.dataset.status = result.ok ? "passed" : "failed";
  results.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = result.ok
    ? "Browser gate passed"
    : "Browser gate failed";
  results.append(heading);
  if (result.error) {
    const error = document.createElement("pre");
    error.textContent = result.error;
    results.append(error);
  }
};

const run = async (keepPanelOpen = false): Promise<void> => {
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

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "v",
        ctrlKey: true,
        shiftKey: true,
      }),
    );
    await frame();
    await frame();
    const panelRoot = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=host]",
    )?.shadowRoot;
    const visualTool = panelRoot?.querySelector<HTMLSelectElement>(
      '[aria-label="Visual draft tool"]',
    );
    assert(
      visualTool,
      "visual draft controls",
      "The real browser panel exposed the visual tool selector.",
      checks,
    );
    const themeControl = panelRoot?.querySelector<HTMLSelectElement>(
      '[aria-label="DevTools theme"]',
    );
    const panelElement = panelRoot?.querySelector<HTMLElement>(".panel");
    const panelHost = panelRoot?.host;
    if (themeControl && panelElement) {
      themeControl.value = "light";
      themeControl.dispatchEvent(new Event("change"));
      await frame();
      const lightBackground = getComputedStyle(panelElement).backgroundColor;
      themeControl.focus();
      const focusStyle = getComputedStyle(themeControl);
      themeControl.value = "dark";
      themeControl.dispatchEvent(new Event("change"));
      await frame();
      const darkBackground = getComputedStyle(panelElement).backgroundColor;
      assert(
        lightBackground === "rgb(255, 255, 255)" &&
          darkBackground === "rgb(15, 23, 42)" &&
          focusStyle.outlineStyle !== "none" &&
          panelHost instanceof HTMLElement &&
          panelHost.dataset.theme === "dark",
        "theme and keyboard focus",
        "The real browser panel switched complete surface tokens between light and dark themes and exposed a visible keyboard focus ring.",
        checks,
      );
    }
    visualTool!.value = "style";
    visualTool!.dispatchEvent(new Event("change"));
    await frame();
    await frame();
    const businessStyle = replacementButton.getAttribute("style");
    replacementButton.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 72,
        clientY: 190,
      }),
    );
    await frame();
    await frame();
    const capturedStyleTarget = bridge
      .getPipelineState()
      .records.filter((record) => record.kind === "visual.target.capture")
      .at(-1);
    assert(
      JSON.stringify(capturedStyleTarget?.payload).includes(templateNodeId),
      "closed-root visual precision",
      "Visual Draft preserved the inner template-node identity instead of falling back to the host.",
      checks,
    );
    const valueInput = panelRoot?.querySelector<HTMLInputElement>(
      '[aria-label="Style preview CSS value"]',
    );
    const previewStyle = panelRoot?.querySelector<HTMLButtonElement>(
      '[aria-label="Preview selected element style"]',
    );
    assert(
      valueInput && previewStyle,
      "style preview controls",
      "Selecting a closed-root element enabled CSS property and value controls.",
      checks,
    );
    valueInput!.value = "rgb(15, 118, 110)";
    valueInput!.dispatchEvent(new Event("input"));
    previewStyle!.click();
    const stylePreview = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=visual-style-preview]",
    );
    assert(
      stylePreview?.style.getPropertyValue("background-color") ===
        "rgb(15, 118, 110)",
      "overlay-only style preview",
      "The desired style rendered in the DevTools overlay.",
      checks,
    );
    assert(
      replacementButton.getAttribute("style") === businessStyle,
      "business DOM preservation",
      "The style preview did not mutate the inspected business element.",
      checks,
    );
    assert(
      bridge
        .getPipelineState()
        .records.some((record) => record.kind === "visual.style.preview") &&
        sessionStorage
          .getItem("elfui-devtools:visual-draft:v1")
          ?.includes("background-color"),
      "style intent persistence",
      "The style intent was observable and persisted for page refresh.",
      checks,
    );
    const motionTool = panelRoot?.querySelector<HTMLSelectElement>(
      '[aria-label="Visual draft tool"]',
    );
    motionTool!.value = "motion";
    motionTool!.dispatchEvent(new Event("change"));
    await frame();
    await frame();
    replacementButton.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        clientX: 72,
        clientY: 190,
      }),
    );
    await frame();
    await frame();
    const motionProperties = panelRoot?.querySelector<HTMLInputElement>(
      '[aria-label="Motion CSS properties"]',
    );
    const motionTrigger = panelRoot?.querySelector<HTMLSelectElement>(
      '[aria-label="Motion trigger"]',
    );
    const motionDuration = panelRoot?.querySelector<HTMLInputElement>(
      '[aria-label="Motion duration milliseconds"]',
    );
    const motionDelay = panelRoot?.querySelector<HTMLInputElement>(
      '[aria-label="Motion delay milliseconds"]',
    );
    const motionEasing = panelRoot?.querySelector<HTMLSelectElement>(
      '[aria-label="Motion easing"]',
    );
    const previewMotion = panelRoot?.querySelector<HTMLButtonElement>(
      '[aria-label="Preview selected element motion"]',
    );
    assert(
      motionProperties &&
        motionTrigger &&
        motionDuration &&
        motionDelay &&
        motionEasing &&
        previewMotion,
      "motion preview controls",
      "The closed-root target exposed structured transition controls.",
      checks,
    );
    motionProperties!.value = "opacity, transform";
    motionProperties!.dispatchEvent(new Event("input"));
    motionTrigger!.value = "hover";
    motionTrigger!.dispatchEvent(new Event("change"));
    motionDuration!.value = "320";
    motionDuration!.dispatchEvent(new Event("input"));
    motionDelay!.value = "40";
    motionDelay!.dispatchEvent(new Event("input"));
    motionEasing!.value = "cubic-bezier(0.2, 0, 0, 1)";
    motionEasing!.dispatchEvent(new Event("change"));
    previewMotion!.click();
    await frame();
    await frame();
    const motionPreview = document.querySelector<HTMLElement>(
      "[data-elfui-devtools=visual-motion-preview]",
    );
    assert(
      motionPreview?.textContent?.includes(
        "opacity, transform · hover · 320ms + 40ms · cubic-bezier(0.2, 0, 0, 1) · reduced-motion",
      ) &&
        replacementButton.getAttribute("style") === businessStyle &&
        bridge
          .getPipelineState()
          .records.some((record) => record.kind === "visual.motion.preview") &&
        sessionStorage
          .getItem("elfui-devtools:visual-draft:v1")
          ?.includes('"type":"motion"'),
      "overlay-only motion intent",
      "Structured timing rendered only in the DevTools overlay, entered the Pipeline, and persisted without touching business DOM.",
      checks,
    );
    const annotationTool = panelRoot?.querySelector<HTMLSelectElement>(
      '[aria-label="Visual draft tool"]',
    );
    annotationTool!.value = "rectangle";
    annotationTool!.dispatchEvent(new Event("change"));
    await frame();
    await frame();
    const beforePhase = panelRoot?.querySelector<HTMLSelectElement>(
      '[aria-label="Screenshot phase"]',
    );
    const captureBefore = panelRoot?.querySelector<HTMLButtonElement>(
      '[aria-label="Capture visual screenshot"]',
    );
    beforePhase!.value = "before";
    beforePhase!.dispatchEvent(new Event("change"));
    captureBefore!.click();
    for (let attempt = 0; attempt < 120; attempt++) {
      await settleVisualLifecycle();
      const currentCapture = panelRoot?.querySelector<HTMLButtonElement>(
        '[aria-label="Capture visual screenshot"]',
      );
      if (screenshotCaptureCount >= 1 && currentCapture?.disabled === false)
        break;
    }
    const desiredPhase = panelRoot?.querySelector<HTMLSelectElement>(
      '[aria-label="Screenshot phase"]',
    );
    const captureDesired = panelRoot?.querySelector<HTMLButtonElement>(
      '[aria-label="Capture visual screenshot"]',
    );
    desiredPhase!.value = "desired";
    desiredPhase!.dispatchEvent(new Event("change"));
    captureDesired!.click();
    for (let attempt = 0; attempt < 120; attempt++) {
      await settleVisualLifecycle();
      const screenshotRecordCount = bridge
        .getPipelineState()
        .records.filter(
          (record) => record.kind === "visual.screenshot.capture",
        ).length;
      const visualSummary = panelRoot?.querySelector(
        '[data-elfui-devtools="visual-draft"]',
      )?.textContent;
      if (
        screenshotCaptureCount >= 2 &&
        screenshotRecordCount >= 2 &&
        visualSummary?.includes("2 张截图") === true
      )
        break;
    }
    const inputScreenshotRecords = bridge
      .getPipelineState()
      .records.filter((record) => record.kind === "visual.screenshot.capture");
    assert(
      screenshotCaptureCount === 2 &&
        panelRoot
          ?.querySelector('[data-elfui-devtools="visual-draft"]')
          ?.textContent?.includes("2 张截图") === true &&
        inputScreenshotRecords.length === 2 &&
        JSON.stringify(inputScreenshotRecords).includes('"value":"before"') &&
        JSON.stringify(inputScreenshotRecords).includes('"value":"desired"') &&
        !JSON.stringify(inputScreenshotRecords).includes("data:image/png"),
      "before and desired screenshots",
      "The real browser captured both input phases, attached them to the desired Visual Draft, and kept binary bytes out of the Pipeline.",
      checks,
    );
    const prepareAIRequest = panelRoot?.querySelector<HTMLButtonElement>(
      '[aria-label="Prepare AI change request"]',
    );
    assert(
      prepareAIRequest && !prepareAIRequest.disabled,
      "AI context preparation",
      "The visual draft exposed a provider-neutral AI request action.",
      checks,
    );
    prepareAIRequest!.click();
    await frame();
    await frame();
    const conversation = panelRoot?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-conversation"]',
    );
    const approveSupporting = panelRoot?.querySelector<HTMLInputElement>(
      '[aria-label="Approve source src/Supporting.ts"]',
    );
    assert(
      conversation?.textContent.includes("ElfUI deterministic mock") &&
        conversation.textContent.includes("图片 降级") &&
        conversation.textContent.includes("源码 1/12 块") &&
        conversation.textContent.includes("已读取 1 个最小源码片段") &&
        panelRoot?.querySelector<HTMLSelectElement>(
          '[aria-label="AI provider"]',
        )?.value === "elfui-mock" &&
        panelRoot?.querySelector<HTMLInputElement>('[aria-label="AI model ID"]')
          ?.value === "elfui-deterministic" &&
        panelRoot
          ?.querySelector('[data-elfui-devtools="visual-draft"]')
          ?.textContent?.includes("0 条标注") &&
        approveSupporting,
      "read-only AI conversation",
      "The active rectangle tool ignored the panel button while the conversation loaded the safe Provider catalog, read the selected source range, and kept the extra compiler source pending.",
      checks,
    );
    const workflow = panelRoot?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-workflow"]',
    );
    assert(
      workflow?.dataset.stage === "request" &&
        workflow.textContent.includes("AI 工作流") &&
        workflow.textContent.includes("当前阶段：请求"),
      "AI workflow status",
      "The prepared request exposed a stable, readable workflow position before Provider execution.",
      checks,
    );
    approveSupporting!.checked = true;
    approveSupporting!.dispatchEvent(new Event("change"));
    panelRoot
      ?.querySelector<HTMLButtonElement>(
        '[aria-label="Approve selected source context"]',
      )
      ?.click();
    await frame();
    await frame();
    const approvedGovernance = panelRoot?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-context-governance"]',
    );
    assert(
      approvedGovernance?.textContent.includes("源码 2/12 块") &&
        approvedGovernance.textContent.includes("已批准 1 个额外 sourceId") &&
        approvedGovernance.textContent.includes("脱敏 1 处") &&
        bridge
          .getPipelineState()
          .records.some((record) => record.kind === "ai.context.approval") &&
        bridge
          .getPipelineState()
          .records.some((record) => record.kind === "ai.context.source.read") &&
        !bridge
          .getPipelineState()
          .records.some(
            (record) =>
              record.stage === "provider-request" ||
              record.source === "provider",
          ),
      "explicit AI source approval",
      "Approving the source rebuilt the request, recorded the decision, and did not contact a provider.",
      checks,
    );
    const retentionRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "ai.conversation.retention");
    const retentionAudit = JSON.stringify(retentionRecord?.payload);
    assert(
      retentionRecord?.stage === "ai-request" &&
        retentionAudit.includes("maxRequestHistoryPerMode") &&
        retentionAudit.includes("sourceContentPersisted") &&
        retentionAudit.includes("screenshotDataPersisted") &&
        !retentionAudit.includes("browser-gate-secret") &&
        !retentionAudit.includes("export const BrowserGateCard") &&
        !retentionAudit.includes("data:image/png"),
      "bounded AI conversation audit",
      "Replacing the request evicted detached audit state under an explicit policy without persisting source or screenshot bytes.",
      checks,
    );
    const runAI = panelRoot?.querySelector<HTMLButtonElement>(
      '[aria-label="Run AI execution"]',
    );
    assert(
      runAI && !runAI.disabled,
      "readonly AI execution control",
      "The prepared request exposed an explicit read-only execution action.",
      checks,
    );
    runAI!.click();
    let aiCompleted = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await settleVisualLifecycle();
      const messageText = panelRoot?.querySelector(
        '[data-elfui-devtools="ai-conversation-messages"]',
      )?.textContent;
      if (
        messageText?.includes("只读解释") &&
        bridge
          .getPipelineState()
          .records.some((record) => record.kind === "ai.execution.completed")
      ) {
        aiCompleted = true;
        break;
      }
    }
    const providerRecords = bridge
      .getPipelineState()
      .records.filter((record) => record.stage === "provider-request");
    const providerKinds = providerRecords.map((record) => record.kind);
    const nodeStatus = panelRoot?.querySelector(
      '[data-elfui-devtools="ai-source-read-status"]',
    )?.textContent;
    const sourceSecretLeaked = JSON.stringify(providerRecords).includes(
      "browser-gate-secret",
    );
    const finalAIText =
      panelRoot?.querySelector(
        '[data-elfui-devtools="ai-conversation-messages"]',
      )?.textContent ?? "";
    assert(
      aiCompleted &&
        providerKinds.includes("ai.execution.started") &&
        providerKinds.includes("ai.execution.completed") &&
        providerKinds.includes("ai.execution.result") &&
        nodeStatus?.includes("Node Gateway 已装配 2 个源码片段") &&
        !sourceSecretLeaked,
      "Node streamed readonly explanation",
      `The real Vite Node Gateway streamed audited output without source secrets (completed=${String(aiCompleted)}, kinds=${providerKinds.join(",")}, status=${nodeStatus ?? "missing"}, leaked=${String(sourceSecretLeaked)}).`,
      checks,
    );
    assert(
      finalAIText.includes(`templateNodeId=${templateNodeId}`) &&
        finalAIText.includes("properties=opacity,transform") &&
        finalAIText.includes("trigger=hover") &&
        finalAIText.includes("durationMs=320") &&
        finalAIText.includes("delayMs=40") &&
        finalAIText.includes("easing=cubic-bezier(0.2, 0, 0, 1)") &&
        finalAIText.includes("respectReducedMotion=true"),
      "structured visual AI understanding",
      "The Node-side mock provider repeated the exact stable target reference and motion parameters from visual context alone.",
      checks,
    );

    const proposalSourceBefore = await fetch("/src/BrowserGate.ts?raw", {
      cache: "no-store",
    }).then((response) => response.text());
    const planMode = panelRoot?.querySelector<HTMLButtonElement>(
      '[aria-label="AI conversation mode plan"]',
    );
    assert(
      planMode,
      "plan conversation control",
      "The real browser exposed the Plan conversation mode.",
      checks,
    );
    planMode!.click();
    await frame();
    await frame();
    const preparePlan = panelRoot?.querySelector<HTMLButtonElement>(
      '[aria-label="Prepare AI change request"]',
    );
    assert(
      preparePlan && !preparePlan.disabled,
      "plan request preparation",
      "The visual draft could be frozen into an independent Plan request.",
      checks,
    );
    preparePlan!.click();
    let runPlan: HTMLButtonElement | null = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await settleVisualLifecycle();
      runPlan =
        panelRoot?.querySelector<HTMLButtonElement>(
          '[aria-label="Run AI execution"]',
        ) ?? null;
      if (runPlan && !runPlan.disabled) break;
    }
    assert(
      runPlan && !runPlan.disabled,
      "plan execution control",
      "The frozen Plan request exposed an explicit execution action.",
      checks,
    );
    runPlan!.click();
    let proposalCard: HTMLElement | null = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await settleVisualLifecycle();
      proposalCard =
        panelRoot?.querySelector<HTMLElement>(
          '[data-elfui-devtools="ai-patch-proposal"]',
        ) ?? null;
      if (
        proposalCard?.textContent?.includes(
          "Update the selected BrowserGate component state.",
        )
      )
        break;
    }
    const proposalDiff = proposalCard?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-patch-diff"]',
    );
    const proposalComment = proposalCard?.querySelector<HTMLTextAreaElement>(
      '[aria-label^="Patch proposal comment proposal:browser-gate:"]',
    );
    const reviseProposal = proposalCard?.querySelector<HTMLButtonElement>(
      '[aria-label^="Revise patch proposal proposal:browser-gate:"]',
    );
    const approveProposal = proposalCard?.querySelector<HTMLButtonElement>(
      '[aria-label^="Approve patch proposal proposal:browser-gate:"]',
    );
    assert(
      proposalCard?.textContent?.includes(
        "Keep the public component API and motion settings unchanged.",
      ) &&
        proposalDiff?.textContent?.includes(
          "+export const BrowserGateCard = false;",
        ) &&
        reviseProposal?.disabled === true &&
        proposalComment &&
        approveProposal,
      "Node-owned PatchProposal review",
      "The Plan rendered summary, assumptions, affected files, validation plan, full Diff, and comment-gated review controls.",
      checks,
    );
    proposalComment!.value = "Keep the selected motion timing unchanged.";
    proposalComment!.dispatchEvent(new Event("input"));
    assert(
      reviseProposal?.disabled === false,
      "revision comment gate",
      "A concrete review comment enabled the revise action.",
      checks,
    );
    approveProposal!.click();
    let proposalApproved = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await settleVisualLifecycle();
      proposalCard =
        panelRoot?.querySelector<HTMLElement>(
          '[data-elfui-devtools="ai-patch-proposal"]',
        ) ?? null;
      if (proposalCard?.textContent?.includes("已批准（尚未应用）")) {
        proposalApproved = true;
        break;
      }
    }
    const proposalSourceAfter = await fetch("/src/BrowserGate.ts?raw", {
      cache: "no-store",
    }).then((response) => response.text());
    const proposalApprovalRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "ai.patch.proposal.approve");
    const approvalAudit = JSON.stringify(proposalApprovalRecord?.payload);
    assert(
      proposalApproved &&
        approvalAudit.includes('"key":"applied"') &&
        approvalAudit.includes('"value":false') &&
        proposalSourceAfter === proposalSourceBefore &&
        !bridge
          .getPipelineState()
          .records.some((record) => record.kind.includes("patch.apply")),
      "approval without file application",
      "Node recorded the ID-only approval and exact hashes while the served source stayed byte-for-byte unchanged.",
      checks,
    );

    const continueApprovedPatch =
      panelRoot?.querySelector<HTMLButtonElement>(
        '[aria-label="Run AI execution"]',
      ) ?? null;
    assert(
      continueApprovedPatch?.textContent === "继续执行已批准 Patch",
      "approved Patch execution control",
      "Approval did not write files automatically and exposed a separate follow-up execution action.",
      checks,
    );
    continueApprovedPatch!.click();
    let verifiedProposal = false;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      await settleVisualLifecycle();
      proposalCard =
        panelRoot?.querySelector<HTMLElement>(
          '[data-elfui-devtools="ai-patch-proposal"]',
        ) ?? null;
      if (proposalCard?.textContent?.includes("已应用并验证")) {
        verifiedProposal = true;
        break;
      }
    }
    const verificationDetails = proposalCard?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-patch-verification"]',
    );
    const verifiedSource = await fetch(
      `/src/BrowserGate.ts?raw&verified=${String(Date.now())}`,
      { cache: "no-store" },
    ).then((response) => response.text());
    const verifiedRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "patch.verification.verified");
    const verifiedAudit = JSON.stringify(verifiedRecord?.payload) ?? "";
    const verificationConditions = {
      verifiedProposal,
      hmrPassed:
        verificationDetails?.textContent?.includes("hmr · passed") === true,
      sourceApplied: verifiedSource.includes("BrowserGateCard = false"),
      verificationStage: verifiedRecord?.stage === "verification",
      sourceIdAudited: verifiedAudit.includes("src/BrowserGate.ts"),
      sourceBodyExcluded: !verifiedAudit.includes(
        "export const BrowserGateCard",
      ),
    };
    assert(
      Object.values(verificationConditions).every(Boolean),
      "approved Patch application and HMR verification",
      `The separate Plan execution applied the exact approved Diff, observed the Vite watcher, stored bounded hashes/checks in the verification Pipeline, and exposed no source body (${JSON.stringify(verificationConditions)}).`,
      checks,
    );
    const captureResultScreenshot =
      proposalCard?.querySelector<HTMLButtonElement>(
        '[aria-label^="Capture patch result screenshot proposal:browser-gate:"]',
      ) ?? null;
    assert(
      captureResultScreenshot && !captureResultScreenshot.disabled,
      "verified Patch result capture control",
      "The verified application exposed an explicit result-screenshot action.",
      checks,
    );
    captureResultScreenshot!.click();
    let resultCaptureRecord:
      | ReturnType<typeof bridge.getPipelineState>["records"][number]
      | undefined;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await settleVisualLifecycle();
      resultCaptureRecord = bridge
        .getPipelineState()
        .records.find((record) => record.kind === "visual.result.capture");
      if (resultCaptureRecord) break;
    }
    const resultPayload = JSON.stringify(resultCaptureRecord?.payload) ?? "";
    const resultCard = panelRoot?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-patch-proposal"]',
    );
    const resultMetadata = resultCard?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-patch-result-screenshot"]',
    );
    const comparison = resultCard?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-patch-comparison"]',
    );
    const visualSummaryAfterResult = panelRoot?.querySelector<HTMLElement>(
      '[data-elfui-devtools="visual-draft"] > p:nth-child(2)',
    )?.textContent;
    assert(
      resultCaptureRecord?.stage === "verification" &&
        resultCaptureRecord.source === "visual-tools" &&
        resultPayload.includes('"value":"result"') &&
        resultPayload.includes("proposal:browser-gate:") &&
        resultPayload.includes("application:") &&
        resultPayload.includes("verification:") &&
        !resultPayload.includes("data:image/png") &&
        resultMetadata?.textContent?.includes("应用结果截图") === true &&
        resultMetadata.textContent.includes(
          `${window.innerWidth}×${window.innerHeight}`,
        ) &&
        resultMetadata.textContent.includes("关联 2 张") &&
        comparison?.textContent?.includes("修改前") === true &&
        comparison.textContent.includes("期望效果") &&
        comparison.textContent.includes("应用结果") &&
        comparison.querySelectorAll("img").length === 3 &&
        visualSummaryAfterResult?.includes("2 张截图") === true,
      "verified Patch screenshot comparison",
      "The real browser linked and rendered before, desired, and result assets while keeping binary bytes out of Pipeline records and the result asset detached from the desired Visual Draft.",
      checks,
    );
    const initialVisualReview = resultCard?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-visual-result-review"]',
    );
    const firstIntentReview =
      initialVisualReview?.querySelector<HTMLSelectElement>(
        '[data-reference-kind="visual-intent"] select',
      ) ?? null;
    assert(
      initialVisualReview
        ?.querySelector(
          '[data-elfui-devtools="ai-visual-result-review-summary"]',
        )
        ?.textContent?.includes("待核对 2") === true && firstIntentReview,
      "visual result review controls",
      "The verified result exposed an explicit review for each stable intent and non-redaction annotation.",
      checks,
    );
    firstIntentReview!.value = "unmet";
    firstIntentReview!.dispatchEvent(new Event("change"));
    await settleVisualLifecycle();
    await settleVisualLifecycle();
    let reviewedCard = panelRoot?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-patch-proposal"]',
    );
    const secondIntentReview =
      reviewedCard
        ?.querySelectorAll<HTMLSelectElement>(
          '[data-reference-kind="visual-intent"] select',
        )
        .item(1) ?? null;
    if (secondIntentReview) {
      secondIntentReview.value = "met";
      secondIntentReview.dispatchEvent(new Event("change"));
      await settleVisualLifecycle();
      await settleVisualLifecycle();
      reviewedCard = panelRoot?.querySelector<HTMLElement>(
        '[data-elfui-devtools="ai-patch-proposal"]',
      );
    }
    const reviewedSummary = reviewedCard?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-visual-result-review-summary"]',
    );
    const unmetItem = reviewedCard?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-visual-result-review-item"][data-reference-kind="visual-intent"][data-status="unmet"]',
    );
    const reviewRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "visual.result.review.updated");
    const reviewPayload = JSON.stringify(reviewRecord?.payload) ?? "";
    assert(
      reviewedSummary?.textContent?.includes("未满足 1") === true &&
        reviewedSummary.textContent.includes("待核对 0") &&
        reviewedSummary.textContent.includes("已满足 1") &&
        unmetItem !== null &&
        reviewRecord?.stage === "verification" &&
        reviewPayload.includes('"value":"unmet"') &&
        reviewPayload.includes('"value":"visual-intent"') &&
        !reviewPayload.includes("data:image/png"),
      "unmet visual intent audit",
      "A user review marked one stable intent unmet, highlighted it in the result UI, and recorded only bounded correlation metadata.",
      checks,
    );
    const unresolvedIntentId = unmetItem?.dataset.referenceId ?? "";
    const partialAcceptVisualResult =
      reviewedCard?.querySelector<HTMLButtonElement>(
        '[aria-label^="Partially accept visual result proposal:browser-gate:"]',
      ) ?? null;
    assert(
      partialAcceptVisualResult && !partialAcceptVisualResult.disabled,
      "partial visual acceptance control",
      "A fully reviewed mix of met and unmet intents exposed an explicit partial-accept action without changing the desired Visual Draft.",
      checks,
    );
    partialAcceptVisualResult!.click();
    let followUpContext: HTMLElement | null = null;
    let previousRound: HTMLElement | null = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await settleVisualLifecycle();
      followUpContext =
        panelRoot?.querySelector<HTMLElement>(
          '[data-elfui-devtools="ai-follow-up-context"]',
        ) ?? null;
      previousRound =
        panelRoot?.querySelector<HTMLElement>(
          '[data-elfui-devtools="ai-patch-proposals"][data-round="previous"]',
        ) ?? null;
      if (followUpContext && previousRound) break;
    }
    const followUpRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "ai.context.follow-up");
    const followUpPayload = JSON.stringify(followUpRecord?.payload) ?? "";
    const partialDecisionRecord = bridge
      .getPipelineState()
      .records.find(
        (record) => record.kind === "visual.result.decision.partial-accept",
      );
    const partialDecisionPayload =
      JSON.stringify(partialDecisionRecord?.payload) ?? "";
    const followUpGovernance = panelRoot?.querySelector<HTMLElement>(
      '[data-elfui-devtools="ai-context-governance"]',
    );
    assert(
      followUpContext?.textContent?.includes("未满足 1") === true &&
        followUpContext.textContent.includes("result screenshot:") &&
        followUpGovernance?.textContent?.includes("截图 3 张") === true &&
        panelRoot
          ?.querySelector<HTMLElement>(
            '[data-elfui-devtools="visual-draft"] > p:nth-child(2)',
          )
          ?.textContent?.includes("2 张截图") === true &&
        previousRound
          ?.querySelector('[data-elfui-devtools="ai-patch-comparison"]')
          ?.textContent?.includes("应用结果") === true &&
        previousRound.querySelector(
          '[aria-label^="Revert visual result proposal:browser-gate:"]',
        ) !== null &&
        followUpRecord?.stage === "ai-request" &&
        followUpPayload.includes(unresolvedIntentId) &&
        followUpPayload.includes('"value":"unmet"') &&
        !followUpPayload.includes("data:image/png") &&
        partialDecisionRecord?.stage === "verification" &&
        partialDecisionPayload.includes(unresolvedIntentId) &&
        partialDecisionPayload.includes('"value":"partial-accept"') &&
        !partialDecisionPayload.includes("data:image/png"),
      "partial acceptance follow-up request",
      "The decision audit retained met references, sent only unresolved references and the detached result screenshot into a fresh request, and kept binary bytes out of Pipeline.",
      checks,
    );
    const runVisualFollowUp =
      panelRoot?.querySelector<HTMLButtonElement>(
        '[aria-label="Run AI execution"]',
      ) ?? null;
    assert(
      runVisualFollowUp && !runVisualFollowUp.disabled,
      "visual follow-up execution control",
      "The provider-neutral second-round request remained explicit and ready for user execution.",
      checks,
    );
    runVisualFollowUp!.click();
    let followUpOutput = "";
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await settleVisualLifecycle();
      followUpOutput =
        panelRoot?.querySelector<HTMLElement>(
          '[data-elfui-devtools="ai-conversation-messages"]',
        )?.textContent ?? "";
      if (
        followUpOutput.includes("Follow-up plan retained") &&
        followUpOutput.includes(unresolvedIntentId)
      )
        break;
    }
    const followUpUpload = bridge
      .getPipelineState()
      .records.filter((record) => record.kind === "ai.screenshot.upload")
      .at(-1);
    previousRound =
      panelRoot?.querySelector<HTMLElement>(
        '[data-elfui-devtools="ai-patch-proposals"][data-round="previous"]',
      ) ?? previousRound;
    assert(
      followUpOutput.includes("Follow-up plan retained 1") &&
        followUpOutput.includes(`visual-intent/${unresolvedIntentId}/unmet`) &&
        followUpOutput.includes("resultScreenshotId=screenshot:") &&
        followUpUpload?.summary.includes("Uploaded 3") === true &&
        previousRound !== null,
      "second-round visual AI execution",
      "The Node Provider received the unresolved stable reference and all three screenshots while the previous Patch audit remained visible.",
      checks,
    );
    const assistantMessages = [
      ...(panelRoot?.querySelectorAll<HTMLElement>(
        '[data-elfui-devtools="ai-conversation-messages"] [data-message-role="assistant"]',
      ) ?? []),
    ];
    const followUpMessage = assistantMessages.at(-1) ?? null;
    const intentReplyReference =
      followUpMessage?.querySelector<HTMLButtonElement>(
        `[data-reference-kind="visual-intent"][data-reference-id="${CSS.escape(unresolvedIntentId)}"]`,
      ) ?? null;
    const fileReplyReference =
      followUpMessage?.querySelector<HTMLButtonElement>(
        '[data-reference-kind="file"][data-reference-id="src/BrowserGate.ts"]',
      ) ?? null;
    const diagnosticReplyReference =
      followUpMessage?.querySelector<HTMLButtonElement>(
        '[data-reference-kind="diagnostic"]',
      ) ?? null;
    fileReplyReference?.click();
    const replyReferenceRecord = bridge
      .getPipelineState()
      .records.filter((record) => record.kind === "ai.reference.trace")
      .at(-1);
    assert(
      intentReplyReference !== null &&
        fileReplyReference !== null &&
        diagnosticReplyReference !== null &&
        replyReferenceRecord?.payload &&
        JSON.stringify(replyReferenceRecord.payload).includes(
          "src/BrowserGate.ts",
        ),
      "structured AI reply references",
      "The second-round reply exposed Node-validated intent, file, and diagnostic references and traced the cited file without trusting free-form labels.",
      checks,
    );
    proposalCard =
      previousRound?.querySelector<HTMLElement>(
        '[data-elfui-devtools="ai-patch-proposal"]',
      ) ??
      reviewedCard ??
      resultCard ??
      proposalCard;
    if (new URLSearchParams(location.search).get("demoStage") === "verified") {
      showDemoResult({ ok: true, checks });
      return;
    }
    const activatePreviousRound =
      previousRound?.querySelector<HTMLButtonElement>(
        '[aria-label^="Activate AI request ai-change:"]',
      ) ?? null;
    assert(
      activatePreviousRound && !activatePreviousRound.disabled,
      "visual round navigation control",
      "The prior verified request remained selectable after the second-round Provider execution.",
      checks,
    );
    activatePreviousRound!.click();
    let activePreviousRound: HTMLElement | null = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await settleVisualLifecycle();
      activePreviousRound =
        panelRoot?.querySelector<HTMLElement>(
          '[data-elfui-devtools="ai-patch-proposals"][data-round="current"] [data-elfui-devtools="ai-patch-proposal"]',
        ) ?? null;
      if (
        activePreviousRound?.querySelector(
          '[aria-label^="Revert visual result proposal:browser-gate:"]',
        )
      )
        break;
    }
    assert(
      activePreviousRound !== null &&
        panelRoot?.querySelector(
          '[data-elfui-devtools="ai-follow-up-context"]',
        ) === null &&
        bridge
          .getPipelineState()
          .records.some(
            (record) => record.kind === "ai.conversation.round.select",
          ),
      "visual round navigation audit",
      "Selecting the previous round restored its Patch controls without discarding the second request or Visual Draft.",
      checks,
    );
    proposalCard = activePreviousRound ?? proposalCard;

    const rollbackAppliedPatch =
      proposalCard?.querySelector<HTMLButtonElement>(
        '[aria-label^="Revert visual result proposal:browser-gate:"]',
      ) ?? null;
    assert(
      rollbackAppliedPatch && !rollbackAppliedPatch.disabled,
      "verified Patch rollback control",
      "A verified application exposed an explicit user rollback action.",
      checks,
    );
    rollbackAppliedPatch!.click();
    let userRollbackCompleted = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await settleVisualLifecycle();
      proposalCard =
        panelRoot?.querySelector<HTMLElement>(
          '[data-elfui-devtools="ai-patch-proposal"]',
        ) ?? null;
      if (proposalCard?.textContent?.includes("已由用户撤销")) {
        userRollbackCompleted = true;
        break;
      }
    }
    const restoredSource = await fetch(
      `/src/BrowserGate.ts?raw&restored=${String(Date.now())}`,
      { cache: "no-store" },
    ).then((response) => response.text());
    assert(
      userRollbackCompleted &&
        restoredSource.includes("BrowserGateCard = true") &&
        bridge
          .getPipelineState()
          .records.some((record) => record.kind === "patch.rollback.user") &&
        bridge
          .getPipelineState()
          .records.some(
            (record) => record.kind === "visual.result.decision.revert",
          ) &&
        proposalCard?.querySelector(
          '[aria-label^="Regenerate visual result proposal:browser-gate:"]',
        ) !== null,
      "visual result revert restores approved source",
      "The formal visual-round revert restored original bytes after Node hash checks, preserved a safe decision audit, and exposed explicit regeneration.",
      checks,
    );

    const retryApprovedPatch =
      panelRoot?.querySelector<HTMLButtonElement>(
        '[aria-label="Run AI execution"]',
      ) ?? null;
    assert(
      retryApprovedPatch?.textContent === "重试已批准 Patch",
      "rolled-back Patch retry control",
      "After user rollback the same approved Patch could be explicitly retried under fresh hash validation.",
      checks,
    );
    retryApprovedPatch!.click();
    let failedVerificationRolledBack = false;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      await settleVisualLifecycle();
      proposalCard =
        panelRoot?.querySelector<HTMLElement>(
          '[data-elfui-devtools="ai-patch-proposal"]',
        ) ?? null;
      if (proposalCard?.textContent?.includes("验证失败（已回滚）")) {
        failedVerificationRolledBack = true;
        break;
      }
    }
    const failedSource = await fetch(
      `/src/BrowserGate.ts?raw&failed=${String(Date.now())}`,
      { cache: "no-store" },
    ).then((response) => response.text());
    const rollbackVerificationRecord = bridge
      .getPipelineState()
      .records.find(
        (record) => record.kind === "patch.verification.rolled-back",
      );
    assert(
      failedVerificationRolledBack &&
        failedSource.includes("BrowserGateCard = true") &&
        rollbackVerificationRecord?.diagnostics.some(
          (diagnostic) => diagnostic.code === "BROWSER_GATE_TYPECHECK",
        ),
      "failed verification restores source",
      "The intentional second-run typecheck failure restored the original source and preserved the bounded diagnostic without leaving a half-applied Patch.",
      checks,
    );

    const visualPrevious = host;
    const visualReplacement = document.createElement("elf-browser-gate-card");
    visualPrevious.replaceWith(visualReplacement);
    bridge.unregisterComponent(visualPrevious);
    host = visualReplacement;
    bridge.registerComponent({
      host,
      tag: "elf-browser-gate-card",
      source: { file: "src/BrowserGate.ts", line: 1, column: 1 },
    });
    const reboundButton = buttons.get(host)!;
    let reboundBounds = reboundButton.getBoundingClientRect();
    let reboundPreview: HTMLElement | null = null;
    let reboundMotionPreview: HTMLElement | null = null;
    let visualDraftRelocated = false;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await settleVisualLifecycle();
      await frame();
      reboundBounds = reboundButton.getBoundingClientRect();
      reboundPreview = document.querySelector<HTMLElement>(
        "[data-elfui-devtools=visual-style-preview]",
      );
      reboundMotionPreview = document.querySelector<HTMLElement>(
        "[data-elfui-devtools=visual-motion-preview]",
      );
      visualDraftRelocated =
        bridge
          .getPipelineState()
          .records.some((record) => record.kind === "visual.target.rebind") &&
        matchesCssPixel(reboundPreview?.style.left ?? "", reboundBounds.x) &&
        matchesCssPixel(reboundPreview?.style.top ?? "", reboundBounds.y) &&
        reboundPreview.style.getPropertyValue("background-color") ===
          "rgb(15, 118, 110)" &&
        matchesCssPixel(
          reboundMotionPreview?.style.left ?? "",
          reboundBounds.x,
        ) &&
        matchesCssPixel(
          reboundMotionPreview?.style.top ?? "",
          reboundBounds.y,
        ) &&
        Boolean(reboundMotionPreview.textContent?.includes("320ms + 40ms"));
      if (visualDraftRelocated) break;
    }
    assert(
      visualDraftRelocated,
      "HMR visual draft relocation",
      "The stable template node kept its target ID, style and motion intents, and current geometry after replacement.",
      checks,
    );
    assert(
      reboundButton.getAttribute("style") === businessStyle,
      "HMR business DOM preservation",
      "Relocating the visual draft still left the replacement business node unchanged.",
      checks,
    );
    const finalVisualTool = panelRoot?.querySelector<HTMLSelectElement>(
      '[aria-label="Visual draft tool"]',
    );
    if (finalVisualTool) {
      finalVisualTool.value = "motion";
      finalVisualTool.dispatchEvent(new Event("change"));
      await frame();
      await frame();
    }
    if (keepPanelOpen) {
      panelRoot
        ?.querySelector<HTMLElement>(
          '[data-elfui-devtools="ai-patch-proposal"]',
        )
        ?.scrollIntoView({ block: "start" });
      showDemoResult({ ok: true, checks });
    } else {
      panel.dispose();
      await report({ ok: true, checks });
    }
  } catch (error) {
    const result = {
      ok: false,
      checks,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
    if (keepPanelOpen) showDemoResult(result);
    else {
      panel.dispose();
      await report(result);
    }
  }
};

const demo = new URLSearchParams(location.search).get("demo");
if (demo === "ai") void run(true);
else if (demo === null) void run();
