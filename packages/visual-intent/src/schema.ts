import {
  DEVTOOLS_VISUAL_SCHEMA_VERSION,
  type RectSnapshot,
  type ScreenshotAsset,
  type VisualAnnotation,
  type VisualDraft,
  type VisualIntent,
  type VisualTarget,
} from "./model.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasString = (value: Record<string, unknown>, key: string): boolean =>
  typeof value[key] === "string";

const hasFiniteNumber = (
  value: Record<string, unknown>,
  key: string,
): boolean =>
  typeof value[key] === "number" && Number.isFinite(value[key] as number);

const hasStringArray = (value: Record<string, unknown>, key: string): boolean =>
  Array.isArray(value[key]) &&
  (value[key] as unknown[]).every((item) => typeof item === "string");

export const isRectSnapshot = (value: unknown): value is RectSnapshot =>
  isRecord(value) &&
  hasFiniteNumber(value, "x") &&
  hasFiniteNumber(value, "y") &&
  hasFiniteNumber(value, "width") &&
  hasFiniteNumber(value, "height");

export const isVisualTarget = (value: unknown): value is VisualTarget => {
  if (
    !isRecord(value) ||
    !hasString(value, "id") ||
    !hasString(value, "runtimeNodeId") ||
    !hasString(value, "componentId") ||
    !isRectSnapshot(value.geometry) ||
    !isRecord(value.inspector)
  )
    return false;
  const inspector = value.inspector;
  return (
    hasString(inspector, "componentId") &&
    hasString(inspector, "domPath") &&
    isRecord(inspector.element) &&
    hasString(inspector.element, "tag") &&
    hasStringArray(inspector.element, "classes") &&
    (inspector.sourcePrecision === "template-node" ||
      inspector.sourcePrecision === "component" ||
      inspector.sourcePrecision === "unresolved")
  );
};

const isStyleMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.values(value).every((item) => typeof item === "string");

const isVisualRelation = (value: unknown): boolean =>
  isRecord(value) &&
  hasString(value, "targetId") &&
  [
    "inside",
    "before",
    "after",
    "left-of",
    "right-of",
    "align-with",
    "near",
  ].includes(String(value.type));

const cssPropertyPattern = /^(?:--[a-z0-9_-]+|[a-z][a-z0-9-]*)$/u;

const isVisualMotionTransition = (value: unknown): boolean => {
  if (!isRecord(value) || !hasStringArray(value, "properties")) return false;
  const properties = value.properties as string[];
  return (
    value.kind === "transition" &&
    ["state-change", "enter", "exit", "hover", "focus", "press"].includes(
      String(value.trigger),
    ) &&
    properties.length > 0 &&
    properties.every((property) => cssPropertyPattern.test(property)) &&
    new Set(properties).size === properties.length &&
    hasFiniteNumber(value, "durationMs") &&
    (value.durationMs as number) >= 0 &&
    hasFiniteNumber(value, "delayMs") &&
    (value.delayMs as number) >= 0 &&
    hasString(value, "easing") &&
    String(value.easing).trim().length > 0 &&
    typeof value.respectReducedMotion === "boolean"
  );
};

export const isVisualIntent = (value: unknown): value is VisualIntent => {
  if (
    !isRecord(value) ||
    !hasString(value, "id") ||
    !hasString(value, "targetId")
  )
    return false;
  if (value.type === "style")
    return isStyleMap(value.before) && isStyleMap(value.desired);
  if (value.type === "move")
    return (
      isRectSnapshot(value.before) &&
      isRectSnapshot(value.desired) &&
      Array.isArray(value.relations) &&
      value.relations.every(isVisualRelation)
    );
  if (value.type === "resize")
    return isRectSnapshot(value.before) && isRectSnapshot(value.desired);
  if (value.type === "motion") return isVisualMotionTransition(value.desired);
  return value.type === "remove" || value.type === "duplicate";
};

export const isVisualAnnotation = (
  value: unknown,
): value is VisualAnnotation => {
  if (
    !isRecord(value) ||
    !hasString(value, "id") ||
    !hasStringArray(value, "targetIds") ||
    !hasFiniteNumber(value, "createdAt") ||
    !["comment", "rectangle", "arrow", "highlight", "redaction"].includes(
      String(value.type),
    )
  )
    return false;
  return value.geometry === undefined || isRectSnapshot(value.geometry);
};

export const isVisualDraft = (value: unknown): value is VisualDraft =>
  isRecord(value) &&
  value.schemaVersion === DEVTOOLS_VISUAL_SCHEMA_VERSION &&
  hasString(value, "id") &&
  Array.isArray(value.targets) &&
  value.targets.every(isVisualTarget) &&
  Array.isArray(value.intents) &&
  value.intents.every(isVisualIntent) &&
  Array.isArray(value.annotations) &&
  value.annotations.every(isVisualAnnotation) &&
  hasStringArray(value, "screenshotIds");

export const isScreenshotAsset = (value: unknown): value is ScreenshotAsset =>
  isRecord(value) &&
  hasString(value, "id") &&
  (value.kind === "viewport" || value.kind === "selection") &&
  (value.phase === "before" ||
    value.phase === "desired" ||
    value.phase === "result") &&
  (value.mimeType === "image/png" ||
    value.mimeType === "image/jpeg" ||
    value.mimeType === "image/webp") &&
  hasFiniteNumber(value, "width") &&
  hasFiniteNumber(value, "height") &&
  hasFiniteNumber(value, "devicePixelRatio") &&
  hasString(value, "route") &&
  isRecord(value.scroll) &&
  hasFiniteNumber(value.scroll, "x") &&
  hasFiniteNumber(value.scroll, "y") &&
  hasFiniteNumber(value, "capturedAt") &&
  Array.isArray(value.excludedRegions) &&
  value.excludedRegions.every(isRectSnapshot) &&
  hasFiniteNumber(value, "byteLength") &&
  (value.selection === undefined || isRectSnapshot(value.selection)) &&
  value.dataUrl === undefined;
