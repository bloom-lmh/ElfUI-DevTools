import type {
  ComponentNodeSnapshot,
  ComponentDetailSnapshot,
  CompilerArtifact,
  CompilerStateSnapshot,
  DevtoolsSnapshot,
  InspectorTargetSnapshot,
  PipelineRecord,
  PipelineStateSnapshot,
  RectSnapshot,
  ScreenshotKind,
  ScreenshotPhase,
  SerializedValue,
  TimelineEvent,
  TimelineStatusSnapshot,
  VisualDraft,
} from "@elfui/devtools-shared";
import type { ElfUIDevtoolsBridge } from "@elfui/devtools-runtime";

import {
  ComponentInspector,
  createInspectorTargetSnapshot,
  findTemplateNode,
} from "./index.js";
import {
  AIContextBuilder,
  createDisplayMediaScreenshotAdapter,
  ScreenshotController,
  type ScreenshotCaptureAdapter,
} from "./context.js";
import type { DevtoolsRpcClient } from "./rpc-client.js";
import { openSourceInEditor, type OpenSourceInEditor } from "./source.js";
import { VisualToolsController } from "./visual.js";

export const DEVTOOLS_LAYOUT_STORAGE_KEY = "elfui-devtools:layout:v1";
export const DEVTOOLS_PREFERENCES_STORAGE_KEY = "elfui-devtools:preferences:v1";
export const COMPONENT_TREE_VIRTUALIZE_THRESHOLD = 300;
export const COMPONENT_TREE_ROW_HEIGHT = 28;

const COMPONENT_TREE_OVERSCAN = 8;

type DockPosition = "floating" | "bottom" | "left" | "right";
type PanelTab = "components" | "timeline" | "compiler" | "pipeline";
type PanelTheme = "system" | "light" | "dark";

interface PanelLayout {
  dock: DockPosition;
  width: number;
  height: number;
}

interface PanelPreferences {
  activeTab: PanelTab;
  theme: PanelTheme;
  appId: string | null;
}

