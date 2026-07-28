import {
  DEVTOOLS_VISUAL_SCHEMA_VERSION,
  type RectSnapshot,
  type VisualAnnotation,
  type VisualAnnotationType,
  type VisualDraft,
  type VisualIntent,
  type VisualRelation,
  type VisualTarget,
} from "@elfui/devtools-shared";
import {
  getElfUIRenderRoot,
  type ElfUIDevtoolsBridge,
} from "@elfui/devtools-runtime";
import {
  createInspectorTargetSnapshot,
  createVisualTargetSnapshot,
} from "./index.js";

export interface VisualIntentSessionOptions {
  now?: () => number;
  draftId?: string;
}

export interface VisualToolsControllerOptions {
  document?: Document;
  onDraftChange?: (draft: VisualDraft) => void;
}

export type VisualTool = "move" | Exclude<VisualAnnotationType, "comment">;

const copyRect = (rect: RectSnapshot): RectSnapshot => ({ ...rect });

const copyTarget = (target: VisualTarget): VisualTarget => ({
  ...target,
  inspector: {
    ...target.inspector,
    element: { ...target.inspector.element },
    ...(target.inspector.source
      ? { source: { ...target.inspector.source } }
      : {}),
  },
  ...(target.source
    ? {
        source: {
          ...target.source,
          ...(target.source.range ? { range: { ...target.source.range } } : {}),
        },
      }
    : {}),
  geometry: copyRect(target.geometry),
  ...(target.computedStyle
    ? { computedStyle: { ...target.computedStyle } }
    : {}),
  ...(target.bindings
    ? { bindings: target.bindings.map((binding) => ({ ...binding })) }
    : {}),
});

const copyIntent = (intent: VisualIntent): VisualIntent => {
  if (intent.type === "move")
    return {
      ...intent,
      before: copyRect(intent.before),
      desired: copyRect(intent.desired),
      relations: intent.relations.map((relation) => ({ ...relation })),
    };
  if (intent.type === "resize")
    return {
      ...intent,
      before: copyRect(intent.before),
      desired: copyRect(intent.desired),
    };
  if (intent.type === "style")
    return {
      ...intent,
      before: { ...intent.before },
      desired: { ...intent.desired },
    };
  return { ...intent };
};

export class VisualIntentSession {
  private readonly now: () => number;
  private readonly draft: VisualDraft;

  public constructor(
    private readonly bridge: ElfUIDevtoolsBridge,
    options: VisualIntentSessionOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.draft = {
      schemaVersion: DEVTOOLS_VISUAL_SCHEMA_VERSION,
      id: options.draftId ?? `visual-draft:${this.now()}`,
      targets: [],
      intents: [],
      annotations: [],
      screenshotIds: [],
    };
  }

  public get id(): string {
    return this.draft.id;
  }

  public getDraft(): VisualDraft {
    return {
      ...this.draft,
      targets: this.draft.targets.map(copyTarget),
      intents: this.draft.intents.map(copyIntent),
      annotations: this.draft.annotations.map((annotation) => ({
        ...annotation,
        targetIds: [...annotation.targetIds],
        ...(annotation.geometry
          ? { geometry: copyRect(annotation.geometry) }
          : {}),
        ...(annotation.from ? { from: { ...annotation.from } } : {}),
        ...(annotation.to ? { to: { ...annotation.to } } : {}),
      })),
      screenshotIds: [...this.draft.screenshotIds],
    };
  }

  public captureTarget(target: VisualTarget): VisualTarget {
    const index = this.draft.targets.findIndex(
      (candidate) => candidate.id === target.id,
    );
    if (index === -1) this.draft.targets.push(copyTarget(target));
    else this.draft.targets[index] = copyTarget(target);
    this.bridge.recordPipeline({
      taskId: this.draft.id,
      stage: "target-snapshot",
      source: "visual-tools",
      kind: "visual.target.capture",
      summary: `Captured visual target ${target.id}`,
      payload: target,
    });
    return copyTarget(target);
  }

