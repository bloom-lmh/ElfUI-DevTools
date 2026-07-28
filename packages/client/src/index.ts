import {
  getElfUIRenderRoot,
  type ElfUIDevtoolsBridge,
} from "@elfui/devtools-runtime";
import {
  ELFUI_TEMPLATE_NODE_DEBUG_KEY,
  type InspectorTargetSnapshot,
  type VisualTarget,
  type SourceLocation,
  type TemplateNodeDebugInfo,
} from "@elfui/devtools-shared";

export interface ComponentInspectorOptions {
  document?: Document;
  onSelect?: (componentId: string, target: InspectorTargetSnapshot) => void;
  onEnabledChange?: (enabled: boolean) => void;
}

type WeakRegistry<K extends object, V> = Pick<WeakMap<K, V>, "get" | "set">;

const TEMPLATE_NODE_REGISTRY_KEY = Symbol.for(
  "elfui.devtools.template-node-registry",
);

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

const isWeakRegistry = <K extends object, V>(
  value: unknown,
): value is WeakRegistry<K, V> =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { get?: unknown }).get === "function" &&
  typeof (value as { set?: unknown }).set === "function";

const templateNodeRegistry = (): WeakRegistry<
  Node,
  TemplateNodeDebugInfo
> | null => {
  try {
    const value = (globalThis as unknown as Record<symbol, unknown>)[
      TEMPLATE_NODE_REGISTRY_KEY
    ];
    return isWeakRegistry<Node, TemplateNodeDebugInfo>(value) ? value : null;
  } catch {
    return null;
  }
};

const readTemplateNodeDebugInfo = (
  node: Node,
  registry: WeakRegistry<Node, TemplateNodeDebugInfo> | null,
  mirrorKey: symbol,
): TemplateNodeDebugInfo | null => {
  if (registry) {
    try {
      const value = registry.get(node);
      if (isTemplateNodeDebugInfo(value)) return value;
    } catch {
      // Fall through to the beta.14 compatibility mirror.
    }
  }
  try {
    const value = (node as unknown as Record<symbol, unknown>)[mirrorKey];
    return isTemplateNodeDebugInfo(value) ? value : null;
  } catch {
    return null;
  }
};