interface ResizeStart {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SelectedComponentIdentity {
  tag: string;
  sourceFile: string | null;
}

const defaultLayout: PanelLayout = {
  dock: "floating",
  width: 420,
  height: 560,
};

const defaultPreferences: PanelPreferences = {
  activeTab: "components",
  theme: "system",
  appId: null,
};

const isDockPosition = (value: unknown): value is DockPosition =>
  value === "floating" ||
  value === "bottom" ||
  value === "left" ||
  value === "right";

const finiteDimension = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const isPanelTab = (value: unknown): value is PanelTab =>
  value === "components" ||
  value === "timeline" ||
  value === "compiler" ||
  value === "pipeline";

const isPanelTheme = (value: unknown): value is PanelTheme =>
  value === "system" || value === "light" || value === "dark";

const readLayout = (storage: Storage | null): PanelLayout => {
  if (!storage) return { ...defaultLayout };
  try {
    const value = JSON.parse(
      storage.getItem(DEVTOOLS_LAYOUT_STORAGE_KEY) ?? "null",
    ) as Partial<PanelLayout> | null;
    return {
      dock: isDockPosition(value?.dock) ? value.dock : defaultLayout.dock,
      width: finiteDimension(value?.width, defaultLayout.width),
      height: finiteDimension(value?.height, defaultLayout.height),
    };
  } catch {
    return { ...defaultLayout };
  }
};

const readPreferences = (storage: Storage | null): PanelPreferences => {
  if (!storage) return { ...defaultPreferences };
  try {
    const value = JSON.parse(
      storage.getItem(DEVTOOLS_PREFERENCES_STORAGE_KEY) ?? "null",
    ) as Partial<PanelPreferences> | null;
    return {
      activeTab: isPanelTab(value?.activeTab)
        ? value.activeTab
        : defaultPreferences.activeTab,
      theme: isPanelTheme(value?.theme)
        ? value.theme
        : defaultPreferences.theme,
      appId: typeof value?.appId === "string" ? value.appId : null,
    };
  } catch {
    return { ...defaultPreferences };
  }
};

const storageFor = (document: Document): Storage | null => {
  try {
    return document.defaultView?.localStorage ?? null;
  } catch {
    return null;
  }
};

const valueText = (value: SerializedValue): string => {
  if (value.kind === "primitive") return JSON.stringify(value.value);
  if (value.kind === "object")
    return `{ ${value.entries.map(({ key, value: item }) => `${key}: ${valueText(item)}`).join(", ")} }`;
  if (value.kind === "array")
    return `[${value.items.map(valueText).join(", ")}]`;
  if (value.kind === "map" || value.kind === "set")
    return `[${value.kind}(${value.entries.length})]`;
  return "preview" in value ? value.preview : `[${value.kind}]`;
};

const styles = `
  :host { color-scheme: light dark; }
  * { box-sizing: border-box; }
  button, select { font: inherit; }
  .launcher {
    position: fixed;
    left: 50%;
    bottom: 12px;
    display: flex;
    transform: translateX(-50%);
    overflow: hidden;
    padding: 3px;
    border: 1px solid rgb(148 163 184 / 35%);
    border-radius: 999px;
    background: rgb(255 255 255 / 94%);
    box-shadow: 0 8px 28px rgb(15 23 42 / 20%);
    backdrop-filter: blur(12px);
    pointer-events: auto;
  }
  .launcher button {
    display: grid;
    width: 34px;
    height: 28px;
    place-items: center;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: #64748b;
    cursor: pointer;
  }
  .launcher button:hover,
  .launcher button[aria-pressed="true"] {
    background: #e0f2fe;
    color: #0284c7;
  }
  .brand { font-weight: 800; letter-spacing: -0.08em; }
  .target { font-size: 20px; line-height: 1; }
  .panel {
    position: fixed;
    display: flex;
    width: min(var(--elfui-devtools-width, 420px), calc(100vw - 32px));
    height: min(var(--elfui-devtools-height, 560px), calc(100vh - 72px));
    max-width: 100vw;
    max-height: 100vh;
    overflow: hidden;
    border: 1px solid #334155;
    border-radius: 12px;
    background: #0f172a;
    color: #e2e8f0;
    box-shadow: 0 18px 48px rgb(0 0 0 / 42%);
    font: 12px/1.5 ui-sans-serif, system-ui, sans-serif;
    pointer-events: auto;
  }
  .panel[data-dock="floating"] { right: 16px; bottom: 56px; }
  .panel[data-dock="bottom"] {
    right: 0;
    bottom: 0;
    left: 0;
    width: 100vw;
    height: min(var(--elfui-devtools-height, 420px), 90vh);
    border-radius: 12px 12px 0 0;
  }
  .panel[data-dock="left"],
  .panel[data-dock="right"] {
    top: 0;
    bottom: 0;
    width: min(var(--elfui-devtools-width, 420px), 90vw);
    height: 100vh;
    border-radius: 0;
  }
  .panel[data-dock="left"] { left: 0; }
  .panel[data-dock="right"] { right: 0; }
  .panel[data-fullscreen="true"] {
    inset: 0;
    width: 100vw;
    height: 100vh;
    max-width: none;
    max-height: none;
    border-radius: 0;
  }
  .panel[hidden] { display: none; }
  .resize-handle {
    position: absolute;
    z-index: 2;
    background: transparent;
    touch-action: none;
  }
  .panel[data-dock="floating"] .resize-handle {
    right: 0;
    bottom: 0;
    width: 18px;
    height: 18px;
    cursor: nwse-resize;
  }
  .panel[data-dock="bottom"] .resize-handle {
    top: 0;
    right: 0;
    left: 0;
    height: 7px;
    cursor: ns-resize;
  }
  .panel[data-dock="left"] .resize-handle {
    top: 0;
    right: 0;
    bottom: 0;
    width: 7px;
    cursor: ew-resize;
  }
  .panel[data-dock="right"] .resize-handle {
    top: 0;
    bottom: 0;
    left: 0;
    width: 7px;
    cursor: ew-resize;
  }
  .panel[data-fullscreen="true"] .resize-handle { display: none; }
  .header {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid #334155;
    background: #111c31;
  }
  .header strong { font-size: 13px; }
  .header-actions { display: flex; align-items: center; gap: 5px; }
  .header-actions button,
  .header-actions select {
    min-height: 25px;
    border: 1px solid #475569;
    border-radius: 5px;
    background: #1e293b;
    color: #cbd5e1;
  }
  .header-actions button { padding: 2px 7px; cursor: pointer; }
  .header-actions select { padding: 1px 4px; }
  .app-selector { max-width: 150px; }
  .close {
    border: 0 !important;
    background: transparent !important;
    color: #94a3b8;
    cursor: pointer;
  }
  .content { width: 100%; height: 100%; overflow: auto; padding: 10px; }
  .navigation {
    display: flex;
    gap: 3px;
    margin: 0 0 10px;
    padding: 3px;
    border: 1px solid #334155;
    border-radius: 7px;
    background: #020617;
  }
  .navigation button {
    flex: 1;
    min-width: 0;
    border: 0;
    border-radius: 5px;
    padding: 5px 7px;
    background: transparent;
    color: #94a3b8;
    cursor: pointer;
  }
  .navigation button[aria-selected="true"] {
    background: #1e293b;
    color: #7dd3fc;
  }
  [role="tabpanel"][hidden] { display: none; }
  .section { margin: 0 0 10px; }
  .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .section-title { margin: 0 0 5px; color: #94a3b8; font-weight: 600; text-transform: uppercase; }
  .timeline-actions { display: flex; gap: 4px; margin-bottom: 5px; }
  .timeline-actions button { border: 1px solid #475569; border-radius: 4px; background: #1e293b; color: #cbd5e1; cursor: pointer; }
  .pipeline-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .pipeline-record {
    display: block;
    width: 100%;
    border: 1px solid #334155;
    border-radius: 5px;
    padding: 5px 7px;
    background: #111c31;
    color: #cbd5e1;
    text-align: left;
    cursor: pointer;
  }
  .pipeline-record:hover,
  .pipeline-record[aria-pressed="true"] { border-color: #0ea5e9; background: #082f49; }
  .pipeline-record strong { color: #7dd3fc; }
  .pipeline-empty { margin: 0; color: #64748b; }
  .pipeline-json { max-height: 260px; font-size: 11px; }
  .component-detail {
    display: grid;
    gap: 7px;
    margin-top: 9px;
    border-top: 1px solid #334155;
    padding-top: 9px;
  }
  .detail-heading { margin: 0; color: #e0f2fe; font-size: 13px; }
  .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
  .detail-block { min-width: 0; border: 1px solid #273449; border-radius: 6px; padding: 6px; background: #0b1324; }
  .detail-block[data-wide="true"] { grid-column: 1 / -1; }
  .detail-label { margin: 0 0 3px; color: #64748b; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .detail-value { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
  .detail-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .detail-list li { border-left: 2px solid #334155; padding-left: 6px; }
  .detail-list li[data-severity="error"] { border-color: #f87171; }
  .detail-list li[data-severity="warning"] { border-color: #fbbf24; }
  .detail-list small { display: block; color: #94a3b8; }
  .visual-draft { margin-top: 9px; border: 1px solid #7c2d12; border-radius: 7px; padding: 7px; background: #1c1917; }
  .visual-draft .section-title { color: #fdba74; }
  .visual-draft p { margin: 0; color: #fed7aa; }
  .visual-capture { display: grid; grid-template-columns: 1fr 1fr auto; gap: 5px; align-items: center; }
  .visual-capture-status { grid-column: 1 / -1; color: #fdba74; font-size: 11px; }
  .source-action { margin: 8px 0 0; border: 1px solid #0ea5e9; border-radius: 5px; padding: 4px 8px; background: #082f49; color: #bae6fd; cursor: pointer; }
  .source-action:disabled { cursor: wait; opacity: .65; }
  .component-tools { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  .component-search {
    min-width: 0;
    flex: 1;
    border: 1px solid #334155;
    border-radius: 5px;
    padding: 4px 7px;
    background: #111827;
    color: #e2e8f0;
  }
  .component-tree { display: grid; gap: 1px; }
  .component-tree[data-virtualized="true"] {
    position: relative;
    display: block;
    max-height: 280px;
    overflow: auto;
  }
  .component-virtual-spacer { position: relative; min-width: 100%; }
  .component-tree[data-virtualized="true"] .component-row {
    position: absolute;
    right: 0;
    left: 0;
    height: ${COMPONENT_TREE_ROW_HEIGHT}px;
  }
  .component-row { display: flex; align-items: center; min-width: 0; }
  .tree-toggle {
    flex: 0 0 22px;
    width: 22px;
    border: 0;
    padding: 3px 0;
    background: transparent;
    color: #64748b;
    cursor: pointer;
  }
  .tree-toggle:disabled { cursor: default; opacity: .25; }
  .component {
    display: block;
    min-width: 0;
    flex: 1;
    padding: 4px 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: #bae6fd;
    text-align: left;
    cursor: pointer;
  }
  .component:hover,
  .component[aria-pressed="true"] { background: #1e293b; color: #7dd3fc; }
  ol { margin: 0; padding-left: 22px; color: #cbd5e1; }
  pre { margin: 8px 0 0; overflow: auto; padding: 8px; border-radius: 6px; background: #020617; white-space: pre-wrap; }
  :host([data-theme="light"]) { color-scheme: light; }
  :host([data-theme="light"]) .panel {
    border-color: #cbd5e1;
    background: #ffffff;
    color: #0f172a;
    box-shadow: 0 18px 48px rgb(15 23 42 / 22%);
  }
  :host([data-theme="light"]) .header,
  :host([data-theme="light"]) .pipeline-record { background: #f8fafc; }
  :host([data-theme="light"]) .header { border-color: #e2e8f0; }
  :host([data-theme="light"]) .header-actions button,
  :host([data-theme="light"]) .header-actions select,
  :host([data-theme="light"]) .timeline-actions button {
    border-color: #cbd5e1;
    background: #ffffff;
    color: #334155;
  }
  :host([data-theme="light"]) .navigation {
    border-color: #e2e8f0;
    background: #f1f5f9;
  }
  :host([data-theme="light"]) .navigation button[aria-selected="true"],
  :host([data-theme="light"]) .component:hover,
  :host([data-theme="light"]) .component[aria-pressed="true"] {
    background: #e0f2fe;
    color: #0369a1;
  }
  :host([data-theme="light"]) .component-search,
  :host([data-theme="light"]) pre {
    border-color: #cbd5e1;
    background: #f8fafc;
    color: #0f172a;
  }
  :host([data-theme="light"]) ol,
  :host([data-theme="light"]) .pipeline-record { color: #334155; }
  :host([data-theme="dark"]) { color-scheme: dark; }
  :host([data-theme="dark"]) .launcher {
    border-color: rgb(71 85 105 / 70%);
    background: rgb(15 23 42 / 94%);
  }
  :host([data-theme="dark"]) .launcher button { color: #94a3b8; }
  @media (prefers-color-scheme: dark) {
    .launcher { border-color: rgb(71 85 105 / 70%); background: rgb(15 23 42 / 94%); }
    .launcher button { color: #94a3b8; }
    .launcher button:hover,
    .launcher button[aria-pressed="true"] { background: #0c4a6e; color: #7dd3fc; }
  }
  @media (max-width: 560px) {
    .panel[data-dock="floating"] {
      right: 8px;
      bottom: 52px;
      width: calc(100vw - 16px);
    }
    .header { align-items: flex-start; gap: 8px; }
    .header-actions { flex-wrap: wrap; justify-content: flex-end; }
  }
`;

export class DevtoolsPanel {
  private readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly panel: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly resizeHandle: HTMLDivElement;
  private readonly panelToggle: HTMLButtonElement;
  private readonly inspectorToggle: HTMLButtonElement;
  private readonly visualToggle: HTMLButtonElement;
  private readonly inspector: ComponentInspector;
  private readonly visualTools: VisualToolsController;
  private readonly aiContext: AIContextBuilder;
  private readonly screenshots: ScreenshotController | null;
  private selectedId: string | null = null;
  private selectedTarget: InspectorTargetSnapshot | null = null;
  private selectedTemplateNodeId: string | null = null;
  private selectedIdentity: SelectedComponentIdentity | null = null;
  private selectedPipelineId: string | null = null;
  private selectedCompilerSourceId: string | null = null;
  private componentQuery = "";
  private readonly collapsedComponentIds = new Set<string>();
  private readonly componentParentIds = new Map<string, string | null>();
  private visible = false;
  private readonly stop: () => void;
  private readonly stopPipeline: () => void;
  private renderGeneration = 0;
  private renderQueued = false;
  private selectionRecoveryTimer: number | null = null;
  private readonly storage: Storage | null;
  private dock: DockPosition;
  private panelWidth: number;
  private panelHeight: number;
  private activeTab: PanelTab;
  private theme: PanelTheme;
  private selectedAppId: string | null;
  private fullscreen = false;
  private resizeStart: ResizeStart | null = null;
  private screenshotPhase: ScreenshotPhase = "before";
  private screenshotKind: ScreenshotKind = "viewport";
  private screenshotStatus = "";
  private capturingScreenshot = false;

