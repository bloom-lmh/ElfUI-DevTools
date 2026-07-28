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
  historyLimit?: number;
}

export interface VisualToolsControllerOptions {
  document?: Document;
  onDraftChange?: (draft: VisualDraft) => void;
}

export type VisualTool = "move" | "resize" | VisualAnnotationType;

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

const copyAnnotation = (annotation: VisualAnnotation): VisualAnnotation => ({
  ...annotation,
  targetIds: [...annotation.targetIds],
  ...(annotation.geometry ? { geometry: copyRect(annotation.geometry) } : {}),
  ...(annotation.from ? { from: { ...annotation.from } } : {}),
  ...(annotation.to ? { to: { ...annotation.to } } : {}),
});

const copyDraft = (draft: VisualDraft): VisualDraft => ({
  ...draft,
  targets: draft.targets.map(copyTarget),
  intents: draft.intents.map(copyIntent),
  annotations: draft.annotations.map(copyAnnotation),
  screenshotIds: [...draft.screenshotIds],
});

export class VisualIntentSession {
  private readonly now: () => number;
  private readonly historyLimit: number;
  private draft: VisualDraft;
  private readonly history: VisualDraft[] = [];

  public constructor(
    private readonly bridge: ElfUIDevtoolsBridge,
    options: VisualIntentSessionOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.historyLimit = options.historyLimit ?? 50;
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

  public get canUndo(): boolean {
    return this.history.length > 0;
  }

  public getDraft(): VisualDraft {
    return copyDraft(this.draft);
  }

  public captureTarget(target: VisualTarget): VisualTarget {
    this.pushHistory();
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
    this.pushHistory();
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

  public previewResize(targetId: string, desired: RectSnapshot): VisualIntent {
    const target = this.draft.targets.find(
      (candidate) => candidate.id === targetId,
    );
    if (!target) throw new Error(`Unknown visual target "${targetId}"`);
    this.pushHistory();
    const intent: VisualIntent = {
      id: `visual-intent:resize:${targetId}`,
      type: "resize",
      targetId,
      before: copyRect(target.geometry),
      desired: copyRect(desired),
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
      kind: "visual.resize.preview",
      summary: `Previewed resizing ${targetId}`,
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
    this.pushHistory();
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
    if (!this.draft.screenshotIds.includes(screenshotId)) {
      this.pushHistory();
      this.draft.screenshotIds.push(screenshotId);
    }
  }

  public undo(): VisualDraft | null {
    const previous = this.history.pop();
    if (!previous) return null;
    this.draft = previous;
    this.bridge.recordPipeline({
      taskId: this.draft.id,
      stage: "visual-intent",
      source: "visual-tools",
      kind: "visual.draft.undo",
      summary: "Undid the latest visual draft change",
      payload: {
        draftId: this.draft.id,
        remainingHistory: this.history.length,
      },
    });
    return this.getDraft();
  }

  public restore(draft: VisualDraft): VisualDraft {
    if (draft.schemaVersion !== DEVTOOLS_VISUAL_SCHEMA_VERSION)
      throw new Error(
        `Unsupported visual draft schema ${String(draft.schemaVersion)}`,
      );
    this.pushHistory();
    this.draft = copyDraft(draft);
    this.bridge.recordPipeline({
      taskId: this.draft.id,
      stage: "visual-intent",
      source: "visual-tools",
      kind: "visual.draft.restore",
      summary: `Restored visual draft ${this.draft.id}`,
      payload: {
        draftId: this.draft.id,
        targets: this.draft.targets.length,
        intents: this.draft.intents.length,
        annotations: this.draft.annotations.length,
        screenshots: this.draft.screenshotIds.length,
      },
    });
    return this.getDraft();
  }

  public clear(): void {
    if (
      this.draft.targets.length ||
      this.draft.intents.length ||
      this.draft.annotations.length ||
      this.draft.screenshotIds.length
    )
      this.pushHistory();
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

  private pushHistory(): void {
    if (this.historyLimit <= 0) return;
    this.history.push(this.getDraft());
    if (this.history.length > this.historyLimit) this.history.shift();
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
  type: "move" | "resize";
  targetId: string;
  before: RectSnapshot;
  pointerX: number;
  pointerY: number;
}

interface VisualAnnotationState {
  type: VisualAnnotationType;
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
  private commentText = "";
  private nextAnnotationId = 1;
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

  public get canUndo(): boolean {
    return this.session.canUndo;
  }

  public attachScreenshot(screenshotId: string): void {
    this.session.attachScreenshot(screenshotId);
    this.onDraftChange?.(this.session.getDraft());
  }

  public get selectedTool(): VisualTool {
    return this.tool;
  }

  public get selectedCommentText(): string {
    return this.commentText;
  }

  public setTool(tool: VisualTool): void {
    this.tool = tool;
    this.drag = null;
    this.annotation = null;
  }

  public setCommentText(text: string): void {
    this.commentText = text;
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

  public undo(): void {
    if (!this.session.undo()) return;
    this.ghost.style.display = "none";
    this.renderAnnotations();
    this.onDraftChange?.(this.session.getDraft());
  }

  public restore(draft: VisualDraft): void {
    this.session.restore(draft);
    this.ghost.style.display = "none";
    this.renderAnnotations();
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
    if (this.tool === "move" || this.tool === "resize") {
      if (!visualTarget) return;
      const inspector = createInspectorTargetSnapshot(
        this.bridge,
        componentId!,
        target,
        host!,
      );
      this.drag = {
        type: this.tool,
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
      else if (this.tool === "comment")
        this.positionGhost({
          x: event.clientX - 6,
          y: event.clientY - 6,
          width: 12,
          height: 12,
        });
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
      const desired = this.dragRect(this.drag, event);
      this.positionGhost(desired);
    } else if (
      this.annotation &&
      this.annotation.type !== "highlight" &&
      this.annotation.type !== "comment"
    ) {
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
      const desired = this.dragRect(this.drag, event);
      if (this.drag.type === "move")
        this.session.previewMove(this.drag.targetId, desired);
      else this.session.previewResize(this.drag.targetId, desired);
      this.drag = null;
      this.positionGhost(desired);
    } else if (this.annotation) {
      const annotation = this.annotation;
      if (annotation.type === "comment") {
        const text = this.commentText.trim();
        this.session.addAnnotation({
          id: this.annotationId(),
          type: "comment",
          targetIds: annotation.targetIds,
          ...(text ? { text } : {}),
          from: { x: annotation.startX, y: annotation.startY },
          createdAt: this.now(),
        });
      } else if (annotation.type === "highlight" && annotation.targetGeometry) {
        this.session.addAnnotation({
          id: this.annotationId(),
          type: "highlight",
          targetIds: annotation.targetIds,
          geometry: annotation.targetGeometry,
          createdAt: this.now(),
        });
      } else if (annotation.type === "arrow") {
        this.session.addAnnotation({
          id: this.annotationId(),
          type: "arrow",
          targetIds: annotation.targetIds,
          from: { x: annotation.startX, y: annotation.startY },
          to: { x: event.clientX, y: event.clientY },
          createdAt: this.now(),
        });
      } else {
        this.session.addAnnotation({
          id: this.annotationId(),
          type: annotation.type === "redaction" ? "redaction" : "rectangle",
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

  private annotationId(): string {
    return `annotation:${this.session.id}:${this.now()}:${this.nextAnnotationId++}`;
  }

  private dragRect(drag: VisualDragState, event: PointerEvent): RectSnapshot {
    const deltaX = event.clientX - drag.pointerX;
    const deltaY = event.clientY - drag.pointerY;
    return drag.type === "move"
      ? {
          ...drag.before,
          x: drag.before.x + deltaX,
          y: drag.before.y + deltaY,
        }
      : {
          ...drag.before,
          width: Math.max(1, drag.before.width + deltaX),
          height: Math.max(1, drag.before.height + deltaY),
        };
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
            : annotation.type === "redaction"
              ? "2px solid #111827"
              : "2px solid #ef4444";
        marker.style.background =
          annotation.type === "highlight"
            ? "rgb(250 204 21 / 12%)"
            : annotation.type === "redaction"
              ? "#111827"
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
      } else if (annotation.type === "comment" && annotation.from) {
        marker.style.left = `${annotation.from.x}px`;
        marker.style.top = `${annotation.from.y}px`;
        marker.style.maxWidth = "240px";
        marker.style.border = "1px solid #f97316";
        marker.style.borderRadius = "999px";
        marker.style.padding = "4px 8px";
        marker.style.background = "#431407";
        marker.style.color = "#ffedd5";
        marker.style.font = "600 11px system-ui";
        marker.textContent = annotation.text ?? "Comment";
      }
      this.annotationLayer.append(marker);
    }
  }
}
