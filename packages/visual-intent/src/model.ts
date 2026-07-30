export const DEVTOOLS_VISUAL_SCHEMA_VERSION = 1 as const;

export interface RectSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualSourceLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface VisualInspectorElementSnapshot {
  tag: string;
  id?: string;
  classes: string[];
  role?: string;
  text?: string;
}

export interface VisualInspectorTargetSnapshot {
  componentId: string;
  domPath: string;
  element: VisualInspectorElementSnapshot;
  sourcePrecision: "template-node" | "component" | "unresolved";
  source?: VisualSourceLocation;
  sourceId?: string;
  templateNodeId?: string;
  /** @deprecated Compatibility with ElfUI beta.15 debug markers. */
  fragment?: string;
}

export interface VisualBindingSnapshot {
  effectId: string;
  kind: string;
  name: string;
  source?: VisualSourceLocation;
  triggerCount: number;
  runCount: number;
  lastDuration: number | null;
}

export type VisualPrimitiveValue = string | number | boolean | null;

export interface VisualSerializedPrimitive {
  kind: "primitive";
  value: VisualPrimitiveValue;
}

export interface VisualSerializedSpecial {
  kind:
    | "undefined"
    | "bigint"
    | "symbol"
    | "function"
    | "date"
    | "regexp"
    | "error"
    | "dom"
    | "weak";
  preview: string;
}

export interface VisualSerializedReference {
  kind: "reference";
  id: number;
  preview: string;
}

export interface VisualSerializedArray {
  kind: "array";
  id: number;
  items: VisualSerializedValue[];
  truncated: boolean;
}

export interface VisualSerializedObject {
  kind: "object";
  id: number;
  name: string;
  entries: Array<{ key: string; value: VisualSerializedValue }>;
  truncated: boolean;
}

export interface VisualSerializedCollection {
  kind: "map" | "set";
  id: number;
  entries:
    | VisualSerializedValue[]
    | Array<{
        key: VisualSerializedValue;
        value: VisualSerializedValue;
      }>;
  truncated: boolean;
}

export type VisualSerializedValue =
  | VisualSerializedPrimitive
  | VisualSerializedSpecial
  | VisualSerializedReference
  | VisualSerializedArray
  | VisualSerializedObject
  | VisualSerializedCollection;

export interface VisualSourceReference {
  sourceId: string;
  component?: string;
  /** @deprecated Compatibility with ElfUI beta.15 source references. */
  fragment?: string;
  templateNodeId?: string;
  range?: VisualSourceLocation;
}

export interface VisualTarget<
  TInspector extends VisualInspectorTargetSnapshot =
    VisualInspectorTargetSnapshot,
  TProps = VisualSerializedValue,
  TBinding extends VisualBindingSnapshot = VisualBindingSnapshot,
> {
  id: string;
  runtimeNodeId: string;
  componentId: string;
  inspector: TInspector;
  source?: VisualSourceReference;
  geometry: RectSnapshot;
  computedStyle?: Record<string, string>;
  props?: TProps;
  bindings?: TBinding[];
}

export type VisualRelationType =
  | "inside"
  | "before"
  | "after"
  | "left-of"
  | "right-of"
  | "align-with"
  | "near";

export interface VisualRelation {
  type: VisualRelationType;
  targetId: string;
}

export type VisualMotionTrigger =
  | "state-change"
  | "enter"
  | "exit"
  | "hover"
  | "focus"
  | "press";

export interface VisualMotionTransition {
  kind: "transition";
  trigger: VisualMotionTrigger;
  properties: string[];
  durationMs: number;
  delayMs: number;
  easing: string;
  respectReducedMotion: boolean;
}

export type VisualIntent =
  | {
      id: string;
      type: "style";
      targetId: string;
      before: Record<string, string>;
      desired: Record<string, string>;
    }
  | {
      id: string;
      type: "move";
      targetId: string;
      before: RectSnapshot;
      desired: RectSnapshot;
      relations: VisualRelation[];
    }
  | {
      id: string;
      type: "resize";
      targetId: string;
      before: RectSnapshot;
      desired: RectSnapshot;
    }
  | {
      id: string;
      type: "motion";
      targetId: string;
      desired: VisualMotionTransition;
    }
  | {
      id: string;
      type: "remove" | "duplicate";
      targetId: string;
    };

export type VisualAnnotationType =
  | "comment"
  | "rectangle"
  | "arrow"
  | "highlight"
  | "redaction";

export interface VisualAnnotation {
  id: string;
  type: VisualAnnotationType;
  targetIds: string[];
  text?: string;
  geometry?: RectSnapshot;
  from?: { x: number; y: number };
  to?: { x: number; y: number };
  createdAt: number;
}

export interface VisualDraft<TTarget extends VisualTarget = VisualTarget> {
  schemaVersion: typeof DEVTOOLS_VISUAL_SCHEMA_VERSION;
  id: string;
  targets: TTarget[];
  intents: VisualIntent[];
  annotations: VisualAnnotation[];
  screenshotIds: string[];
}

export type ScreenshotKind = "viewport" | "selection";
export type ScreenshotPhase = "before" | "desired" | "result";

export interface ScreenshotAsset {
  id: string;
  kind: ScreenshotKind;
  phase: ScreenshotPhase;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  devicePixelRatio: number;
  route: string;
  scroll: { x: number; y: number };
  capturedAt: number;
  selection?: RectSnapshot;
  excludedRegions: RectSnapshot[];
  byteLength: number;
}