const templateNodeDebugInfo = (
  target: Element,
  host: HTMLElement,
): TemplateNodeDebugInfo | null => {
  const registry = templateNodeRegistry();
  const key = Symbol.for(ELFUI_TEMPLATE_NODE_DEBUG_KEY);
  let current: Element | null = target;
  while (current) {
    const value = readTemplateNodeDebugInfo(current, registry, key);
    if (value) return value;
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

export const createInspectorTargetSnapshot = (
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

const visualTargetId = (
  componentId: string,
  target: InspectorTargetSnapshot,
): string =>
  `visual-target:${componentId}:${target.templateNodeId ?? target.domPath}`;

export const createVisualTargetSnapshot = (
  bridge: ElfUIDevtoolsBridge,
  componentId: string,
  target: Element,
  host: HTMLElement,
): VisualTarget => {
  const inspector = createInspectorTargetSnapshot(
    bridge,
    componentId,
    target,
    host,
  );
  const bounds = target.getBoundingClientRect();
  const styles = target.ownerDocument.defaultView?.getComputedStyle(target);
  const detail = bridge.getComponentDetail(componentId);
  return {
    id: visualTargetId(componentId, inspector),
    runtimeNodeId: inspector.templateNodeId ?? inspector.domPath,
    componentId,
    inspector,
    ...(inspector.source
      ? {
          source: {
            sourceId:
              inspector.sourceId ??
              inspector.source.file ??
              "runtime-unresolved",
            ...(inspector.fragment ? { fragment: inspector.fragment } : {}),
            ...(inspector.templateNodeId
              ? { templateNodeId: inspector.templateNodeId }
              : {}),
            range: inspector.source,
          },
        }
      : {}),
    geometry: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    },
    ...(styles
      ? {
          computedStyle: {
            display: styles.display,
            position: styles.position,
            margin: styles.margin,
            padding: styles.padding,
            width: styles.width,
            height: styles.height,
          },
        }
      : {}),
    ...(detail
      ? {
          props: detail.props,
          bindings: detail.bindings.map((binding) => ({ ...binding })),
        }
      : {}),
  };
};

export const findTemplateNode = (
  host: HTMLElement,
  templateNodeId: string,
): Element | null => {
  const root = getElfUIRenderRoot(host);
  if (!root) return null;
  const registry = templateNodeRegistry();
  const key = Symbol.for(ELFUI_TEMPLATE_NODE_DEBUG_KEY);
  const candidates: Element[] = [
    ...(root instanceof Element ? [root] : []),
    ...Array.from(root.querySelectorAll("*")),
  ];
  return (
    candidates.find((candidate) => {
      const marker = readTemplateNodeDebugInfo(candidate, registry, key);
      return marker?.templateNodeId === templateNodeId;
    }) ?? null
  );
};

const firstElement = (event: Event): Element | null =>
  event
    .composedPath()
    .find((target): target is Element => target instanceof Element) ?? null;

interface InspectorHoverCandidate {
  target: Element;
  host: HTMLElement;
  componentId: string;
}

export class ComponentInspector {
  private readonly document: Document;
  private readonly overlay: HTMLDivElement;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private hoveredId: string | null = null;
  private hoveredElement: Element | null = null;
  private hoveredTarget: InspectorTargetSnapshot | null = null;
  private pendingHover: InspectorHoverCandidate | null = null;
  private hoverPending = false;
  private hoverFrame: number | null = null;
  private active = false;
  private readonly observedClosedRoots = new Set<ShadowRoot>();
  private readonly stopBridge: () => void;

  public constructor(
    private readonly bridge: ElfUIDevtoolsBridge,
    private readonly options: ComponentInspectorOptions = {},
  ) {
    this.document = options.document ?? document;
    const view = this.document.defaultView;
    this.requestFrame = view?.requestAnimationFrame
      ? view.requestAnimationFrame.bind(view)
      : (callback) => {
          queueMicrotask(() => callback(performance.now()));
          return -1;
        };
    this.cancelFrame = view?.cancelAnimationFrame
      ? view.cancelAnimationFrame.bind(view)
      : () => undefined;
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
    this.stopBridge = bridge.on(() => {
      if (this.active) this.syncClosedRootListeners();
    });
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
    this.syncClosedRootListeners();
    this.options.onEnabledChange?.(true);
  }

  public disable(): void {
    if (!this.active) return;
    this.active = false;
    this.hoveredId = null;
    this.hoveredElement = null;
    this.hoveredTarget = null;
    this.pendingHover = null;
    this.hoverPending = false;
    if (this.hoverFrame !== null) this.cancelFrame(this.hoverFrame);
    this.hoverFrame = null;
    this.overlay.style.display = "none";
    this.document.removeEventListener("pointermove", this.onPointerMove, true);
    this.document.removeEventListener("click", this.onClick, true);
    this.document.removeEventListener("keydown", this.onKeyDown, true);
    for (const root of this.observedClosedRoots) this.removeRootListeners(root);
    this.observedClosedRoots.clear();
    this.options.onEnabledChange?.(false);
  }

  public dispose(): void {
    this.disable();
    this.stopBridge();
    this.overlay.remove();
  }

  private syncClosedRootListeners(): void {
    const next = new Set<ShadowRoot>();
    for (const component of this.bridge.getSnapshot().components) {
      const host = this.bridge.getComponentHost(component.id);
      if (!host) continue;
      const root = getElfUIRenderRoot(host);
      if (!(root instanceof ShadowRoot) || host.shadowRoot === root) continue;
      next.add(root);
      if (!this.observedClosedRoots.has(root)) this.addRootListeners(root);
    }
    for (const root of this.observedClosedRoots)
      if (!next.has(root)) this.removeRootListeners(root);
    this.observedClosedRoots.clear();
    for (const root of next) this.observedClosedRoots.add(root);
  }

  private addRootListeners(root: ShadowRoot): void {
    root.addEventListener("pointermove", this.onRootPointerMove, true);
    root.addEventListener("click", this.onRootClick, true);
    root.addEventListener("keydown", this.onRootKeyDown, true);
  }

  private removeRootListeners(root: ShadowRoot): void {
    root.removeEventListener("pointermove", this.onRootPointerMove, true);
    root.removeEventListener("click", this.onRootClick, true);
    root.removeEventListener("keydown", this.onRootKeyDown, true);
  }

  private readonly onRootPointerMove: EventListener = (event) =>
    this.onPointerMove(event as PointerEvent);

  private readonly onRootClick: EventListener = (event) =>
    this.onClick(event as MouseEvent);

  private readonly onRootKeyDown: EventListener = (event) =>
    this.onKeyDown(event as KeyboardEvent);

  private readonly onPointerMove = (event: PointerEvent): void => {
    const target = firstElement(event);
    const host = event
      .composedPath()
      .map((target) => findRegisteredHost(this.bridge, target))
      .find((candidate): candidate is HTMLElement => candidate !== null);
    const id = host ? this.bridge.getComponentId(host) : null;
    this.pendingHover =
      target && host && id ? { target, host, componentId: id } : null;
    this.hoverPending = true;
    if (this.hoverFrame !== null) return;
    this.hoverFrame = this.requestFrame(() => {
      this.hoverFrame = null;
      this.commitPendingHover();
    });
  };

  private commitPendingHover(): void {
    if (!this.hoverPending) return;
    this.hoverPending = false;
    const candidate = this.pendingHover;
    this.pendingHover = null;
    if (!candidate) {
      this.hoveredId = null;
      this.hoveredElement = null;
      this.hoveredTarget = null;
      this.overlay.style.display = "none";
      return;
    }
    const { componentId, host, target } = candidate;
    this.hoveredId = componentId;
    this.hoveredElement = target;
    this.hoveredTarget = createInspectorTargetSnapshot(
      this.bridge,
      componentId,
      target,
      host,
    );
    const bounds = target.getBoundingClientRect();
    this.overlay.dataset.componentId = componentId;
    this.overlay.dataset.sourcePrecision = this.hoveredTarget.sourcePrecision;
    if (this.hoveredTarget.templateNodeId)
      this.overlay.dataset.templateNodeId = this.hoveredTarget.templateNodeId;
    else delete this.overlay.dataset.templateNodeId;
    this.overlay.style.left = `${bounds.left}px`;
    this.overlay.style.top = `${bounds.top}px`;
    this.overlay.style.width = `${bounds.width}px`;
    this.overlay.style.height = `${bounds.height}px`;
    this.overlay.style.display = "block";
  }

  private flushPendingHover(): void {
    if (!this.hoverPending) return;
    if (this.hoverFrame !== null) this.cancelFrame(this.hoverFrame);
    this.hoverFrame = null;
    this.commitPendingHover();
  }

  private readonly onClick = (event: MouseEvent): void => {
    this.flushPendingHover();
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
export { VisualIntentSession, VisualToolsController } from "./visual.js";
export type {
  VisualIntentSessionOptions,
  VisualToolsControllerOptions,
} from "./visual.js";
export { AIContextBuilder, ScreenshotController } from "./context.js";
export type {
  AIContextBuilderOptions,
  BuildAIChangeRequestInput,
  CapturedScreenshotAsset,
  ScreenshotCaptureAdapter,
  ScreenshotCaptureInput,
  ScreenshotCaptureResult,
  ScreenshotControllerOptions,
} from "./context.js";
