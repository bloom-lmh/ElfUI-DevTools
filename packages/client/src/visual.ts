import {
  DEVTOOLS_VISUAL_SCHEMA_VERSION,
  isVisualDraft,
  type RectSnapshot,
  type VisualAnnotation,
  type VisualAnnotationType,
  type VisualDraft,
  type VisualIntent,
  type VisualMotionTransition,
  type VisualMotionTrigger,
  type VisualRelation,
  type VisualTarget,
} from "@elfui/devtools-visual-intent";
import {
  getElfUIRenderRoot,
  type ElfUIDevtoolsBridge,
} from "@elfui/devtools-runtime";
import {
  createInspectorTargetSnapshot,
  createVisualTargetSnapshot,
  findTemplateNode,
} from "./index.js";

export interface VisualIntentSessionOptions {
  now?: () => number;
  draftId?: string;
  historyLimit?: number;
}

export interface VisualToolsControllerOptions {
  document?: Document;
  onDraftChange?: (draft: VisualDraft) => void;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  storageKey?: string;
  reconcileDelay?: number;
}

export const DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY =
  "elfui-devtools:visual-draft:v1";

export type VisualTool =
  | "style"
  | "motion"
  | "move"
  | "resize"
  | VisualAnnotationType;

interface PersistedVisualDraft {
  route: string;
  draft: VisualDraft;
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
  if (intent.type === "motion")
    return {
      ...intent,
      desired: {
        ...intent.desired,
        properties: [...intent.desired.properties],
      },
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

  public rebindTarget(
    targetId: string,
    target: VisualTarget,
    reason = "target-relocated",
  ): VisualTarget {
    const index = this.draft.targets.findIndex(
      (candidate) => candidate.id === targetId,
    );
    if (index === -1) throw new Error(`Unknown visual target "${targetId}"`);
    const rebound = copyTarget({ ...target, id: targetId });
    this.draft.targets[index] = rebound;
    this.bridge.recordPipeline({
      taskId: this.draft.id,
      stage: "target-snapshot",
      source: "visual-tools",
      kind: "visual.target.rebind",
      summary: `Rebound visual target ${targetId}`,
      payload: { reason, target: rebound },
    });
    return copyTarget(rebound);
  }

  public invalidateTargets(
    targetIds: readonly string[],
    reason: string,
  ): VisualDraft {
    const invalidIds = new Set(
      targetIds.filter((targetId) =>
        this.draft.targets.some((target) => target.id === targetId),
      ),
    );
    if (!invalidIds.size) return this.getDraft();

    const removedIntents = this.draft.intents.filter(
      (intent) =>
        invalidIds.has(intent.targetId) ||
        (intent.type === "move" &&
          intent.relations.some((relation) =>
            invalidIds.has(relation.targetId),
          )),
    );
    const removedIntentIds = new Set(removedIntents.map((intent) => intent.id));
    const repairedAnnotations: string[] = [];
    const removedAnnotations: string[] = [];
    const nextAnnotations: VisualAnnotation[] = [];

    for (const annotation of this.draft.annotations) {
      const targetIds = annotation.targetIds.filter(
        (targetId) => !invalidIds.has(targetId),
      );
      if (targetIds.length === annotation.targetIds.length) {
        nextAnnotations.push(annotation);
        continue;
      }
      if (
        !targetIds.length &&
        !annotation.geometry &&
        !annotation.from &&
        !annotation.to
      ) {
        removedAnnotations.push(annotation.id);
        continue;
      }
      repairedAnnotations.push(annotation.id);
      nextAnnotations.push({ ...annotation, targetIds });
    }

    this.draft.targets = this.draft.targets.filter(
      (target) => !invalidIds.has(target.id),
    );
    this.draft.intents = this.draft.intents.filter(
      (intent) => !removedIntentIds.has(intent.id),
    );
    this.draft.annotations = nextAnnotations;
    this.history.length = 0;

    for (const targetId of invalidIds)
      this.bridge.recordPipeline({
        taskId: this.draft.id,
        stage: "visual-intent",
        source: "visual-tools",
        kind: "visual.target.invalidate",
        summary: `Invalidated visual target ${targetId}`,
        payload: {
          targetId,
          reason,
          removedIntentIds: removedIntents
            .filter(
              (intent) =>
                intent.targetId === targetId ||
                (intent.type === "move" &&
                  intent.relations.some(
                    (relation) => relation.targetId === targetId,
                  )),
            )
            .map((intent) => intent.id),
          repairedAnnotationIds: repairedAnnotations,
          removedAnnotationIds: removedAnnotations,
        },
      });
    return this.getDraft();
  }

  public invalidateDraft(
    reason: string,
    details: Record<string, unknown> = {},
  ): VisualDraft {
    const discarded = {
      targets: this.draft.targets.length,
      intents: this.draft.intents.length,
      annotations: this.draft.annotations.length,
      screenshots: this.draft.screenshotIds.length,
    };
    this.draft.targets.length = 0;
    this.draft.intents.length = 0;
    this.draft.annotations.length = 0;
    this.draft.screenshotIds.length = 0;
    this.history.length = 0;
    this.bridge.recordPipeline({
      taskId: this.draft.id,
      stage: "visual-intent",
      source: "visual-tools",
      kind: "visual.draft.invalidate",
      summary: `Invalidated visual draft: ${reason}`,
      payload: { draftId: this.draft.id, reason, discarded, ...details },
    });
    return this.getDraft();
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

  public previewStyle(
    targetId: string,
    property: string,
    value: string,
  ): VisualIntent {
    const target = this.draft.targets.find(
      (candidate) => candidate.id === targetId,
    );
    if (!target) throw new Error(`Unknown visual target "${targetId}"`);
    this.pushHistory();
    const id = `visual-intent:style:${targetId}`;
    const existing = this.draft.intents.find(
      (candidate): candidate is Extract<VisualIntent, { type: "style" }> =>
        candidate.id === id && candidate.type === "style",
    );
    const intent: Extract<VisualIntent, { type: "style" }> = {
      id,
      type: "style",
      targetId,
      before: {
        ...(existing?.before ?? {}),
        [property]:
          existing?.before[property] ?? target.computedStyle?.[property] ?? "",
      },
      desired: {
        ...(existing?.desired ?? {}),
        [property]: value,
      },
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
      kind: "visual.style.preview",
      summary: `Previewed ${property} on ${targetId}`,
      payload: intent,
    });
    return copyIntent(intent);
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

  public previewMotion(
    targetId: string,
    desired: VisualMotionTransition,
  ): VisualIntent {
    const target = this.draft.targets.find(
      (candidate) => candidate.id === targetId,
    );
    if (!target) throw new Error(`Unknown visual target "${targetId}"`);
    const properties = [
      ...new Set(
        desired.properties
          .map((property) => property.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (
      properties.length === 0 ||
      properties.some(
        (property) => !/^(?:--[a-z0-9_-]+|[a-z][a-z0-9-]*)$/u.test(property),
      )
    )
      throw new Error("Motion transition requires valid CSS properties");
    if (
      !Number.isFinite(desired.durationMs) ||
      desired.durationMs < 0 ||
      !Number.isFinite(desired.delayMs) ||
      desired.delayMs < 0 ||
      !desired.easing.trim()
    )
      throw new Error("Motion transition timing is invalid");
    this.pushHistory();
    const intent: Extract<VisualIntent, { type: "motion" }> = {
      id: `visual-intent:motion:${targetId}`,
      type: "motion",
      targetId,
      desired: {
        ...desired,
        properties,
        durationMs: Math.round(desired.durationMs),
        delayMs: Math.round(desired.delayMs),
        easing: desired.easing.trim(),
      },
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
      kind: "visual.motion.preview",
      summary: `Previewed ${intent.desired.kind} motion on ${targetId}`,
      payload: intent,
    });
    return copyIntent(intent);
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

const targetsDevtoolsUI = (event: Event): boolean =>
  event
    .composedPath()
    .some(
      (candidate) =>
        candidate instanceof Element &&
        (candidate.matches("[data-elfui-devtools]") ||
          candidate.closest("[data-elfui-devtools]") !== null),
    );

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
  target: Element;
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
  private readonly window: (Window & typeof globalThis) | null;
  private readonly session: VisualIntentSession;
  private readonly overlay: HTMLDivElement;
  private readonly styleLayer: HTMLDivElement;
  private readonly motionLayer: HTMLDivElement;
  private readonly ghost: HTMLDivElement;
  private readonly relationHint: HTMLDivElement;
  private readonly annotationLayer: HTMLDivElement;
  private readonly storage: Pick<
    Storage,
    "getItem" | "setItem" | "removeItem"
  > | null;
  private readonly storageKey: string;
  private readonly reconcileDelay: number;
  private currentRoute: string;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconcileReasons = new Set<string>();
  private readonly stopBridgeListener: () => void;
  private mutationObserver: MutationObserver | null = null;
  private disposed = false;
  private active = false;
  private tool: VisualTool = "move";
  private commentText = "";
  private styleProperty = "background-color";
  private styleValue = "";
  private styleTargetId: string | null = null;
  private motionProperties = "opacity, transform";
  private motionDurationMs = 240;
  private motionDelayMs = 0;
  private motionEasing = "ease-out";
  private motionTrigger: VisualMotionTrigger = "state-change";
  private motionRespectReducedMotion = true;
  private motionTargetId: string | null = null;
  private nextAnnotationId = 1;
  private drag: VisualDragState | null = null;
  private annotation: VisualAnnotationState | null = null;
  private readonly observedClosedRoots = new Set<ShadowRoot>();
  private readonly targetElements = new Map<string, WeakRef<Element>>();

  public constructor(
    private readonly bridge: ElfUIDevtoolsBridge,
    options: VisualToolsControllerOptions = {},
  ) {
    this.document = options.document ?? document;
    this.window = this.document.defaultView;
    this.session = new VisualIntentSession(bridge);
    this.storage = options.storage ?? null;
    this.storageKey = options.storageKey ?? DEVTOOLS_VISUAL_DRAFT_STORAGE_KEY;
    this.reconcileDelay = options.reconcileDelay ?? 20;
    this.currentRoute = this.route();
    this.overlay = this.document.createElement("div");
    this.overlay.dataset.elfuiDevtools = "visual-overlay";
    this.overlay.setAttribute("aria-hidden", "true");
    this.overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483645;display:none;pointer-events:none";
    this.annotationLayer = this.document.createElement("div");
    this.annotationLayer.dataset.elfuiDevtools = "visual-annotation-layer";
    this.annotationLayer.style.cssText =
      "position:fixed;inset:0;pointer-events:none";
    this.styleLayer = this.document.createElement("div");
    this.styleLayer.dataset.elfuiDevtools = "visual-style-layer";
    this.styleLayer.style.cssText =
      "position:fixed;inset:0;pointer-events:none";
    this.motionLayer = this.document.createElement("div");
    this.motionLayer.dataset.elfuiDevtools = "visual-motion-layer";
    this.motionLayer.style.cssText =
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
    this.relationHint = this.document.createElement("div");
    this.relationHint.dataset.elfuiDevtools = "visual-relation-hint";
    this.relationHint.style.cssText = [
      "position:fixed",
      "display:none",
      "max-width:260px",
      "padding:4px 7px",
      "border-radius:4px",
      "background:#111827",
      "color:#f9fafb",
      "font:600 11px/1.25 system-ui",
      "box-shadow:0 2px 10px rgb(0 0 0 / 25%)",
      "pointer-events:none",
    ].join(";");
    this.overlay.append(
      this.styleLayer,
      this.motionLayer,
      this.annotationLayer,
      this.ghost,
      this.relationHint,
    );
    this.document.body.append(this.overlay);
    this.onDraftChange = options.onDraftChange;
    this.restorePersistedDraft();
    this.stopBridgeListener = this.bridge.on((event) => {
      if (
        event.layer === "component" &&
        (event.type === "mount" ||
          event.type === "unmount" ||
          event.type === "update")
      )
        this.scheduleReconciliation(`component.${event.type}`);
    });
    this.window?.addEventListener("popstate", this.onRouteNavigation);
    this.window?.addEventListener("hashchange", this.onRouteNavigation);
    this.window?.addEventListener("resize", this.onViewportChange);
    this.window?.addEventListener("scroll", this.onViewportChange, true);
    const MutationObserverConstructor = this.window?.MutationObserver;
    if (MutationObserverConstructor) {
      const observer = new MutationObserverConstructor((mutations) => {
        if (this.disposed) return;
        if (mutations.some((mutation) => this.isBusinessMutation(mutation)))
          this.scheduleReconciliation("dom.mutation");
      });
      observer.observe(this.document.documentElement, {
        childList: true,
        subtree: true,
      });
      this.mutationObserver = observer;
    }
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
    this.notifyDraftChange();
  }

  public get selectedTool(): VisualTool {
    return this.tool;
  }

  public get selectedCommentText(): string {
    return this.commentText;
  }

  public get selectedStyleProperty(): string {
    return this.styleProperty;
  }

  public get selectedStyleValue(): string {
    return this.styleValue;
  }

  public get selectedStyleTargetId(): string | null {
    return this.styleTargetId;
  }

  public get selectedMotionProperties(): string {
    return this.motionProperties;
  }

  public get selectedMotionDurationMs(): number {
    return this.motionDurationMs;
  }

  public get selectedMotionDelayMs(): number {
    return this.motionDelayMs;
  }

  public get selectedMotionEasing(): string {
    return this.motionEasing;
  }

  public get selectedMotionTrigger(): VisualMotionTrigger {
    return this.motionTrigger;
  }

  public get selectedMotionRespectReducedMotion(): boolean {
    return this.motionRespectReducedMotion;
  }

  public get selectedMotionTargetId(): string | null {
    return this.motionTargetId;
  }

  public setTool(tool: VisualTool): void {
    this.tool = tool;
    this.drag = null;
    this.annotation = null;
    this.relationHint.style.display = "none";
  }

  public setCommentText(text: string): void {
    this.commentText = text;
  }

  public setStyleProperty(property: string): void {
    this.styleProperty = property.trim().toLowerCase();
  }

  public setStyleValue(value: string): void {
    this.styleValue = value.trim();
  }

  public setMotionProperties(value: string): void {
    this.motionProperties = value;
  }

  public setMotionDurationMs(value: number): void {
    if (Number.isFinite(value))
      this.motionDurationMs = Math.min(60_000, Math.max(0, Math.round(value)));
  }

  public setMotionDelayMs(value: number): void {
    if (Number.isFinite(value))
      this.motionDelayMs = Math.min(60_000, Math.max(0, Math.round(value)));
  }

  public setMotionEasing(value: string): void {
    this.motionEasing = value.trim();
  }

  public setMotionTrigger(value: VisualMotionTrigger): void {
    this.motionTrigger = value;
  }

  public setMotionRespectReducedMotion(value: boolean): void {
    this.motionRespectReducedMotion = value;
  }

  public previewSelectedStyle(): void {
    if (!this.styleTargetId)
      throw new Error("Select an ElfUI element before previewing a style");
    const property = this.styleProperty.trim().toLowerCase();
    const value = this.styleValue.trim();
    if (!/^(?:--[a-z0-9_-]+|[a-z][a-z0-9-]*)$/u.test(property) || !value)
      throw new Error("Enter a valid CSS property and value");
    this.session.previewStyle(this.styleTargetId, property, value);
    this.renderStylePreview();
    this.notifyDraftChange();
  }

  public previewSelectedMotion(): void {
    if (!this.motionTargetId)
      throw new Error("Select an ElfUI element before previewing motion");
    const properties = this.motionProperties
      .split(",")
      .map((property) => property.trim().toLowerCase())
      .filter(Boolean);
    this.session.previewMotion(this.motionTargetId, {
      kind: "transition",
      trigger: this.motionTrigger,
      properties,
      durationMs: this.motionDurationMs,
      delayMs: this.motionDelayMs,
      easing: this.motionEasing,
      respectReducedMotion: this.motionRespectReducedMotion,
    });
    this.renderMotionPreview();
    this.notifyDraftChange();
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
    this.relationHint.style.display = "none";
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
    this.relationHint.style.display = "none";
    this.styleLayer.replaceChildren();
    this.motionLayer.replaceChildren();
    this.styleTargetId = null;
    this.motionTargetId = null;
    this.annotationLayer.replaceChildren();
    this.notifyDraftChange();
  }

  public undo(): void {
    if (!this.session.undo()) return;
    this.ghost.style.display = "none";
    this.relationHint.style.display = "none";
    this.renderAnnotations();
    this.renderStylePreview();
    this.renderMotionPreview();
    this.notifyDraftChange();
  }

  public restore(draft: VisualDraft): void {
    this.session.restore(draft);
    this.ghost.style.display = "none";
    this.renderAnnotations();
    this.renderStylePreview();
    this.renderMotionPreview();
    this.notifyDraftChange();
  }

  public dispose(): void {
    this.disposed = true;
    this.disable();
    this.stopBridgeListener();
    this.window?.removeEventListener("popstate", this.onRouteNavigation);
    this.window?.removeEventListener("hashchange", this.onRouteNavigation);
    this.window?.removeEventListener("resize", this.onViewportChange);
    this.window?.removeEventListener("scroll", this.onViewportChange, true);
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    if (this.reconcileTimer !== null) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.overlay.remove();
  }

  private readonly onRouteNavigation = (): void => {
    this.handleRouteChange();
  };

  private readonly onViewportChange = (event: Event): void => {
    this.scheduleReconciliation(`viewport.${event.type}`);
  };

  private route(): string {
    const location = this.window?.location;
    return location
      ? `${location.pathname}${location.search}${location.hash}`
      : "";
  }

  private handleRouteChange(): boolean {
    const nextRoute = this.route();
    if (nextRoute === this.currentRoute) return false;
    const previousRoute = this.currentRoute;
    this.currentRoute = nextRoute;
    const draft = this.session.getDraft();
    const hasDraft =
      draft.targets.length > 0 ||
      draft.intents.length > 0 ||
      draft.annotations.length > 0 ||
      draft.screenshotIds.length > 0;
    if (hasDraft)
      this.session.invalidateDraft("route-changed", {
        previousRoute,
        route: nextRoute,
      });
    this.targetElements.clear();
    this.drag = null;
    this.annotation = null;
    this.styleTargetId = null;
    this.motionTargetId = null;
    this.ghost.style.display = "none";
    this.relationHint.style.display = "none";
    this.styleLayer.replaceChildren();
    this.motionLayer.replaceChildren();
    this.annotationLayer.replaceChildren();
    this.notifyDraftChange();
    return true;
  }

  private scheduleReconciliation(reason: string): void {
    if (this.disposed) return;
    this.reconcileReasons.add(reason);
    if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      if (this.handleRouteChange()) {
        this.reconcileReasons.clear();
        return;
      }
      const reasons = Array.from(this.reconcileReasons);
      this.reconcileReasons.clear();
      this.reconcileTargets(reasons.join(",") || "lifecycle");
    }, this.reconcileDelay);
  }

  private isBusinessMutation(mutation: MutationRecord): boolean {
    const element =
      mutation.target.nodeType === 1
        ? (mutation.target as Element)
        : mutation.target.parentElement;
    if (element?.closest("[data-elfui-devtools]")) return false;
    return [...mutation.addedNodes, ...mutation.removedNodes].some(
      (node) =>
        node.nodeType !== 1 ||
        !(node as Element).matches("[data-elfui-devtools]"),
    );
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
    if (targetsDevtoolsUI(event)) return;
    const target = firstElement(event);
    if (!target) return;
    if (
      event.currentTarget === this.document &&
      target instanceof HTMLElement
    ) {
      const root = getElfUIRenderRoot(target);
      if (root instanceof ShadowRoot && target.shadowRoot !== root) return;
    }
    const host = hostForTarget(this.bridge, target);
    const componentId = host ? this.bridge.getComponentId(host) : null;
    const visualTarget =
      host && componentId
        ? createVisualTargetSnapshot(this.bridge, componentId, target, host)
        : null;
    if (visualTarget) {
      this.session.captureTarget(visualTarget);
      this.targetElements.set(visualTarget.id, new WeakRef(target));
    }
    if (this.tool === "style") {
      if (!visualTarget) return;
      this.styleTargetId = visualTarget.id;
      const existing = this.styleIntentFor(visualTarget.id);
      if (existing) {
        const latest = Object.entries(existing.desired).at(-1);
        if (latest) {
          this.styleProperty = latest[0];
          this.styleValue = latest[1];
        }
      }
      this.renderStylePreview();
      event.preventDefault();
      event.stopPropagation();
      this.notifyDraftChange();
      return;
    }
    if (this.tool === "motion") {
      if (!visualTarget) return;
      this.motionTargetId = visualTarget.id;
      const existing = this.motionIntentFor(visualTarget.id);
      if (existing) this.applyMotionSelection(existing.desired);
      this.renderMotionPreview();
      event.preventDefault();
      event.stopPropagation();
      this.notifyDraftChange();
      return;
    }
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
        target,
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
    this.notifyDraftChange();
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
      if (this.drag.type === "move") {
        const relations = this.relationsForDrop(
          this.drag.targetId,
          this.drag.target,
          desired,
        );
        this.session.previewMove(this.drag.targetId, desired, relations);
        this.showRelationHint(desired, relations);
      } else this.session.previewResize(this.drag.targetId, desired);
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
    this.notifyDraftChange();
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

  private relationsForDrop(
    targetId: string,
    targetElement: Element,
    desired: RectSnapshot,
  ): VisualRelation[] {
    const points = [
      [desired.x + desired.width / 2, desired.y + desired.height / 2],
      [desired.x + desired.width / 2, desired.y],
      [desired.x + desired.width / 2, desired.y + desired.height],
      [desired.x, desired.y + desired.height / 2],
      [desired.x + desired.width, desired.y + desired.height / 2],
    ] as const;
    const candidates = new Map<string, VisualTarget>();
    for (const [x, y] of points) {
      for (const element of this.elementsAtPoint(x, y)) {
        if (
          element === targetElement ||
          element.closest("[data-elfui-devtools]")
        )
          continue;
        const host = hostForTarget(this.bridge, element);
        const componentId = host ? this.bridge.getComponentId(host) : null;
        if (!host || !componentId) continue;
        const candidate = createVisualTargetSnapshot(
          this.bridge,
          componentId,
          element,
          host,
        );
        if (candidate.id !== targetId) {
          candidates.set(candidate.id, candidate);
          this.targetElements.set(candidate.id, new WeakRef(element));
        }
      }
    }
    const candidate = Array.from(candidates.values()).sort(
      (left, right) =>
        rectDistance(desired, left.geometry) -
        rectDistance(desired, right.geometry),
    )[0];
    if (!candidate) return [];
    this.session.captureTarget(candidate);
    return inferVisualRelations(desired, candidate.geometry).map((type) => ({
      type,
      targetId: candidate.id,
    }));
  }

  private elementsAtPoint(x: number, y: number): Element[] {
    const elements: Element[] = [];
    const seen = new Set<Element>();
    const visit = (items: readonly Element[]): void => {
      for (const element of items) {
        if (seen.has(element)) continue;
        seen.add(element);
        if (element instanceof HTMLElement) {
          const root = getElfUIRenderRoot(element);
          const nested =
            root &&
            "elementsFromPoint" in root &&
            typeof root.elementsFromPoint === "function"
              ? root.elementsFromPoint(x, y)
              : [];
          if (nested.length) visit(nested);
        }
        elements.push(element);
      }
    };
    visit(this.document.elementsFromPoint?.(x, y) ?? []);
    return elements;
  }

  private showRelationHint(
    desired: RectSnapshot,
    relations: VisualRelation[],
  ): void {
    if (!relations.length) {
      this.relationHint.style.display = "none";
      return;
    }
    this.relationHint.textContent = relations
      .map((relation) => `${relation.type} ${relation.targetId}`)
      .join(" · ");
    this.relationHint.style.left = `${desired.x}px`;
    this.relationHint.style.top = `${desired.y + desired.height + 6}px`;
    this.relationHint.style.display = "block";
  }

  private styleIntentFor(
    targetId: string,
  ): Extract<VisualIntent, { type: "style" }> | null {
    return (
      this.session
        .getDraft()
        .intents.find(
          (intent): intent is Extract<VisualIntent, { type: "style" }> =>
            intent.type === "style" && intent.targetId === targetId,
        ) ?? null
    );
  }

  private motionIntentFor(
    targetId: string,
  ): Extract<VisualIntent, { type: "motion" }> | null {
    return (
      this.session
        .getDraft()
        .intents.find(
          (intent): intent is Extract<VisualIntent, { type: "motion" }> =>
            intent.type === "motion" && intent.targetId === targetId,
        ) ?? null
    );
  }

  private renderStylePreview(): void {
    this.styleLayer.replaceChildren();
    if (!this.styleTargetId) return;
    const target = this.session
      .getDraft()
      .targets.find((candidate) => candidate.id === this.styleTargetId);
    const element = this.targetElements.get(this.styleTargetId)?.deref();
    const intent = this.styleIntentFor(this.styleTargetId);
    if (!target || !element || !intent) return;
    const preview = this.document.createElement("div");
    preview.dataset.elfuiDevtools = "visual-style-preview";
    preview.dataset.targetId = target.id;
    const computed = this.document.defaultView?.getComputedStyle(element);
    if (computed)
      for (let index = 0; index < computed.length; index += 1) {
        const property = computed.item(index);
        if (property)
          preview.style.setProperty(
            property,
            computed.getPropertyValue(property),
          );
      }
    for (const [property, value] of Object.entries(intent.desired))
      preview.style.setProperty(property, value);
    preview.style.setProperty("position", "fixed", "important");
    preview.style.setProperty("left", `${target.geometry.x}px`, "important");
    preview.style.setProperty("top", `${target.geometry.y}px`, "important");
    preview.style.setProperty(
      "width",
      `${target.geometry.width}px`,
      "important",
    );
    preview.style.setProperty(
      "height",
      `${target.geometry.height}px`,
      "important",
    );
    preview.style.setProperty("margin", "0", "important");
    preview.style.setProperty("pointer-events", "none", "important");
    preview.style.setProperty("box-sizing", "border-box", "important");
    preview.textContent =
      element instanceof HTMLInputElement
        ? element.value
        : (element.textContent ?? "").trim().slice(0, 240);
    this.styleLayer.append(preview);
  }

  private renderMotionPreview(): void {
    this.motionLayer.replaceChildren();
    const draft = this.session.getDraft();
    for (const intent of draft.intents) {
      if (intent.type !== "motion") continue;
      const target = draft.targets.find(
        (candidate) => candidate.id === intent.targetId,
      );
      if (!target) continue;
      const marker = this.document.createElement("div");
      marker.dataset.elfuiDevtools = "visual-motion-preview";
      marker.dataset.targetId = target.id;
      marker.style.cssText = [
        "position:fixed",
        `left:${target.geometry.x}px`,
        `top:${target.geometry.y}px`,
        `width:${target.geometry.width}px`,
        `height:${target.geometry.height}px`,
        "box-sizing:border-box",
        "border:2px solid #22c55e",
        "border-radius:4px",
        "pointer-events:none",
      ].join(";");
      const label = this.document.createElement("div");
      label.style.cssText = [
        "position:absolute",
        "left:-2px",
        "bottom:calc(100% + 5px)",
        "max-width:320px",
        "padding:4px 7px",
        "border-radius:4px",
        "background:#052e16",
        "color:#bbf7d0",
        "font:600 11px/1.25 system-ui",
        "white-space:nowrap",
        "overflow:hidden",
        "text-overflow:ellipsis",
      ].join(";");
      label.textContent =
        `${intent.desired.properties.join(", ")} · ${intent.desired.trigger} · ` +
        `${intent.desired.durationMs}ms + ${intent.desired.delayMs}ms · ` +
        `${intent.desired.easing} · ` +
        (intent.desired.respectReducedMotion
          ? "reduced-motion"
          : "always-motion");
      marker.append(label);
      this.motionLayer.append(marker);
    }
  }

  private restorePersistedDraft(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const value = JSON.parse(raw) as unknown;
      const persisted = isPersistedVisualDraft(value)
        ? value
        : isVisualDraft(value)
          ? { route: this.currentRoute, draft: value }
          : null;
      if (!persisted || persisted.route !== this.currentRoute) {
        this.storage.removeItem(this.storageKey);
        return;
      }
      this.session.restore(persisted.draft);
      this.rebindPersistedTargets();
      this.renderAnnotations();
      this.renderStylePreview();
      this.renderMotionPreview();
      this.storage.setItem(
        this.storageKey,
        JSON.stringify({
          route: this.currentRoute,
          draft: this.session.getDraft(),
        } satisfies PersistedVisualDraft),
      );
    } catch {
      this.storage.removeItem(this.storageKey);
    }
  }

  private notifyDraftChange(): void {
    const draft = this.session.getDraft();
    if (this.storage) {
      const empty =
        !draft.targets.length &&
        !draft.intents.length &&
        !draft.annotations.length &&
        !draft.screenshotIds.length;
      if (empty) this.storage.removeItem(this.storageKey);
      else
        this.storage.setItem(
          this.storageKey,
          JSON.stringify({
            route: this.currentRoute,
            draft,
          } satisfies PersistedVisualDraft),
        );
    }
    this.onDraftChange?.(draft);
  }

  private rebindPersistedTargets(): void {
    this.reconcileTargets("draft-restore", false);
    this.syncIntentSelectionFromDraft();
  }

  private reconcileTargets(reason: string, invalidateMissing = true): void {
    const draft = this.session.getDraft();
    const componentHosts = this.bridge
      .getSnapshot()
      .components.map((component) => this.bridge.getComponentHost(component.id))
      .filter((host): host is HTMLElement => !!host);
    const invalidTargetIds: string[] = [];
    let changed = false;

    for (const target of draft.targets) {
      const templateNodeId = target.inspector.templateNodeId;
      let match: { host: HTMLElement; element: Element } | undefined;
      if (templateNodeId) {
        const preferred = this.bridge.getComponentHost(target.componentId);
        const hosts = preferred
          ? [preferred, ...componentHosts.filter((host) => host !== preferred)]
          : componentHosts;
        match = hosts
          .map((host) => ({
            host,
            element: findTemplateNode(host, templateNodeId),
          }))
          .find(
            (candidate): candidate is { host: HTMLElement; element: Element } =>
              !!candidate.element,
          );
      } else {
        const element = this.targetElements.get(target.id)?.deref();
        const host =
          element?.isConnected && element
            ? hostForTarget(this.bridge, element)
            : null;
        if (element && host) match = { host, element };
      }
      if (!match) {
        if (invalidateMissing || !templateNodeId)
          invalidTargetIds.push(target.id);
        continue;
      }

      const previousElement = this.targetElements.get(target.id)?.deref();
      this.targetElements.set(target.id, new WeakRef(match.element));
      const componentId = this.bridge.getComponentId(match.host);
      if (componentId) {
        const snapshot = createVisualTargetSnapshot(
          this.bridge,
          componentId,
          match.element,
          match.host,
        );
        const rebound = copyTarget({ ...snapshot, id: target.id });
        if (
          previousElement !== match.element ||
          JSON.stringify(target) !== JSON.stringify(rebound)
        ) {
          this.session.rebindTarget(target.id, snapshot, reason);
          changed = true;
        }
      }
    }

    if (invalidTargetIds.length) {
      this.session.invalidateTargets(invalidTargetIds, reason);
      for (const targetId of invalidTargetIds) {
        this.targetElements.delete(targetId);
        if (this.styleTargetId === targetId) this.styleTargetId = null;
      }
      changed = true;
    }
    if (!changed) return;
    this.drag = null;
    this.annotation = null;
    this.ghost.style.display = "none";
    this.relationHint.style.display = "none";
    this.syncIntentSelectionFromDraft();
    this.renderAnnotations();
    this.renderStylePreview();
    this.renderMotionPreview();
    if (this.active) this.syncClosedRootListeners();
    this.notifyDraftChange();
  }

  private syncIntentSelectionFromDraft(): void {
    const intents = [...this.session.getDraft().intents].reverse();
    const styleIntent = intents.find(
      (intent): intent is Extract<VisualIntent, { type: "style" }> =>
        intent.type === "style" &&
        !!this.targetElements.get(intent.targetId)?.deref(),
    );
    const motionIntent = intents.find(
      (intent): intent is Extract<VisualIntent, { type: "motion" }> =>
        intent.type === "motion" &&
        !!this.targetElements.get(intent.targetId)?.deref(),
    );
    this.styleTargetId = styleIntent?.targetId ?? null;
    this.motionTargetId = motionIntent?.targetId ?? null;
    if (styleIntent) {
      const latest = Object.entries(styleIntent.desired).at(-1);
      if (latest) {
        this.styleProperty = latest[0];
        this.styleValue = latest[1];
      }
    }
    if (motionIntent) this.applyMotionSelection(motionIntent.desired);
    const latestIntent = intents.find(
      (intent) =>
        (intent.type === "style" || intent.type === "motion") &&
        !!this.targetElements.get(intent.targetId)?.deref(),
    );
    if (latestIntent?.type === "style") this.tool = "style";
    else if (latestIntent?.type === "motion") this.tool = "motion";
  }

  private applyMotionSelection(desired: VisualMotionTransition): void {
    this.motionProperties = desired.properties.join(", ");
    this.motionDurationMs = desired.durationMs;
    this.motionDelayMs = desired.delayMs;
    this.motionEasing = desired.easing;
    this.motionTrigger = desired.trigger;
    this.motionRespectReducedMotion = desired.respectReducedMotion;
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

const isPersistedVisualDraft = (
  value: unknown,
): value is PersistedVisualDraft => {
  if (!value || typeof value !== "object") return false;
  const persisted = value as Partial<PersistedVisualDraft>;
  return typeof persisted.route === "string" && isVisualDraft(persisted.draft);
};

const rectDistance = (left: RectSnapshot, right: RectSnapshot): number => {
  const horizontal = Math.max(
    right.x - (left.x + left.width),
    left.x - (right.x + right.width),
    0,
  );
  const vertical = Math.max(
    right.y - (left.y + left.height),
    left.y - (right.y + right.height),
    0,
  );
  return Math.hypot(horizontal, vertical);
};

export const inferVisualRelations = (
  subject: RectSnapshot,
  candidate: RectSnapshot,
): VisualRelation["type"][] => {
  const subjectCenter = {
    x: subject.x + subject.width / 2,
    y: subject.y + subject.height / 2,
  };
  const candidateCenter = {
    x: candidate.x + candidate.width / 2,
    y: candidate.y + candidate.height / 2,
  };
  const relations: VisualRelation["type"][] = [];
  const inside =
    subjectCenter.x >= candidate.x &&
    subjectCenter.x <= candidate.x + candidate.width &&
    subjectCenter.y >= candidate.y &&
    subjectCenter.y <= candidate.y + candidate.height;
  if (inside) relations.push("inside");
  else {
    if (subject.y + subject.height <= candidate.y) relations.push("before");
    else if (subject.y >= candidate.y + candidate.height)
      relations.push("after");
    if (subject.x + subject.width <= candidate.x) relations.push("left-of");
    else if (subject.x >= candidate.x + candidate.width)
      relations.push("right-of");
  }
  if (
    Math.abs(subjectCenter.x - candidateCenter.x) <= 8 ||
    Math.abs(subjectCenter.y - candidateCenter.y) <= 8
  )
    relations.push("align-with");
  if (rectDistance(subject, candidate) <= 24) relations.push("near");
  return relations;
};