  public constructor(
    private readonly bridge: ElfUIDevtoolsBridge,
    private readonly document: Document = window.document,
    private readonly rpc?: DevtoolsRpcClient,
    private readonly openSource: OpenSourceInEditor = openSourceInEditor,
    screenshotAdapter?: ScreenshotCaptureAdapter,
  ) {
    this.storage = storageFor(document);
    const layout = readLayout(this.storage);
    this.dock = layout.dock;
    this.panelWidth = layout.width;
    this.panelHeight = layout.height;
    const preferences = readPreferences(this.storage);
    this.activeTab = preferences.activeTab;
    this.theme = preferences.theme;
    this.selectedAppId = preferences.appId;
    this.host = document.createElement("div");
    this.host.dataset.elfuiDevtools = "host";
    this.host.dataset.theme = this.theme;
    this.host.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    this.shadow = this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = styles;
    const launcher = document.createElement("div");
    launcher.className = "launcher";
    launcher.dataset.elfuiDevtools = "launcher";

    this.panelToggle = document.createElement("button");
    this.panelToggle.className = "brand";
    this.panelToggle.type = "button";
    this.panelToggle.textContent = "E";
    this.panelToggle.title = "Toggle ElfUI DevTools";
    this.panelToggle.setAttribute("aria-label", "Toggle ElfUI DevTools");
    this.panelToggle.onclick = () => this.setVisible(!this.visible);

    this.inspectorToggle = document.createElement("button");
    this.inspectorToggle.className = "target";
    this.inspectorToggle.type = "button";
    this.inspectorToggle.textContent = "⌖";
    this.inspectorToggle.title = "Toggle Component Inspector";
    this.inspectorToggle.setAttribute(
      "aria-label",
      "Toggle Component Inspector",
    );
    this.inspectorToggle.setAttribute(
      "aria-keyshortcuts",
      "Control+Shift+C Meta+Shift+C",
    );
    this.inspectorToggle.onclick = () => {
      if (this.inspector.enabled) this.inspector.disable();
      else this.inspector.enable();
      this.syncControls();
    };
    this.visualToggle = document.createElement("button");
    this.visualToggle.className = "visual";
    this.visualToggle.type = "button";
    this.visualToggle.textContent = "✎";
    this.visualToggle.title = "Toggle Visual Draft";
    this.visualToggle.setAttribute("aria-label", "Toggle Visual Draft");
    this.visualToggle.setAttribute(
      "aria-keyshortcuts",
      "Control+Shift+V Meta+Shift+V",
    );
    this.visualToggle.onclick = () => {
      if (this.visualTools.enabled) this.visualTools.disable();
      else this.visualTools.enable();
      this.setVisible(true);
      this.syncControls();
      this.scheduleRender();
    };
    launcher.append(this.panelToggle, this.inspectorToggle, this.visualToggle);

    this.panel = document.createElement("div");
    this.panel.className = "panel";
    this.panel.dataset.elfuiDevtools = "panel";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "ElfUI DevTools");
    this.panel.setAttribute("aria-modal", "false");
    this.panel.hidden = true;
    this.content = document.createElement("div");
    this.content.className = "content";
    this.resizeHandle = document.createElement("div");
    this.resizeHandle.className = "resize-handle";
    this.resizeHandle.dataset.elfuiDevtools = "resize-handle";
    this.resizeHandle.tabIndex = 0;
    this.resizeHandle.setAttribute("role", "separator");
    this.resizeHandle.setAttribute("aria-label", "Resize ElfUI DevTools");
    this.resizeHandle.onpointerdown = (event) => this.startResize(event);
    this.resizeHandle.onkeydown = (event) => this.resizeWithKeyboard(event);
    this.panel.append(this.content, this.resizeHandle);
    this.applyLayout();

    this.shadow.append(style, launcher, this.panel);
    document.body.appendChild(this.host);
    document.defaultView?.addEventListener("pointermove", this.onPointerMove);
    document.defaultView?.addEventListener("pointerup", this.onPointerUp);

    this.inspector = new ComponentInspector(bridge, {
      document,
      onSelect: (id, target) => this.selectComponent(id, "inspector", target),
      onEnabledChange: () => this.syncControls(),
    });
    this.visualTools = new VisualToolsController(bridge, {
      document,
      onDraftChange: () => this.scheduleRender(),
    });
    this.aiContext = new AIContextBuilder(bridge, this.visualTools, {
      document,
    });
    const captureAdapter =
      screenshotAdapter ??
      createDisplayMediaScreenshotAdapter({
        document,
      });
    this.screenshots = captureAdapter
      ? new ScreenshotController(bridge, this.visualTools, captureAdapter, {
          document,
        })
      : null;
    this.document.addEventListener("keydown", this.onDocumentKeyDown, true);
    this.stop = bridge.on(() => this.scheduleRender());
    this.stopPipeline = bridge.onPipeline(() => this.scheduleRender());
    this.syncControls();
    this.render();
  }

  public get opened(): boolean {
    return this.visible;
  }