  public previewMove(
    targetId: string,
    desired: RectSnapshot,
    relations: VisualRelation[] = [],
  ): VisualIntent {
    const target = this.draft.targets.find(
      (candidate) => candidate.id === targetId,
    );
    if (!target) throw new Error(`Unknown visual target "${targetId}"`);
    const intent: VisualIntent = {
      id: `visual-intent:move:${targetId}`,
      type: "move",
      targetId,
      before: copyRect(target.geometry),
      desired: copyRect(desired),
      relations: relations.map((relation) => ({ ...relation })),
    };
    const index = this.draft.intents.findIndex(
      (candidate) => candidate.id === intent.id,
    );
    if (index === -1) this.draft.intents.push(intent);
    else this.draft.intents[index] = intent;
    this.bridge.recordPipeline({
      taskId: this.draft.id,
      stage: "visual-intent",
      source: "visual-tools",
      kind: "visual.move.preview",
      summary: `Previewed moving ${targetId}`,
      payload: intent,
    });
    return {
      ...intent,
      before: copyRect(intent.before),
      desired: copyRect(intent.desired),
    };
  }

  public addAnnotation(annotation: VisualAnnotation): VisualAnnotation {
    const missingTarget = annotation.targetIds.find(
      (targetId) =>
        !this.draft.targets.some((candidate) => candidate.id === targetId),
    );
    if (missingTarget)
      throw new Error(`Unknown visual target "${missingTarget}"`);
    this.draft.annotations.push({
      ...annotation,
      targetIds: [...annotation.targetIds],
    });
    this.bridge.recordPipeline({
      taskId: this.draft.id,
      stage: "visual-intent",
      source: "visual-tools",
      kind: "visual.annotation.add",
      summary: `Added ${annotation.type} annotation`,
      payload: annotation,
    });
    return { ...annotation, targetIds: [...annotation.targetIds] };
  }

  public attachScreenshot(screenshotId: string): void {
    if (!this.draft.screenshotIds.includes(screenshotId))
      this.draft.screenshotIds.push(screenshotId);
  }

  public clear(): void {
    this.draft.targets.length = 0;
    this.draft.intents.length = 0;
    this.draft.annotations.length = 0;
    this.draft.screenshotIds.length = 0;
    this.bridge.recordPipeline({
      taskId: this.draft.id,
      stage: "visual-intent",
      source: "visual-tools",
      kind: "visual.draft.clear",
      summary: "Cleared visual draft",
      payload: { draftId: this.draft.id },
    });
  }
}

const firstElement = (event: Event): Element | null =>
  event
    .composedPath()
    .find((candidate): candidate is Element => candidate instanceof Element) ??
  null;

const hostForTarget = (
  bridge: ElfUIDevtoolsBridge,
  target: Element,
): HTMLElement | null => {
  let current: Element | null = target;
  while (current) {
    if (current instanceof HTMLElement && bridge.getComponentId(current))
      return current;
    current =
      current.parentElement ??
      (current.getRootNode() instanceof ShadowRoot
        ? (current.getRootNode() as ShadowRoot).host
        : null);
  }
  return null;
};

interface VisualDragState {
  targetId: string;
  before: RectSnapshot;
  pointerX: number;
  pointerY: number;
}

interface VisualAnnotationState {
  type: Exclude<VisualAnnotationType, "comment">;
  startX: number;
  startY: number;
  targetIds: string[];
  targetGeometry?: RectSnapshot;
}

export class VisualToolsController {
  private readonly document: Document;
  private readonly session: VisualIntentSession;
  private readonly overlay: HTMLDivElement;
  private readonly ghost: HTMLDivElement;
  private readonly annotationLayer: HTMLDivElement;
  private active = false;
  private tool: VisualTool = "move";
  private drag: VisualDragState | null = null;
  private annotation: VisualAnnotationState | null = null;
  private readonly observedClosedRoots = new Set<ShadowRoot>();

  public constructor(
    private readonly bridge: ElfUIDevtoolsBridge,
    options: VisualToolsControllerOptions = {},
  ) {
    this.document = options.document ?? document;
    this.session = new VisualIntentSession(bridge);
    this.overlay = this.document.createElement("div");
    this.overlay.dataset.elfuiDevtools = "visual-overlay";
    this.overlay.setAttribute("aria-hidden", "true");
    this.overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483645;display:none;pointer-events:none";
    this.annotationLayer = this.document.createElement("div");
    this.annotationLayer.dataset.elfuiDevtools = "visual-annotation-layer";
    this.annotationLayer.style.cssText =
      "position:fixed;inset:0;pointer-events:none";
    this.ghost = this.document.createElement("div");
    this.ghost.dataset.elfuiDevtools = "visual-ghost";
    this.ghost.style.cssText = [
      "position:fixed",
      "display:none",
      "box-sizing:border-box",
      "border:2px dashed #f97316",
      "border-radius:4px",
      "background:rgb(249 115 22 / 12%)",
      "pointer-events:none",
    ].join(";");
    this.overlay.append(this.annotationLayer, this.ghost);
    this.document.body.append(this.overlay);
    this.onDraftChange = options.onDraftChange;
  }

