import type {
  AIChangeRequest,
  RectSnapshot,
  SourceContextBlock,
  VisualAnnotation,
  VisualIntent,
  VisualTarget,
} from "@elfui/devtools-shared";

export interface AIVisualContextSummary {
  targets: string[];
  intents: string[];
  annotations: string[];
  sources: string[];
  diagnostics: string[];
  followUp: string[];
  text: string;
}

const formatRect = (rect: RectSnapshot): string =>
  `${rect.x},${rect.y},${rect.width}x${rect.height}`;

const formatPoint = (point: { x: number; y: number }): string =>
  `${point.x},${point.y}`;

const formatStyleMap = (style: Record<string, string>): string =>
  Object.entries(style)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([property, value]) => `${property}=${value}`)
    .join(",");

const formatSourceRange = (
  range:
    | {
        file: string;
        line: number;
        column: number;
        endLine?: number;
        endColumn?: number;
      }
    | undefined,
): string => {
  if (!range) return "unresolved";
  const start = `${range.file}:${range.line}:${range.column}`;
  if (range.endLine === undefined || range.endColumn === undefined)
    return start;
  return `${start}-${range.endLine}:${range.endColumn}`;
};

const summarizeTarget = (target: VisualTarget): string => {
  const element = target.inspector.element;
  const sourceId =
    target.source?.sourceId ?? target.inspector.sourceId ?? "unresolved";
  const templateNodeId =
    target.source?.templateNodeId ??
    target.inspector.templateNodeId ??
    "unresolved";
  const sourceRange = target.source?.range ?? target.inspector.source;
  const identity = [
    `target ${target.id}`,
    `tag=${element.tag}`,
    element.id ? `id=${element.id}` : null,
    element.classes.length > 0 ? `classes=${element.classes.join(",")}` : null,
    element.text ? `text="${element.text}"` : null,
    `component=${target.componentId}`,
    `sourceId=${sourceId}`,
    `templateNodeId=${templateNodeId}`,
    `range=${formatSourceRange(sourceRange)}`,
    `geometry=${formatRect(target.geometry)}`,
  ].filter((value): value is string => value !== null);
  return identity.join(" ");
};

const summarizeIntent = (intent: VisualIntent): string => {
  const prefix = `intent ${intent.id} type=${intent.type} target=${intent.targetId}`;
  if (intent.type === "style")
    return (
      `${prefix} before={${formatStyleMap(intent.before)}} ` +
      `desired={${formatStyleMap(intent.desired)}}`
    );
  if (intent.type === "move")
    return (
      `${prefix} before=${formatRect(intent.before)} ` +
      `desired=${formatRect(intent.desired)} relations=` +
      (intent.relations.length > 0
        ? intent.relations
            .map((relation) => `${relation.type}->${relation.targetId}`)
            .join(",")
        : "none")
    );
  if (intent.type === "resize")
    return `${prefix} before=${formatRect(intent.before)} desired=${formatRect(intent.desired)}`;
  if (intent.type === "motion")
    return (
      `${prefix} kind=${intent.desired.kind} ` +
      `properties=${intent.desired.properties.join(",")} ` +
      `trigger=${intent.desired.trigger} ` +
      `durationMs=${intent.desired.durationMs} ` +
      `delayMs=${intent.desired.delayMs} ` +
      `easing=${intent.desired.easing} ` +
      `respectReducedMotion=${intent.desired.respectReducedMotion}`
    );
  return prefix;
};

const summarizeAnnotation = (annotation: VisualAnnotation): string => {
  const details = [
    `annotation ${annotation.id}`,
    `type=${annotation.type}`,
    `targets=${annotation.targetIds.join(",") || "none"}`,
    annotation.text ? `text="${annotation.text}"` : null,
    annotation.geometry ? `geometry=${formatRect(annotation.geometry)}` : null,
    annotation.from ? `from=${formatPoint(annotation.from)}` : null,
    annotation.to ? `to=${formatPoint(annotation.to)}` : null,
  ].filter((value): value is string => value !== null);
  return details.join(" ");
};

const summarizeSource = (source: SourceContextBlock): string =>
  [
    `source sourceId=${source.sourceId}`,
    source.component ? `component=${source.component}` : null,
    source.templateNodeId ? `templateNodeId=${source.templateNodeId}` : null,
    `range=${formatSourceRange(source.range)}`,
    `content=${typeof source.content === "string" ? "included" : "omitted"}`,
  ]
    .filter((value): value is string => value !== null)
    .join(" ");

export const summarizeAIChangeRequest = (
  request: AIChangeRequest,
): AIVisualContextSummary => {
  const targets = request.targets.map(summarizeTarget);
  const intents = request.intents.map(summarizeIntent);
  const annotations = request.annotations.map(summarizeAnnotation);
  const sources = request.sourceContext.map(summarizeSource);
  const diagnostics = (request.diagnostics ?? []).map(
    (diagnostic) =>
      `diagnostic ${diagnostic.id} severity=${diagnostic.severity} code=${diagnostic.code}` +
      (diagnostic.sourceId ? ` sourceId=${diagnostic.sourceId}` : "") +
      ` message="${diagnostic.message}"`,
  );
  const followUp = request.followUp
    ? [
        `follow-up previousRequestId=${request.followUp.previousRequestId} proposalId=${request.followUp.proposalId} applicationId=${request.followUp.applicationId} verificationId=${request.followUp.verificationId} reviewId=${request.followUp.reviewId} resultScreenshotId=${request.followUp.resultScreenshotId}`,
        ...request.followUp.references.map(
          (reference) =>
            `follow-up-reference kind=${reference.kind} id=${reference.id} status=${reference.status}`,
        ),
      ]
    : [];
  const sections = [
    targets.length > 0 ? `目标：\n${targets.join("\n")}` : null,
    intents.length > 0 ? `意图：\n${intents.join("\n")}` : null,
    annotations.length > 0 ? `标注：\n${annotations.join("\n")}` : null,
    sources.length > 0 ? `源码引用：\n${sources.join("\n")}` : null,
    diagnostics.length > 0 ? `诊断：\n${diagnostics.join("\n")}` : null,
    followUp.length > 0 ? `上一轮结果核对：\n${followUp.join("\n")}` : null,
  ].filter((value): value is string => value !== null);
  return {
    targets,
    intents,
    annotations,
    sources,
    diagnostics,
    followUp,
    text: sections.join("\n"),
  };
};