  public dispose(): void {
    this.stop();
    this.stopPipeline();
    if (this.selectionRecoveryTimer !== null)
      this.document.defaultView?.clearTimeout(this.selectionRecoveryTimer);
    this.inspector.dispose();
    this.visualTools.dispose();
    this.screenshots?.clear();
    this.document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    this.document.defaultView?.removeEventListener(
      "pointermove",
      this.onPointerMove,
    );
    this.document.defaultView?.removeEventListener(
      "pointerup",
      this.onPointerUp,
    );
    this.host.remove();
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.resizeStart || this.fullscreen) return;
    const deltaX = event.clientX - this.resizeStart.x;
    const deltaY = event.clientY - this.resizeStart.y;
    if (this.dock === "right")
      this.setPanelSize(this.resizeStart.width - deltaX, this.panelHeight);
    else if (this.dock === "left")
      this.setPanelSize(this.resizeStart.width + deltaX, this.panelHeight);
    else if (this.dock === "bottom")
      this.setPanelSize(this.panelWidth, this.resizeStart.height - deltaY);
    else
      this.setPanelSize(
        this.resizeStart.width + deltaX,
        this.resizeStart.height + deltaY,
      );
  };

  private readonly onPointerUp = (): void => {
    this.resizeStart = null;
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (
      event.key.toLowerCase() === "c" &&
      event.shiftKey &&
      (event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault();
      if (this.inspector.enabled) this.inspector.disable();
      else this.inspector.enable();
      return;
    }
    if (
      event.key.toLowerCase() === "v" &&
      event.shiftKey &&
      (event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault();
      if (this.visualTools.enabled) this.visualTools.disable();
      else this.visualTools.enable();
      this.setVisible(true);
      this.syncControls();
      this.scheduleRender();
      return;
    }
    if (event.key === "Escape" && this.visible && !this.inspector.enabled) {
      event.preventDefault();
      this.setVisible(false);
    }
  };

  private startResize(event: PointerEvent): void {
    if (this.fullscreen) return;
    event.preventDefault();
    this.resizeHandle.focus();
    this.resizeStart = {
      x: event.clientX,
      y: event.clientY,
      width: this.panelWidth,
      height: this.panelHeight,
    };
  }

  private resizeWithKeyboard(event: KeyboardEvent): void {
    if (this.fullscreen) return;
    const step = event.shiftKey ? 40 : 16;
    let width = this.panelWidth;
    let height = this.panelHeight;
    if (event.key === "ArrowLeft") width -= step;
    else if (event.key === "ArrowRight") width += step;
    else if (event.key === "ArrowUp") height += step;
    else if (event.key === "ArrowDown") height -= step;
    else return;
    event.preventDefault();
    this.setPanelSize(width, height);
  }

  private setPanelSize(width: number, height: number): void {
    const viewportWidth = this.document.defaultView?.innerWidth ?? 1280;
    const viewportHeight = this.document.defaultView?.innerHeight ?? 720;
    this.panelWidth = Math.round(
      Math.min(Math.max(width, 320), Math.max(320, viewportWidth - 16)),
    );
    this.panelHeight = Math.round(
      Math.min(Math.max(height, 240), Math.max(240, viewportHeight - 16)),
    );
    this.applyLayout();
    this.persistLayout();
  }

  private setDock(dock: DockPosition): void {
    this.dock = dock;
    this.applyLayout();
    this.persistLayout();
  }

  private setFullscreen(fullscreen: boolean): void {
    this.fullscreen = fullscreen;
    this.applyLayout();
    this.render();
  }

  private applyLayout(): void {
    this.panel.dataset.dock = this.dock;
    this.panel.dataset.fullscreen = String(this.fullscreen);
    this.panel.style.setProperty(
      "--elfui-devtools-width",
      `${this.panelWidth}px`,
    );
    this.panel.style.setProperty(
      "--elfui-devtools-height",
      `${this.panelHeight}px`,
    );
  }

  private persistLayout(): void {
    try {
      this.storage?.setItem(
        DEVTOOLS_LAYOUT_STORAGE_KEY,
        JSON.stringify({
          dock: this.dock,
          width: this.panelWidth,
          height: this.panelHeight,
        } satisfies PanelLayout),
      );
    } catch {
      // Storage can be disabled by browser privacy settings.
    }
  }

  private persistPreferences(): void {
    try {
      this.storage?.setItem(
        DEVTOOLS_PREFERENCES_STORAGE_KEY,
        JSON.stringify({
          activeTab: this.activeTab,
          theme: this.theme,
          appId: this.selectedAppId,
        } satisfies PanelPreferences),
      );
    } catch {
      // Storage can be disabled by browser privacy settings.
    }
  }

  private setActiveTab(tab: PanelTab, focus = false): void {
    this.activeTab = tab;
    this.persistPreferences();
    this.render();
    if (focus)
      this.shadow
        .querySelector<HTMLButtonElement>(`[data-devtools-tab="${tab}"]`)
        ?.focus();
  }

  private clearComponentSelection(): void {
    this.selectedId = null;
    this.selectedTarget = null;
    this.selectedTemplateNodeId = null;
    this.selectedIdentity = null;
    this.clearSelectionRecoveryTimer();
  }

  private setVisible(visible: boolean): void {
    this.visible = visible;
    this.panel.hidden = !visible;
    this.syncControls();
    if (!visible) {
      this.panelToggle.focus();
      return;
    }
    queueMicrotask(() => {
      if (!this.visible) return;
      this.shadow
        .querySelector<HTMLButtonElement>(
          `[data-devtools-tab="${this.activeTab}"]`,
        )
        ?.focus();
    });
  }

  private devtoolsExcludedRegions(): RectSnapshot[] {
    const regions: RectSnapshot[] = [];
    for (const element of [
      this.shadow.querySelector<HTMLElement>("[data-elfui-devtools=launcher]"),
      this.panel.hidden ? null : this.panel,
    ]) {
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      regions.push({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    }
    return regions;
  }

  private visualScreenshotSelection(draft: VisualDraft): RectSnapshot | null {
    const target = draft.targets.at(-1);
    if (!target) return null;
    const intent = [...draft.intents]
      .reverse()
      .find((candidate) => candidate.targetId === target.id);
    const desired =
      intent?.type === "move" || intent?.type === "resize"
        ? intent.desired
        : target.geometry;
    const left = Math.min(target.geometry.x, desired.x);
    const top = Math.min(target.geometry.y, desired.y);
    const right = Math.max(
      target.geometry.x + target.geometry.width,
      desired.x + desired.width,
    );
    const bottom = Math.max(
      target.geometry.y + target.geometry.height,
      desired.y + desired.height,
    );
    const padding = 16;
    const view = this.document.defaultView;
    const x = Math.max(0, left - padding);
    const y = Math.max(0, top - padding);
    return {
      x,
      y,
      width: Math.max(
        1,
        Math.min(view?.innerWidth ?? right + padding, right + padding) - x,
      ),
      height: Math.max(
        1,
        Math.min(view?.innerHeight ?? bottom + padding, bottom + padding) - y,
      ),
    };
  }

  private async captureVisualScreenshot(): Promise<void> {
    if (!this.screenshots || this.capturingScreenshot) return;
    const draft = this.visualTools.getDraft();
    const selection =
      this.screenshotKind === "selection"
        ? this.visualScreenshotSelection(draft)
        : undefined;
    if (this.screenshotKind === "selection" && !selection) {
      this.screenshotStatus = "Select a visual target before capturing it.";
      this.render();
      return;
    }
    this.capturingScreenshot = true;
    this.screenshotStatus = "Choose the current browser tab to capture…";
    this.render();
    try {
      const asset = await this.screenshots.capture(
        this.screenshotPhase,
        this.screenshotKind,
        {
          ...(selection ? { selection } : {}),
          excludedRegions: [
            ...this.devtoolsExcludedRegions(),
            ...draft.annotations.flatMap((annotation) =>
              annotation.type === "redaction" && annotation.geometry
                ? [{ ...annotation.geometry }]
                : [],
            ),
          ],
        },
      );
      this.screenshotStatus = `Captured ${asset.phase} ${asset.kind} · ${asset.width}×${asset.height}`;
    } catch (error) {
      const cancelled =
        error instanceof DOMException && error.name === "NotAllowedError";
      const message = cancelled
        ? "Screenshot capture cancelled."
        : error instanceof Error
          ? error.message
          : String(error);
      this.screenshotStatus = message;
      this.bridge.recordPipeline({
        taskId: this.visualTools.id,
        stage: "visual-intent",
        source: "visual-tools",
        kind: "visual.screenshot.error",
        summary: message,
        payload: {
          phase: this.screenshotPhase,
          kind: this.screenshotKind,
          error: message,
        },
      });
    } finally {
      this.capturingScreenshot = false;
      this.render();
    }
  }

  private selectComponent(
    id: string,
    selectionSource: "inspector" | "component-tree",
    target?: InspectorTargetSnapshot,
  ): void {
    this.activeTab = "components";
    this.selectedId = id;
    this.selectedTarget = target ?? null;
    this.selectedTemplateNodeId = target?.templateNodeId ?? null;
    let parentId = this.componentParentIds.get(id) ?? null;
    while (parentId) {
      this.collapsedComponentIds.delete(parentId);
      parentId = this.componentParentIds.get(parentId) ?? null;
    }
    const detail = this.bridge.getComponentDetail(id);
    if (this.selectedAppId && detail && detail.appId !== this.selectedAppId)
      this.selectedAppId = detail.appId;
    this.selectedIdentity = detail
      ? { tag: detail.tag, sourceFile: detail.source?.file ?? null }
      : null;
    const record = this.bridge.recordPipeline({
      stage: "target-snapshot",
      source: "inspector",
      kind: target ? "element.select" : "component.select",
      summary: detail
        ? `${detail.displayName} selected from ${selectionSource}`
        : `${id} selected from ${selectionSource}`,
      payload: {
        selectionSource,
        component: detail,
        ...(target ? { target } : {}),
      },
    });
    this.selectedPipelineId = record.id;
    this.persistPreferences();
    this.setVisible(true);
    this.render();
  }

  private syncControls(): void {
    this.panelToggle.setAttribute("aria-pressed", String(this.visible));
    this.inspectorToggle.setAttribute(
      "aria-pressed",
      String(this.inspector?.enabled ?? false),
    );
    this.visualToggle.setAttribute(
      "aria-pressed",
      String(this.visualTools?.enabled ?? false),
    );
  }

  private render(): void {
    const generation = ++this.renderGeneration;
    if (this.rpc) {
      void this.renderFromRpc(generation);
      return;
    }
    const snapshot = this.bridge.getSnapshot();
    this.reconcileSelection(snapshot.components);
    this.renderView(
      snapshot,
      this.selectedId ? this.bridge.getComponentDetail(this.selectedId) : null,
      this.bridge.getTimelineStatus(),
      this.bridge.getTimeline(),
      this.bridge.getPipelineState(),
      this.bridge.getCompilerState(),
    );
  }

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private reconcileSelection(
    components: readonly ComponentNodeSnapshot[],
  ): void {
    if (!this.selectedId || !this.selectedIdentity) return;
    const current = components.find((node) => node.id === this.selectedId);
    if (current) {
      this.clearSelectionRecoveryTimer();
      this.refreshSelectedTarget(current.id);
      return;
    }

    const replacements = components.filter(
      (node) =>
        node.tag === this.selectedIdentity?.tag &&
        (!this.selectedIdentity.sourceFile ||
          node.source?.file === this.selectedIdentity.sourceFile),
    );
    if (replacements.length === 1) {
      const previousId = this.selectedId;
      const replacement = replacements[0]!;
      this.selectedId = replacement.id;
      this.clearSelectionRecoveryTimer();
      this.refreshSelectedTarget(replacement.id);
      const record = this.bridge.recordPipeline({
        stage: "target-snapshot",
        source: "runtime",
        kind: "selection.restore",
        summary: `${replacement.displayName} selection restored after HMR`,
        payload: {
          previousComponentId: previousId,
          componentId: replacement.id,
          target: this.selectedTarget,
        },
      });
      this.selectedPipelineId = record.id;
      return;
    }

    if (this.selectionRecoveryTimer !== null) return;
    this.selectionRecoveryTimer =
      this.document.defaultView?.setTimeout(() => {
        this.selectionRecoveryTimer = null;
        const staleId = this.selectedId;
        const identity = this.selectedIdentity;
        this.selectedId = null;
        this.selectedTarget = null;
        this.selectedTemplateNodeId = null;
        this.selectedIdentity = null;
        const record = this.bridge.recordPipeline({
          stage: "target-snapshot",
          source: "runtime",
          kind: "selection.invalidate",
          summary: identity
            ? `${identity.tag} selection invalidated after HMR`
            : "Component selection invalidated after HMR",
          payload: {
            componentId: staleId,
            reason:
              replacements.length > 1
                ? "ambiguous-replacement"
                : "component-removed",
          },
        });
        this.selectedPipelineId = record.id;
        this.scheduleRender();
      }, 80) ?? null;
  }

  private refreshSelectedTarget(componentId: string): void {
    const templateNodeId = this.selectedTemplateNodeId;
    if (!templateNodeId) return;
    const host = this.bridge.getComponentHost(componentId);
    const element = host ? findTemplateNode(host, templateNodeId) : null;
    if (!host || !element) {
      this.selectedTarget = null;
      this.selectedTemplateNodeId = null;
      const record = this.bridge.recordPipeline({
        stage: "target-snapshot",
        source: "runtime",
        kind: "selection.invalidate",
        summary: "Template-node selection invalidated after HMR",
        payload: {
          componentId,
          templateNodeId,
          reason: "template-node-removed",
          componentSelectionPreserved: true,
        },
      });
      this.selectedPipelineId = record.id;
      return;
    }
    this.selectedTarget = createInspectorTargetSnapshot(
      this.bridge,
      componentId,
      element,
      host,
    );
  }

  private clearSelectionRecoveryTimer(): void {
    if (this.selectionRecoveryTimer === null) return;
    this.document.defaultView?.clearTimeout(this.selectionRecoveryTimer);
    this.selectionRecoveryTimer = null;
  }

  private async renderFromRpc(generation: number): Promise<void> {
    const [snapshot, timeline, pipeline, compiler] = await Promise.all([
      this.rpc!.getSnapshot(),
      this.rpc!.getTimeline(),
      this.rpc!.getPipeline(),
      this.rpc!.getCompilerState(),
    ]);
    const detail = this.selectedId
      ? await this.rpc!.getComponentDetail(this.selectedId)
      : null;
    if (generation !== this.renderGeneration) return;
    this.renderView(
      snapshot,
      detail,
      timeline.status,
      timeline.events,
      pipeline,
      compiler,
    );
  }

  private renderView(
    snapshot: DevtoolsSnapshot,
    detail: ComponentDetailSnapshot | null,
    timelineStatus: TimelineStatusSnapshot,
    timelineEvents: readonly TimelineEvent[],
    pipelineState: PipelineStateSnapshot,
    compilerState: CompilerStateSnapshot,
  ): void {
    this.content.replaceChildren();
    if (
      this.selectedAppId &&
      !snapshot.apps.some((app) => app.id === this.selectedAppId)
    ) {
      this.selectedAppId = null;
      this.persistPreferences();
    }
    const componentNodes = this.selectedAppId
      ? snapshot.components.filter(
          (component) => component.appId === this.selectedAppId,
        )
      : snapshot.components;
    const visibleDetail =
      detail && componentNodes.some((component) => component.id === detail.id)
        ? detail
        : null;

    const header = this.document.createElement("div");
    header.className = "header";
    const title = this.document.createElement("strong");
    title.textContent = `ElfUI DevTools (${componentNodes.length})`;
    const headerActions = this.document.createElement("div");
    headerActions.className = "header-actions";
    const appSelector = this.document.createElement("select");
    appSelector.className = "app-selector";
    appSelector.setAttribute("aria-label", "Select ElfUI app");
    const allApps = this.document.createElement("option");
    allApps.value = "";
    allApps.textContent = `All apps (${snapshot.apps.length})`;
    appSelector.append(allApps);
    for (const app of snapshot.apps) {
      const option = this.document.createElement("option");
      option.value = app.id;
      option.textContent = app.label;
      appSelector.append(option);
    }
    appSelector.value = this.selectedAppId ?? "";
    appSelector.onchange = () => {
      this.selectedAppId = appSelector.value || null;
      if (
        this.selectedId &&
        !snapshot.components.some(
          (component) =>
            component.id === this.selectedId &&
            (!this.selectedAppId || component.appId === this.selectedAppId),
        )
      )
        this.clearComponentSelection();
      this.persistPreferences();
      this.render();
    };
    const theme = this.document.createElement("select");
    theme.setAttribute("aria-label", "DevTools theme");
    for (const [value, label] of [
      ["system", "System theme"],
      ["light", "Light theme"],
      ["dark", "Dark theme"],
    ] as const) {
      const option = this.document.createElement("option");
      option.value = value;
      option.textContent = label;
      theme.append(option);
    }
    theme.value = this.theme;
    theme.onchange = () => {
      if (!isPanelTheme(theme.value)) return;
      this.theme = theme.value;
      this.host.dataset.theme = this.theme;
      this.persistPreferences();
    };
    const dock = this.document.createElement("select");
    dock.setAttribute("aria-label", "Dock position");
    for (const [value, label] of [
      ["floating", "Floating"],
      ["bottom", "Bottom"],
      ["left", "Left"],
      ["right", "Right"],
    ] as const) {
      const option = this.document.createElement("option");
      option.value = value;
      option.textContent = label;
      dock.appendChild(option);
    }
    dock.value = this.dock;
    dock.onchange = () => {
      if (isDockPosition(dock.value)) this.setDock(dock.value);
    };
    const fullscreen = this.document.createElement("button");
    fullscreen.type = "button";
    fullscreen.textContent = this.fullscreen ? "Restore" : "Fullscreen";
    fullscreen.setAttribute(
      "aria-label",
      this.fullscreen ? "Exit fullscreen" : "Enter fullscreen",
    );
    fullscreen.onclick = () => this.setFullscreen(!this.fullscreen);
    const close = this.document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = "Close";
    close.onclick = () => this.setVisible(false);
    headerActions.append(appSelector, theme, dock, fullscreen, close);
    header.append(title, headerActions);
    this.content.append(header);

    const navigation = this.document.createElement("nav");
    navigation.className = "navigation";
    navigation.setAttribute("role", "tablist");
    navigation.setAttribute("aria-label", "DevTools views");
    const panelTabs = [
      ["components", "Components"],
      ["timeline", "Timeline"],
      ["compiler", "Compiler"],
      ["pipeline", "Pipeline"],
    ] as const;
    for (const [tab, label] of panelTabs) {
      const button = this.document.createElement("button");
      button.type = "button";
      button.id = `elfui-devtools-tab-${tab}`;
      button.dataset.devtoolsTab = tab;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(tab === this.activeTab));
      button.setAttribute("aria-controls", `elfui-devtools-view-${tab}`);
      button.tabIndex = tab === this.activeTab ? 0 : -1;
      button.textContent = label;
      button.onclick = () => this.setActiveTab(tab, true);
      button.onkeydown = (event) => {
        const currentIndex = panelTabs.findIndex(
          ([candidate]) => candidate === tab,
        );
        let nextIndex: number | null = null;
        if (event.key === "ArrowLeft")
          nextIndex = (currentIndex - 1 + panelTabs.length) % panelTabs.length;
        else if (event.key === "ArrowRight")
          nextIndex = (currentIndex + 1) % panelTabs.length;
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = panelTabs.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        this.setActiveTab(panelTabs[nextIndex]![0], true);
      };
      navigation.append(button);
    }
    this.content.append(navigation);

    const components = this.document.createElement("section");
    components.className = "section";
    components.id = "elfui-devtools-view-components";
    components.dataset.elfuiDevtools = "components-view";
    components.setAttribute("role", "tabpanel");
    components.setAttribute("aria-labelledby", "elfui-devtools-tab-components");
    components.hidden = this.activeTab !== "components";
    const componentTools = this.document.createElement("div");
    componentTools.className = "component-tools";
    const componentsTitle = this.document.createElement("p");
    componentsTitle.className = "section-title";
    componentsTitle.textContent = "Components";
    const componentSearch = this.document.createElement("input");
    componentSearch.className = "component-search";
    componentSearch.type = "search";
    componentSearch.placeholder = "Filter components";
    componentSearch.value = this.componentQuery;
    componentSearch.setAttribute("aria-label", "Filter components");
    componentTools.append(componentsTitle, componentSearch);
    components.append(componentTools);
    const componentTree = this.document.createElement("div");
    componentTree.className = "component-tree";
    componentTree.dataset.elfuiDevtools = "component-tree";
    componentTree.setAttribute("role", "tree");
    componentTree.setAttribute("aria-label", "ElfUI component tree");
    components.append(componentTree);

    const nodeById = new Map(componentNodes.map((node) => [node.id, node]));
    this.componentParentIds.clear();
    for (const node of componentNodes)
      this.componentParentIds.set(node.id, node.parentId);
    const roots = componentNodes.filter(
      (node) => !node.parentId || !nodeById.has(node.parentId),
    );
    type VisibleComponentRow = {
      node: ComponentNodeSnapshot;
      depth: number;
    };
    let visibleRows: VisibleComponentRow[] = [];
    let virtualSpacer: HTMLDivElement | null = null;
    const componentButton = (id: string): HTMLButtonElement | undefined =>
      Array.from(
        componentTree.querySelectorAll<HTMLButtonElement>(
          "button[data-component-id]",
        ),
      ).find((candidate) => candidate.dataset.componentId === id);
    const focusVisibleComponent = (index: number): void => {
      const target = visibleRows[index];
      if (!target) return;
      let button = componentButton(target.node.id);
      if (!button && componentTree.dataset.virtualized === "true") {
        componentTree.scrollTop = index * COMPONENT_TREE_ROW_HEIGHT;
        componentTree.dispatchEvent(new Event("scroll"));
        button = componentButton(target.node.id);
      }
      button?.focus();
    };
    const restoreComponentFocus = (id: string): void => {
      queueMicrotask(() => componentButton(id)?.focus());
    };

    const createComponentRow = ({
      node,
      depth,
    }: VisibleComponentRow): HTMLDivElement => {
      const row = this.document.createElement("div");
      row.className = "component-row";
      row.setAttribute("role", "presentation");
      row.style.paddingLeft = `${depth * 14}px`;
      const toggle = this.document.createElement("button");
      toggle.className = "tree-toggle";
      toggle.type = "button";
      const collapsed = this.collapsedComponentIds.has(node.id);
      toggle.textContent = node.children.length ? (collapsed ? "▸" : "▾") : "·";
      toggle.disabled = node.children.length === 0;
      toggle.tabIndex = -1;
      toggle.setAttribute(
        "aria-label",
        `${collapsed ? "Expand" : "Collapse"} <${node.tag}>`,
      );
      toggle.onclick = () => {
        if (collapsed) this.collapsedComponentIds.delete(node.id);
        else this.collapsedComponentIds.add(node.id);
        renderComponentRows();
      };
      const button = this.document.createElement("button");
      button.className = "component";
      button.type = "button";
      button.dataset.componentId = node.id;
      button.textContent = `<${node.tag}>`;
      button.setAttribute("role", "treeitem");
      button.setAttribute("aria-level", String(depth + 1));
      button.setAttribute("aria-selected", String(node.id === this.selectedId));
      if (node.children.length)
        button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute("aria-pressed", String(node.id === this.selectedId));
      button.tabIndex =
        node.id === this.selectedId ||
        (!this.selectedId && visibleRows[0]?.node.id === node.id)
          ? 0
          : -1;
      button.onclick = () => this.selectComponent(node.id, "component-tree");
      button.onkeydown = (event) => {
        const index = visibleRows.findIndex(
          (entry) => entry.node.id === node.id,
        );
        if (event.key === "ArrowDown") {
          event.preventDefault();
          focusVisibleComponent(index + 1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          focusVisibleComponent(index - 1);
        } else if (event.key === "Home") {
          event.preventDefault();
          focusVisibleComponent(0);
        } else if (event.key === "End") {
          event.preventDefault();
          focusVisibleComponent(visibleRows.length - 1);
        } else if (event.key === "ArrowRight" && node.children.length) {
          event.preventDefault();
          if (collapsed) {
            this.collapsedComponentIds.delete(node.id);
            renderComponentRows();
            restoreComponentFocus(node.id);
          } else if (visibleRows[index + 1]?.depth === depth + 1) {
            focusVisibleComponent(index + 1);
          }
        } else if (event.key === "ArrowLeft") {
          if (node.children.length && !collapsed) {
            event.preventDefault();
            this.collapsedComponentIds.add(node.id);
            renderComponentRows();
            restoreComponentFocus(node.id);
          } else if (node.parentId) {
            event.preventDefault();
            const parentIndex = visibleRows.findIndex(
              (entry) => entry.node.id === node.parentId,
            );
            focusVisibleComponent(parentIndex);
          }
        }
      };
      row.append(toggle, button);
      return row;
    };

    const renderVirtualWindow = (): void => {
      if (!virtualSpacer) return;
      virtualSpacer.replaceChildren();
      const viewportHeight = componentTree.clientHeight || 280;
      const start = Math.max(
        0,
        Math.floor(componentTree.scrollTop / COMPONENT_TREE_ROW_HEIGHT) -
          COMPONENT_TREE_OVERSCAN,
      );
      const end = Math.min(
        visibleRows.length,
        Math.ceil(
          (componentTree.scrollTop + viewportHeight) /
            COMPONENT_TREE_ROW_HEIGHT,
        ) + COMPONENT_TREE_OVERSCAN,
      );
      const fragment = this.document.createDocumentFragment();
      for (let index = start; index < end; index += 1) {
        const row = createComponentRow(visibleRows[index]!);
        row.style.top = `${index * COMPONENT_TREE_ROW_HEIGHT}px`;
        fragment.append(row);
      }
      virtualSpacer.append(fragment);
      componentTree.dataset.renderedRows = String(end - start);
    };

    const renderComponentRows = (): void => {
      componentTree.replaceChildren();
      const query = this.componentQuery.trim().toLowerCase();
      const includedIds = new Set<string>();
      if (query) {
        for (const node of componentNodes) {
          if (
            !node.tag.toLowerCase().includes(query) &&
            !node.displayName.toLowerCase().includes(query) &&
            !node.id.toLowerCase().includes(query)
          )
            continue;
          let current: ComponentNodeSnapshot | undefined = node;
          while (current && !includedIds.has(current.id)) {
            includedIds.add(current.id);
            current = current.parentId
              ? nodeById.get(current.parentId)
              : undefined;
          }
        }
      }

      visibleRows = [];
      const stack = roots
        .slice()
        .reverse()
        .map((node) => ({ node, depth: 0 }));
      const visited = new Set<string>();
      while (stack.length) {
        const entry = stack.pop()!;
        if (visited.has(entry.node.id)) continue;
        visited.add(entry.node.id);
        if (query && !includedIds.has(entry.node.id)) continue;
        visibleRows.push(entry);
        if (!query && this.collapsedComponentIds.has(entry.node.id)) continue;
        for (
          let index = entry.node.children.length - 1;
          index >= 0;
          index -= 1
        ) {
          const child = nodeById.get(entry.node.children[index]!);
          if (child) stack.push({ node: child, depth: entry.depth + 1 });
        }
      }

      const virtualized =
        visibleRows.length >= COMPONENT_TREE_VIRTUALIZE_THRESHOLD;
      componentTree.dataset.virtualized = String(virtualized);
      if (virtualized) {
        virtualSpacer = this.document.createElement("div");
        virtualSpacer.className = "component-virtual-spacer";
        virtualSpacer.style.height = `${visibleRows.length * COMPONENT_TREE_ROW_HEIGHT}px`;
        componentTree.append(virtualSpacer);
        renderVirtualWindow();
      } else {
        virtualSpacer = null;
        const fragment = this.document.createDocumentFragment();
        for (const row of visibleRows) fragment.append(createComponentRow(row));
        componentTree.append(fragment);
        componentTree.dataset.renderedRows = String(visibleRows.length);
      }
      if (!visibleRows.length) {
        const empty = this.document.createElement("p");
        empty.className = "pipeline-empty";
        empty.textContent = "No matching components.";
        componentTree.append(empty);
      }
    };
    componentSearch.oninput = () => {
      this.componentQuery = componentSearch.value;
      componentTree.scrollTop = 0;
      renderComponentRows();
    };
    componentTree.onscroll = renderVirtualWindow;
    renderComponentRows();
    const visualDraft = this.visualTools.getDraft();
    if (
      this.visualTools.enabled ||
      visualDraft.targets.length ||
      visualDraft.intents.length ||
      visualDraft.annotations.length ||
      visualDraft.screenshotIds.length
    ) {
      const visualSection = this.document.createElement("section");
      visualSection.className = "visual-draft";
      visualSection.dataset.elfuiDevtools = "visual-draft";
      const visualTitle = this.document.createElement("p");
      visualTitle.className = "section-title";
      visualTitle.textContent = "Visual draft";
      const visualSummary = this.document.createElement("p");
      visualSummary.textContent = `${visualDraft.targets.length} target${
        visualDraft.targets.length === 1 ? "" : "s"
      } · ${visualDraft.intents.length} intent${
        visualDraft.intents.length === 1 ? "" : "s"
      } · ${visualDraft.annotations.length} annotation${
        visualDraft.annotations.length === 1 ? "" : "s"
      } · ${visualDraft.screenshotIds.length} screenshot${
        visualDraft.screenshotIds.length === 1 ? "" : "s"
      }`;
      const visualTool = this.document.createElement("select");
      visualTool.setAttribute("aria-label", "Visual draft tool");
      for (const [value, label] of [
        ["move", "Move (Ghost)"],
        ["resize", "Resize (Ghost)"],
        ["rectangle", "Rectangle"],
        ["arrow", "Arrow"],
        ["highlight", "Highlight"],
        ["comment", "Comment"],
        ["redaction", "Redact screenshot"],
      ] as const) {
        const option = this.document.createElement("option");
        option.value = value;
        option.textContent = label;
        visualTool.append(option);
      }
      visualTool.value = this.visualTools.selectedTool;
      visualTool.onchange = () => {
        if (
          visualTool.value === "move" ||
          visualTool.value === "resize" ||
          visualTool.value === "rectangle" ||
          visualTool.value === "arrow" ||
          visualTool.value === "highlight" ||
          visualTool.value === "comment" ||
          visualTool.value === "redaction"
        ) {
          this.visualTools.setTool(visualTool.value);
          this.scheduleRender();
        }
      };
      const visualComment = this.document.createElement("input");
      visualComment.className = "component-search";
      visualComment.type = "text";
      visualComment.placeholder = "Comment for the selected point";
      visualComment.setAttribute("aria-label", "Visual annotation comment");
      visualComment.value = this.visualTools.selectedCommentText;
      visualComment.disabled = this.visualTools.selectedTool !== "comment";
      visualComment.oninput = () =>
        this.visualTools.setCommentText(visualComment.value);
      const screenshotControls = this.document.createElement("div");
      screenshotControls.className = "visual-capture";
      const screenshotPhase = this.document.createElement("select");
      screenshotPhase.setAttribute("aria-label", "Screenshot phase");
      for (const [value, label] of [
        ["before", "Before"],
        ["desired", "Desired"],
      ] as const) {
        const option = this.document.createElement("option");
        option.value = value;
        option.textContent = label;
        screenshotPhase.append(option);
      }
      screenshotPhase.value = this.screenshotPhase;
      screenshotPhase.onchange = () => {
        if (
          screenshotPhase.value === "before" ||
          screenshotPhase.value === "desired"
        )
          this.screenshotPhase = screenshotPhase.value;
      };
      const screenshotKind = this.document.createElement("select");
      screenshotKind.setAttribute("aria-label", "Screenshot area");
      for (const [value, label] of [
        ["viewport", "Viewport"],
        ["selection", "Target + draft"],
      ] as const) {
        const option = this.document.createElement("option");
        option.value = value;
        option.textContent = label;
        screenshotKind.append(option);
      }
      screenshotKind.value = this.screenshotKind;
      screenshotKind.onchange = () => {
        if (
          screenshotKind.value === "viewport" ||
          screenshotKind.value === "selection"
        )
          this.screenshotKind = screenshotKind.value;
      };
      const captureScreenshot = this.document.createElement("button");
      captureScreenshot.type = "button";
      captureScreenshot.textContent = this.capturingScreenshot
        ? "Capturing…"
        : "Capture";
      captureScreenshot.setAttribute("aria-label", "Capture visual screenshot");
      captureScreenshot.title = this.screenshots
        ? "The browser will ask you to share the current tab."
        : "Browser tab capture is unavailable.";
      captureScreenshot.disabled =
        !this.screenshots ||
        this.capturingScreenshot ||
        (this.screenshotKind === "selection" &&
          visualDraft.targets.length === 0);
      captureScreenshot.onclick = () => void this.captureVisualScreenshot();
      screenshotControls.append(
        screenshotPhase,
        screenshotKind,
        captureScreenshot,
      );
      if (this.screenshotStatus) {
        const screenshotStatus = this.document.createElement("p");
        screenshotStatus.className = "visual-capture-status";
        screenshotStatus.setAttribute("role", "status");
        screenshotStatus.textContent = this.screenshotStatus;
        screenshotControls.append(screenshotStatus);
      }
      const clearVisual = this.document.createElement("button");
      clearVisual.type = "button";
      clearVisual.textContent = "Clear visual draft";
      clearVisual.setAttribute("aria-label", "Clear visual draft");
      clearVisual.onclick = () => {
        this.visualTools.clear();
        this.render();
      };
      const undoVisual = this.document.createElement("button");
      undoVisual.type = "button";
      undoVisual.textContent = "Undo draft";
      undoVisual.setAttribute("aria-label", "Undo visual draft change");
      undoVisual.disabled = !this.visualTools.canUndo;
      undoVisual.onclick = () => {
        this.visualTools.undo();
        this.screenshots?.retainAssets(
          this.visualTools.getDraft().screenshotIds,
        );
      };
      const prepareAIRequest = this.document.createElement("button");
      prepareAIRequest.type = "button";
      prepareAIRequest.textContent = "Prepare AI request";
      prepareAIRequest.title =
        "Freeze the current visual draft into a provider-neutral request. No model is contacted.";
      prepareAIRequest.setAttribute("aria-label", "Prepare AI change request");
      prepareAIRequest.disabled =
        visualDraft.targets.length === 0 &&
        visualDraft.intents.length === 0 &&
        visualDraft.annotations.length === 0 &&
        visualDraft.screenshotIds.length === 0;
      prepareAIRequest.onclick = () => {
        this.aiContext.build({
          conversationId: `conversation:${visualDraft.id}`,
          ...(this.screenshots
            ? { screenshots: this.screenshots.getAssets() }
            : {}),
        });
        this.activeTab = "pipeline";
        this.persistPreferences();
        this.render();
      };
      visualSection.append(
        visualTitle,
        visualSummary,
        visualTool,
        visualComment,
        screenshotControls,
        prepareAIRequest,
        undoVisual,
        clearVisual,
      );
      components.append(visualSection);
    }
    this.content.append(components);

    const timelineSection = this.document.createElement("section");
    timelineSection.className = "section";
    timelineSection.id = "elfui-devtools-view-timeline";
    timelineSection.setAttribute("role", "tabpanel");
    timelineSection.setAttribute(
      "aria-labelledby",
      "elfui-devtools-tab-timeline",
    );
    timelineSection.hidden = this.activeTab !== "timeline";
    const timelineHeading = this.document.createElement("div");
    timelineHeading.className = "section-heading";
    const timelineTitle = this.document.createElement("p");
    timelineTitle.className = "section-title";
    const statusParts = [
      timelineStatus.aggregatedEvents
        ? `${timelineStatus.aggregatedEvents} aggregated`
        : "",
      timelineStatus.droppedEvents
        ? `${timelineStatus.droppedEvents} dropped`
        : "",
    ].filter(Boolean);
    timelineTitle.textContent = `Recent timeline${statusParts.length ? ` (${statusParts.join(", ")})` : ""}`;
    const timelineActions = this.document.createElement("div");
    timelineActions.className = "timeline-actions";
    const pause = this.document.createElement("button");
    pause.type = "button";
    pause.textContent = timelineStatus.paused ? "Resume" : "Pause";
    pause.setAttribute(
      "aria-label",
      timelineStatus.paused ? "Resume timeline" : "Pause timeline",
    );
    pause.onclick = () => {
      if (this.rpc) {
        void this.rpc
          .setTimelinePaused(!timelineStatus.paused)
          .then(() => this.render());
      } else {
        this.bridge.setTimelinePaused(!timelineStatus.paused);
        this.render();
      }
    };
    const clear = this.document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.setAttribute("aria-label", "Clear timeline");
    clear.onclick = () => {
      if (this.rpc) {
        void this.rpc.clearTimeline().then(() => this.render());
      } else {
        this.bridge.clearTimeline();
        this.render();
      }
    };
    timelineActions.append(pause, clear);
    timelineHeading.append(timelineTitle, timelineActions);
    const timeline = this.document.createElement("ol");
    timeline.dataset.elfuiDevtools = "timeline";
    for (const event of timelineEvents.slice(-20).reverse()) {
      const item = this.document.createElement("li");
      item.textContent = `${event.layer}:${event.type} — ${event.summary}`;
      timeline.append(item);
    }
    timelineSection.append(timelineHeading, timeline);
    this.content.append(timelineSection);

    const compilerSection = this.renderCompilerState(compilerState);
    compilerSection.id = "elfui-devtools-view-compiler";
    compilerSection.setAttribute("role", "tabpanel");
    compilerSection.setAttribute(
      "aria-labelledby",
      "elfui-devtools-tab-compiler",
    );
    compilerSection.hidden = this.activeTab !== "compiler";
    const pipelineSection = this.renderPipeline(pipelineState);
    pipelineSection.id = "elfui-devtools-view-pipeline";
    pipelineSection.setAttribute("role", "tabpanel");
    pipelineSection.setAttribute(
      "aria-labelledby",
      "elfui-devtools-tab-pipeline",
    );
    pipelineSection.hidden = this.activeTab !== "pipeline";

    if (!visibleDetail) return;
    const detailNode = this.document.createElement("section");
    detailNode.className = "component-detail";
    detailNode.dataset.elfuiDevtools = "component-detail";
    detailNode.setAttribute("aria-label", "Component details");
    const detailHeading = this.document.createElement("h3");
    detailHeading.className = "detail-heading";
    detailHeading.textContent = visibleDetail.displayName;
    const detailGrid = this.document.createElement("div");
    detailGrid.className = "detail-grid";
    const source = visibleDetail.source
      ? `${visibleDetail.source.file}:${visibleDetail.source.line}:${visibleDetail.source.column}`
      : "unavailable";

    const appendDetailValue = (
      label: string,
      value: string,
      wide = false,
    ): void => {
      const block = this.document.createElement("section");
      block.className = "detail-block";
      if (wide) block.dataset.wide = "true";
      const title = this.document.createElement("h4");
      title.className = "detail-label";
      title.textContent = label;
      const content = this.document.createElement("pre");
      content.className = "detail-value";
      content.textContent = value;
      block.append(title, content);
      detailGrid.append(block);
    };

    appendDetailValue("Props", valueText(visibleDetail.props));
    appendDetailValue("Attributes", valueText(visibleDetail.attrs));
    appendDetailValue("Setup", valueText(visibleDetail.setup));
    appendDetailValue("Expose", valueText(visibleDetail.exposed));
    appendDetailValue("Source", source, true);
    appendDetailValue(
      "Lifecycle",
      [
        `updates: ${visibleDetail.lifecycle.updateCount}`,
        `last update: ${visibleDetail.lifecycle.lastUpdatedAt ?? "never"}`,
        `error: ${
          visibleDetail.lifecycle.error
            ? valueText(visibleDetail.lifecycle.error)
            : "none"
        }`,
      ].join("\n"),
      true,
    );

    const bindingsBlock = this.document.createElement("section");
    bindingsBlock.className = "detail-block";
    bindingsBlock.dataset.wide = "true";
    const bindingsTitle = this.document.createElement("h4");
    bindingsTitle.className = "detail-label";
    bindingsTitle.textContent = `Bindings (${visibleDetail.bindings.length})`;
    const bindings = this.document.createElement("ul");
    bindings.className = "detail-list";
    bindings.setAttribute("aria-label", "Component bindings");
    for (const binding of visibleDetail.bindings) {
      const item = this.document.createElement("li");
      const location = binding.source
        ? `${binding.source.file}:${binding.source.line}:${binding.source.column}`
        : "source unavailable";
      item.textContent = binding.name;
      const metadata = this.document.createElement("small");
      metadata.textContent = `${location} · ${binding.runCount} runs · ${binding.triggerCount} triggers${
        binding.lastDuration === null ? "" : ` · ${binding.lastDuration}ms`
      }`;
      item.append(metadata);
      bindings.append(item);
    }
    if (!visibleDetail.bindings.length) {
      const empty = this.document.createElement("li");
      empty.textContent = "No binding activity captured.";
      bindings.append(empty);
    }
    bindingsBlock.append(bindingsTitle, bindings);
    detailGrid.append(bindingsBlock);

    const diagnosticsBlock = this.document.createElement("section");
    diagnosticsBlock.className = "detail-block";
    diagnosticsBlock.dataset.wide = "true";
    const diagnosticsTitle = this.document.createElement("h4");
    diagnosticsTitle.className = "detail-label";
    diagnosticsTitle.textContent = `Diagnostics (${visibleDetail.diagnostics.length})`;
    const diagnostics = this.document.createElement("ul");
    diagnostics.className = "detail-list";
    diagnostics.setAttribute("aria-label", "Component diagnostics");
    for (const diagnostic of visibleDetail.diagnostics) {
      const item = this.document.createElement("li");
      item.dataset.severity = diagnostic.severity;
      item.textContent = `${diagnostic.code}: ${diagnostic.message}`;
      const context = [
        diagnostic.fragment ? `fragment ${diagnostic.fragment}` : "",
        diagnostic.source
          ? `${diagnostic.source.file}:${diagnostic.source.line}:${diagnostic.source.column}`
          : "",
        diagnostic.hint ?? "",
      ].filter(Boolean);
      if (context.length) {
        const metadata = this.document.createElement("small");
        metadata.textContent = context.join(" · ");
        item.append(metadata);
      }
      diagnostics.append(item);
    }
    if (!visibleDetail.diagnostics.length) {
      const empty = this.document.createElement("li");
      empty.textContent = "No compiler diagnostics.";
      diagnostics.append(empty);
    }
    diagnosticsBlock.append(diagnosticsTitle, diagnostics);
    detailGrid.append(diagnosticsBlock);
    detailNode.append(detailHeading, detailGrid);
    components.append(detailNode);
    if (visibleDetail.source) {
      const sourceLocation = visibleDetail.source;
      const openButton = this.document.createElement("button");
      openButton.className = "source-action";
      openButton.type = "button";
      openButton.textContent = "Open in editor";
      openButton.setAttribute("aria-label", "Open component source in editor");
      openButton.onclick = () => {
        openButton.disabled = true;
        void this.openSource(sourceLocation)
          .catch((error: unknown) => {
            openButton.title =
              error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            openButton.disabled = false;
          });
      };
      detailNode.append(openButton);
    }
  }

  private renderPipeline(state: PipelineStateSnapshot): HTMLElement {
    const section = this.document.createElement("section");
    section.className = "section";
    section.dataset.elfuiDevtools = "pipeline";

    const heading = this.document.createElement("div");
    heading.className = "section-heading";
    const title = this.document.createElement("p");
    title.className = "section-title";
    title.textContent = `Data pipeline (${state.records.length}${state.droppedRecords ? `, ${state.droppedRecords} evicted` : ""})`;
    const clear = this.document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.setAttribute("aria-label", "Clear data pipeline");
    clear.onclick = () => {
      this.selectedPipelineId = null;
      if (this.rpc) {
        void this.rpc.clearPipeline().then(() => this.render());
      } else {
        this.bridge.clearPipeline();
        this.render();
      }
    };
    const actions = this.document.createElement("div");
    actions.className = "timeline-actions";
    actions.append(clear);
    heading.append(title, actions);
    section.append(heading);

    if (state.records.length === 0) {
      const empty = this.document.createElement("p");
      empty.className = "pipeline-empty";
      empty.textContent = "No pipeline records yet.";
      section.append(empty);
      this.content.append(section);
      return section;
    }

    const selected: PipelineRecord =
      state.records.find((record) => record.id === this.selectedPipelineId) ??
      state.records.at(-1)!;
    const list = this.document.createElement("ul");
    list.className = "pipeline-list";
    for (const record of state.records.slice(-12).reverse()) {
      const item = this.document.createElement("li");
      const button = this.document.createElement("button");
      button.type = "button";
      button.className = "pipeline-record";
      button.dataset.pipelineRecordId = record.id;
      button.setAttribute("aria-pressed", String(record.id === selected.id));
      const stage = this.document.createElement("strong");
      stage.textContent = record.stage;
      button.append(
        stage,
        this.document.createTextNode(
          ` · ${record.source}/${record.kind}\n${record.summary}`,
        ),
      );
      button.onclick = () => {
        this.selectedPipelineId = record.id;
        this.render();
      };
      item.append(button);
      list.append(item);
    }
    section.append(list);

    const payload = this.document.createElement("pre");
    payload.className = "pipeline-json";
    payload.dataset.elfuiDevtools = "pipeline-json";
    payload.textContent = JSON.stringify(selected, null, 2);
    section.append(payload);
    this.content.append(section);
    return section;
  }

  private renderCompilerState(state: CompilerStateSnapshot): HTMLElement {
    const section = this.document.createElement("section");
    section.className = "section";
    section.dataset.elfuiDevtools = "compiler-state";
    const title = this.document.createElement("p");
    title.className = "section-title";
    title.textContent = `Compiler metadata (${state.artifacts.length} artifacts, revision ${state.revision})`;
    section.append(title);

    if (state.artifacts.length === 0) {
      const empty = this.document.createElement("p");
      empty.className = "pipeline-empty";
      empty.textContent =
        "No compiler data. Pass devtools.compiler to elfuiMacroPlugin().";
      section.append(empty);
      this.content.append(section);
      return section;
    }

    const metadata = new Map<string, CompilerArtifact>();
    const diagnostics = new Map<string, CompilerArtifact>();
    for (const artifact of state.artifacts) {
      const target = artifact.kind === "metadata" ? metadata : diagnostics;
      target.set(artifact.sourceId, artifact);
    }
    const sourceIds = [...new Set([...metadata.keys(), ...diagnostics.keys()])];
    const selectedSourceId =
      sourceIds.find(
        (sourceId) => sourceId === this.selectedCompilerSourceId,
      ) ?? sourceIds[0]!;
    const list = this.document.createElement("ul");
    list.className = "pipeline-list";
    for (const sourceId of sourceIds) {
      const metadataArtifact = metadata.get(sourceId);
      const diagnosticsArtifact = diagnostics.get(sourceId);
      const metadataValue =
        metadataArtifact?.payload !== null &&
        typeof metadataArtifact?.payload === "object"
          ? (metadataArtifact.payload as Record<string, unknown>)
          : null;
      const componentCount = Array.isArray(metadataValue?.components)
        ? metadataValue.components.length
        : 0;
      const fragmentCount = Array.isArray(metadataValue?.fragments)
        ? metadataValue.fragments.length
        : 0;
      const diagnosticCount = Array.isArray(diagnosticsArtifact?.payload)
        ? diagnosticsArtifact.payload.length
        : 0;
      const item = this.document.createElement("li");
      const button = this.document.createElement("button");
      button.type = "button";
      button.className = "pipeline-record";
      button.dataset.compilerSourceId = sourceId;
      button.setAttribute(
        "aria-pressed",
        String(sourceId === selectedSourceId),
      );
      const source = this.document.createElement("strong");
      source.textContent = sourceId;
      button.append(
        source,
        this.document.createTextNode(
          `\n${componentCount} components · ${fragmentCount} fragments · ${diagnosticCount} diagnostics`,
        ),
      );
      button.onclick = () => {
        this.selectedCompilerSourceId = sourceId;
        this.render();
      };
      item.append(button);
      list.append(item);
    }
    section.append(list);

    const detail = this.document.createElement("pre");
    detail.className = "pipeline-json";
    detail.dataset.elfuiDevtools = "compiler-json";
    detail.textContent = JSON.stringify(
      {
        sourceId: selectedSourceId,
        metadata: metadata.get(selectedSourceId) ?? null,
        diagnostics: diagnostics.get(selectedSourceId) ?? null,
      },
      null,
      2,
    );
    section.append(detail);
    this.content.append(section);
    return section;
  }
}