  private onDraftChange: ((draft: VisualDraft) => void) | undefined;

  public get enabled(): boolean {
    return this.active;
  }

  public get id(): string {
    return this.session.id;
  }

  public getDraft(): VisualDraft {
    return this.session.getDraft();
  }

  public attachScreenshot(screenshotId: string): void {
    this.session.attachScreenshot(screenshotId);
    this.onDraftChange?.(this.session.getDraft());
  }

  public get selectedTool(): VisualTool {
    return this.tool;
  }

  public setTool(tool: VisualTool): void {
    this.tool = tool;
    this.drag = null;
    this.annotation = null;
  }

  public enable(): void {
    if (this.active) return;
    this.active = true;
    this.overlay.style.display = "block";
    this.syncClosedRootListeners();
    this.document.addEventListener("pointerdown", this.onPointerDown, true);
    this.document.addEventListener("pointermove", this.onPointerMove, true);
    this.document.addEventListener("pointerup", this.onPointerUp, true);
  }

  public disable(): void {
    if (!this.active) return;
    this.active = false;
    this.drag = null;
    this.annotation = null;
    this.overlay.style.display = "none";
    this.ghost.style.display = "none";
    this.document.removeEventListener("pointerdown", this.onPointerDown, true);
    this.document.removeEventListener("pointermove", this.onPointerMove, true);
    this.document.removeEventListener("pointerup", this.onPointerUp, true);
    for (const root of this.observedClosedRoots) {
      root.removeEventListener("pointerdown", this.onRootPointerDown, true);
      root.removeEventListener("pointermove", this.onRootPointerMove, true);
      root.removeEventListener("pointerup", this.onRootPointerUp, true);
    }
    this.observedClosedRoots.clear();
  }

  public clear(): void {
    this.session.clear();
    this.ghost.style.display = "none";
    this.annotationLayer.replaceChildren();
    this.onDraftChange?.(this.session.getDraft());
  }

