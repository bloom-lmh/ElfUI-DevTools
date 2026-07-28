import type { ElfUIDevtoolsBridge } from "@elfui/devtools-runtime";
import {
  ELFUI_TEMPLATE_NODE_DEBUG_KEY,
  type InspectorTargetSnapshot,
  type SourceLocation,
  type TemplateNodeDebugInfo,
} from "@elfui/devtools-shared";

export interface ComponentInspectorOptions {
  document?: Document;
  onSelect?: (componentId: string, target: InspectorTargetSnapshot) => void;
}

const findRegisteredHost = (
  bridge: ElfUIDevtoolsBridge,
  target: EventTarget | null,
): HTMLElement | null => {
  let current = target instanceof HTMLElement ? target : null;
  while (current) {
    if (bridge.getComponentId(current)) return current;
    const root = current.getRootNode();
    current =
      current.parentElement ??
      (root instanceof ShadowRoot && root.host instanceof HTMLElement
        ? root.host
        : null);
  }
  return null;
};

const parentElementAcrossShadow = (element: Element): Element | null => {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
};

const isSourceLocation = (value: unknown): value is SourceLocation => {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.file === "string" &&
    typeof source.line === "number" &&
    typeof source.column === "number"
  );
};

const isTemplateNodeDebugInfo = (
  value: unknown,
): value is TemplateNodeDebugInfo => {
  if (!value || typeof value !== "object") return false;
  const marker = value as Record<string, unknown>;
  return (
    typeof marker.sourceId === "string" &&
    typeof marker.templateNodeId === "string" &&
    isSourceLocation(marker.source)
  );
};

const templateNodeDebugInfo = (
  target: Element,
  host: HTMLElement,
): TemplateNodeDebugInfo | null => {
  const key = Symbol.for(ELFUI_TEMPLATE_NODE_DEBUG_KEY);
  let current: Element | null = target;
  while (current) {
    const value = (current as unknown as Record<symbol, unknown>)[key];
    if (isTemplateNodeDebugInfo(value)) return value;
    if (current === host) break;
    current = parentElementAcrossShadow(current);
  }
  return null;
};

const elementSegment = (element: Element): string => {
  const id = element.getAttribute("id");
  if (id) return `${element.localName}#${id}`;
  const parent = element.parentElement;
  if (!parent) return element.localName;
  const siblings = Array.from(parent.children).filter(
    (candidate) => candidate.localName === element.localName,
  );
  const index = siblings.indexOf(element);
  return siblings.length > 1
    ? `${element.localName}:nth-of-type(${index + 1})`
    : element.localName;
};

const domPathFor = (target: Element, host: HTMLElement): string => {
  const segments: string[] = [];
  let current: Element | null = target;
  while (current) {
    segments.unshift(elementSegment(current));
    if (current === host) break;
    current = parentElementAcrossShadow(current);
  }
  return segments.join(" > ");
};

const sourceWithFile = (
  source: SourceLocation,
  sourceId: string,
): SourceLocation => ({ ...source, file: source.file || sourceId });

const snapshotTarget = (
  bridge: ElfUIDevtoolsBridge,
  componentId: string,
  target: Element,
  host: HTMLElement,
): InspectorTargetSnapshot => {
  const marker = templateNodeDebugInfo(target, host);
  const componentSource = bridge.getComponentDetail(componentId)?.source;
  const text = target.textContent?.replace(/\s+/gu, " ").trim().slice(0, 160);
  const source = marker
    ? sourceWithFile(marker.source, marker.sourceId)
    : componentSource;
  return {
    componentId,
    domPath: domPathFor(target, host),
    element: {
      tag: target.localName,
      ...(target.id ? { id: target.id } : {}),
      classes: Array.from(target.classList),
      ...(target.getAttribute("role")
        ? { role: target.getAttribute("role")! }
        : {}),
      ...(text ? { text } : {}),
    },
    sourcePrecision: marker
      ? "template-node"
      : componentSource
        ? "component"
        : "unresolved",
    ...(source ? { source } : {}),
    ...(marker
      ? {
          sourceId: marker.sourceId,
          templateNodeId: marker.templateNodeId,
          ...(marker.fragment ? { fragment: marker.fragment } : {}),
        }
      : {}),
  };
};

