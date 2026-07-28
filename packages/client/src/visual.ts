import {
  DEVTOOLS_VISUAL_SCHEMA_VERSION,
  type RectSnapshot,
  type VisualAnnotation,
  type VisualDraft,
  type VisualIntent,
  type VisualRelation,
  type VisualTarget,
} from "@elfui/devtools-shared";
import type { ElfUIDevtoolsBridge } from "@elfui/devtools-runtime";
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

  public clear(): void {
    this.draft.targets.length = 0;
    this.draft.intents.length = 0;
    this.draft.annotations.length = 0;
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

export class VisualToolsController {
  private readonly document: Document;
  private readonly session: VisualIntentSession;
  private readonly overlay: HTMLDivElement;
  private readonly ghost: HTMLDivElement;
  private active = false;
  private drag: VisualDragState | null = null;

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
    this.overlay.append(this.ghost);
    this.document.body.append(this.overlay);
    this.onDraftChange = options.onDraftChange;
  }

  private onDraftChange: ((draft: VisualDraft) => void) | undefined;

  public get enabled(): boolean {
    return this.active;
  }

  public getDraft(): VisualDraft {
    return this.session.getDraft();
  }

  public enable(): void {
    if (this.active) return;
    this.active = true;
    this.overlay.style.display = "block";
    this.document.addEventListener("pointerdown", this.onPointerDown, true);
    this.document.addEventListener("pointermove", this.onPointerMove, true);
    this.document.addEventListener("pointerup", this.onPointerUp, true);
  }

  public disable(): void {
    if (!this.active) return;
    this.active = false;
    this.drag = null;
    this.overlay.style.display = "none";
    this.ghost.style.display = "none";
    this.document.removeEventListener("pointerdown", this.onPointerDown, true);
    this.document.removeEventListener("pointermove", this.onPointerMove, true);
    this.document.removeEventListener("pointerup", this.onPointerUp, true);
  }

  public clear(): void {
    this.session.clear();
    this.ghost.style.display = "none";
    this.onDraftChange?.(this.session.getDraft());
  }

  public dispose(): void {
    this.disable();
    this.overlay.remove();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.active || event.button !== 0) return;
    const target = firstElement(event);
    if (!target) return;
    const host = hostForTarget(this.bridge, target);
    if (!host) return;
    const componentId = this.bridge.getComponentId(host);
    if (!componentId) return;
    const inspector = createInspectorTargetSnapshot(
      this.bridge,
      componentId,
      target,
      host,
    );
    const visualTarget = createVisualTargetSnapshot(
      this.bridge,
      componentId,
      target,
      host,
    );
    const before = { ...visualTarget.geometry };
    this.session.captureTarget(visualTarget);
    this.drag = {
      targetId: visualTarget.id,
      before,
      pointerX: event.clientX,
      pointerY: event.clientY,
    };
    this.ghost.dataset.targetId = visualTarget.id;
    this.ghost.dataset.sourcePrecision = inspector.sourcePrecision;
    this.positionGhost(before);
    event.preventDefault();
    event.stopPropagation();
    this.onDraftChange?.(this.session.getDraft());
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.drag) return;
    const desired = {
      ...this.drag.before,
      x: this.drag.before.x + event.clientX - this.drag.pointerX,
      y: this.drag.before.y + event.clientY - this.drag.pointerY,
    };
    this.positionGhost(desired);
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.drag) return;
    const desired = {
      ...this.drag.before,
      x: this.drag.before.x + event.clientX - this.drag.pointerX,
      y: this.drag.before.y + event.clientY - this.drag.pointerY,
    };
    this.session.previewMove(this.drag.targetId, desired);
    this.drag = null;
    this.positionGhost(desired);
    event.preventDefault();
    event.stopPropagation();
    this.onDraftChange?.(this.session.getDraft());
  };

  private positionGhost(rect: RectSnapshot): void {
    this.ghost.style.left = `${rect.x}px`;
    this.ghost.style.top = `${rect.y}px`;
    this.ghost.style.width = `${rect.width}px`;
    this.ghost.style.height = `${rect.height}px`;
    this.ghost.style.display = "block";
  }
}