  public dispose(): void {
    this.disable();
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
      if (this.observedClosedRoots.has(root)) continue;
      root.addEventListener("pointerdown", this.onRootPointerDown, true);
      root.addEventListener("pointermove", this.onRootPointerMove, true);
      root.addEventListener("pointerup", this.onRootPointerUp, true);
    }
    for (const root of this.observedClosedRoots)
      if (!next.has(root)) {
        root.removeEventListener("pointerdown", this.onRootPointerDown, true);
        root.removeEventListener("pointermove", this.onRootPointerMove, true);
        root.removeEventListener("pointerup", this.onRootPointerUp, true);
      }
    this.observedClosedRoots.clear();
    for (const root of next) this.observedClosedRoots.add(root);
  }

  private readonly onRootPointerDown: EventListener = (event) =>
    this.onPointerDown(event as PointerEvent);
  private readonly onRootPointerMove: EventListener = (event) =>
    this.onPointerMove(event as PointerEvent);
  private readonly onRootPointerUp: EventListener = (event) =>
    this.onPointerUp(event as PointerEvent);

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.active || event.button !== 0) return;
    const target = firstElement(event);
    if (!target) return;
    const host = hostForTarget(this.bridge, target);
    const componentId = host ? this.bridge.getComponentId(host) : null;
    const visualTarget =
      host && componentId
        ? createVisualTargetSnapshot(this.bridge, componentId, target, host)
        : null;
    if (visualTarget) this.session.captureTarget(visualTarget);
    if (this.tool === "move") {
      if (!visualTarget) return;
      const inspector = createInspectorTargetSnapshot(
        this.bridge,
        componentId!,
        target,
        host!,
      );
      this.drag = {
        targetId: visualTarget.id,
        before: { ...visualTarget.geometry },
        pointerX: event.clientX,
        pointerY: event.clientY,
      };
      this.ghost.dataset.targetId = visualTarget.id;
      this.ghost.dataset.sourcePrecision = inspector.sourcePrecision;
      this.positionGhost(visualTarget.geometry);
    } else {
      if (this.tool === "highlight" && !visualTarget) return;
      this.annotation = {
        type: this.tool,
        startX: event.clientX,
        startY: event.clientY,
        targetIds: visualTarget ? [visualTarget.id] : [],
        ...(visualTarget ? { targetGeometry: visualTarget.geometry } : {}),
      };
      this.ghost.dataset.tool = this.tool;
      if (this.tool === "highlight" && visualTarget)
        this.positionGhost(visualTarget.geometry);
      else
        this.positionGhost({
          x: event.clientX,
          y: event.clientY,
          width: 0,
          height: 0,
        });
    }
    event.preventDefault();
    event.stopPropagation();
    this.onDraftChange?.(this.session.getDraft());
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.drag) {
      const desired = {
        ...this.drag.before,
        x: this.drag.before.x + event.clientX - this.drag.pointerX,
        y: this.drag.before.y + event.clientY - this.drag.pointerY,
      };
      this.positionGhost(desired);
    } else if (this.annotation && this.annotation.type !== "highlight") {
      this.positionGhost(
        this.annotationRect(
          this.annotation.startX,
          this.annotation.startY,
          event.clientX,
          event.clientY,
        ),
      );
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.drag) {
      const desired = {
        ...this.drag.before,
        x: this.drag.before.x + event.clientX - this.drag.pointerX,
        y: this.drag.before.y + event.clientY - this.drag.pointerY,
      };
      this.session.previewMove(this.drag.targetId, desired);
      this.drag = null;
      this.positionGhost(desired);
    } else if (this.annotation) {
      const annotation = this.annotation;
      if (annotation.type === "highlight" && annotation.targetGeometry) {
        this.session.addAnnotation({
          id: `annotation:${this.session.id}:${this.now()}`,
          type: "highlight",
          targetIds: annotation.targetIds,
          geometry: annotation.targetGeometry,
          createdAt: this.now(),
        });
      } else if (annotation.type === "arrow") {
        this.session.addAnnotation({
          id: `annotation:${this.session.id}:${this.now()}`,
          type: "arrow",
          targetIds: annotation.targetIds,
          from: { x: annotation.startX, y: annotation.startY },
          to: { x: event.clientX, y: event.clientY },
          createdAt: this.now(),
        });
      } else {
        this.session.addAnnotation({
          id: `annotation:${this.session.id}:${this.now()}`,
          type: "rectangle",
          targetIds: annotation.targetIds,
          geometry: this.annotationRect(
            annotation.startX,
            annotation.startY,
            event.clientX,
            event.clientY,
          ),
          createdAt: this.now(),
        });
      }
      this.annotation = null;
      this.renderAnnotations();
    } else return;
    event.preventDefault();
    event.stopPropagation();
    this.onDraftChange?.(this.session.getDraft());
  };

  private now(): number {
    return Date.now();
  }

  private annotationRect(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): RectSnapshot {
    return {
      x: Math.min(startX, endX),
      y: Math.min(startY, endY),
      width: Math.abs(endX - startX),
      height: Math.abs(endY - startY),
    };
  }

  private positionGhost(rect: RectSnapshot): void {
    this.ghost.style.left = `${rect.x}px`;
    this.ghost.style.top = `${rect.y}px`;
    this.ghost.style.width = `${rect.width}px`;
    this.ghost.style.height = `${rect.height}px`;
    this.ghost.style.display = "block";
  }

  private renderAnnotations(): void {
    this.annotationLayer.replaceChildren();
    for (const annotation of this.session.getDraft().annotations) {
      const marker = this.document.createElement("div");
      marker.dataset.annotationId = annotation.id;
      marker.dataset.annotationType = annotation.type;
      marker.style.position = "fixed";
      marker.style.pointerEvents = "none";
      marker.style.boxSizing = "border-box";
      if (annotation.geometry) {
        marker.style.left = `${annotation.geometry.x}px`;
        marker.style.top = `${annotation.geometry.y}px`;
        marker.style.width = `${annotation.geometry.width}px`;
        marker.style.height = `${annotation.geometry.height}px`;
        marker.style.border =
          annotation.type === "highlight"
            ? "2px solid #facc15"
            : "2px solid #ef4444";
        marker.style.background =
          annotation.type === "highlight"
            ? "rgb(250 204 21 / 12%)"
            : "rgb(239 68 68 / 8%)";
      } else if (annotation.from && annotation.to) {
        const dx = annotation.to.x - annotation.from.x;
        const dy = annotation.to.y - annotation.from.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        marker.style.left = `${annotation.from.x}px`;
        marker.style.top = `${annotation.from.y}px`;
        marker.style.width = `${length}px`;
        marker.style.height = "0";
        marker.style.borderTop = "2px solid #ef4444";
        marker.style.transformOrigin = "0 0";
        marker.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
      }
      this.annotationLayer.append(marker);
    }
  }
}