const firstElement = (event: Event): Element | null =>
  event
    .composedPath()
    .find((target): target is Element => target instanceof Element) ?? null;

export class ComponentInspector {
  private readonly document: Document;
  private readonly overlay: HTMLDivElement;
  private hoveredId: string | null = null;
  private hoveredElement: Element | null = null;
  private hoveredTarget: InspectorTargetSnapshot | null = null;
  private active = false;

  public constructor(
    private readonly bridge: ElfUIDevtoolsBridge,
    private readonly options: ComponentInspectorOptions = {},
  ) {
    this.document = options.document ?? document;
    this.overlay = this.document.createElement("div");
    this.overlay.setAttribute("aria-hidden", "true");
    this.overlay.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "display:none",
      "pointer-events:none",
      "box-sizing:border-box",
      "border:2px solid #38bdf8",
      "background:rgb(56 189 248 / 14%)",
    ].join(";");
    this.document.body.appendChild(this.overlay);
  }

  public get enabled(): boolean {
    return this.active;
  }

  public enable(): void {
    if (this.active) return;
    this.active = true;
    this.document.addEventListener("pointermove", this.onPointerMove, true);
    this.document.addEventListener("click", this.onClick, true);
    this.document.addEventListener("keydown", this.onKeyDown, true);
  }

  public disable(): void {
    if (!this.active) return;
    this.active = false;
    this.hoveredId = null;
    this.hoveredElement = null;
    this.hoveredTarget = null;
    this.overlay.style.display = "none";
    this.document.removeEventListener("pointermove", this.onPointerMove, true);
    this.document.removeEventListener("click", this.onClick, true);
    this.document.removeEventListener("keydown", this.onKeyDown, true);
  }

  public dispose(): void {
    this.disable();
    this.overlay.remove();
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const target = firstElement(event);
    const host = event
      .composedPath()
      .map((target) => findRegisteredHost(this.bridge, target))
      .find((candidate): candidate is HTMLElement => candidate !== null);
    const id = host ? this.bridge.getComponentId(host) : null;
    if (!target || !host || !id) {
      this.hoveredId = null;
      this.hoveredElement = null;
      this.hoveredTarget = null;
      this.overlay.style.display = "none";
      return;
    }
    this.hoveredId = id;
    this.hoveredElement = target;
    this.hoveredTarget = snapshotTarget(this.bridge, id, target, host);
    const bounds = target.getBoundingClientRect();
    this.overlay.dataset.componentId = id;
    this.overlay.dataset.sourcePrecision = this.hoveredTarget.sourcePrecision;
    if (this.hoveredTarget.templateNodeId)
      this.overlay.dataset.templateNodeId = this.hoveredTarget.templateNodeId;
    else delete this.overlay.dataset.templateNodeId;
    this.overlay.style.left = `${bounds.left}px`;
    this.overlay.style.top = `${bounds.top}px`;
    this.overlay.style.width = `${bounds.width}px`;
    this.overlay.style.height = `${bounds.height}px`;
    this.overlay.style.display = "block";
  };

  private readonly onClick = (event: MouseEvent): void => {
    const target = firstElement(event);
    const host = event
      .composedPath()
      .map((target) => findRegisteredHost(this.bridge, target))
      .find((candidate): candidate is HTMLElement => candidate !== null);
    if (
      !host ||
      !target ||
      !this.hoveredId ||
      target !== this.hoveredElement ||
      !this.hoveredTarget ||
      this.bridge.getComponentId(host) !== this.hoveredId
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    this.options.onSelect?.(this.hoveredId, this.hoveredTarget);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.disable();
  };
}

export { DevtoolsPanel } from "./panel.js";
export {
  ingestCompilerArtifact,
  ingestCompilerSnapshot,
  installElfUIDevtools,
} from "./bootstrap.js";
export { openSourceInEditor, type OpenSourceInEditor } from "./source.js";
export {
  DevtoolsRpcClient,
  DevtoolsRpcClientError,
  type DevtoolsRpcClientOptions,
} from "./rpc-client.js";
