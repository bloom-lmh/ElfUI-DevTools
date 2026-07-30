import {
  type ScreenshotAsset,
  type VisualAnnotation,
  type VisualDraft as VisualDraftModel,
  type VisualIntent,
  type VisualTarget as VisualTargetModel,
} from "@elfui/devtools-visual-intent";

export {
  DEVTOOLS_VISUAL_SCHEMA_VERSION,
  isRectSnapshot,
  isScreenshotAsset,
  isVisualAnnotation,
  isVisualDraft,
  isVisualIntent,
  isVisualTarget,
} from "@elfui/devtools-visual-intent";
export type {
  RectSnapshot,
  ScreenshotAsset,
  ScreenshotKind,
  ScreenshotPhase,
  VisualAnnotation,
  VisualAnnotationType,
  VisualBindingSnapshot,
  VisualInspectorElementSnapshot,
  VisualInspectorTargetSnapshot,
  VisualIntent,
  VisualRelation,
  VisualRelationType,
  VisualSourceLocation,
  VisualSourceReference,
} from "@elfui/devtools-visual-intent";

export const DEVTOOLS_PROTOCOL_VERSION = 2 as const;
export const DEVTOOLS_PIPELINE_SCHEMA_VERSION = 1 as const;
export const DEVTOOLS_AI_CHANGE_SCHEMA_VERSION = 1 as const;
export const DEVTOOLS_OPEN_IN_EDITOR_ENDPOINT =
  "/__elfui_devtools/open-in-editor" as const;
export const DEVTOOLS_SOURCE_READ_ENDPOINT =
  "/__elfui_devtools/source-read" as const;
export const DEVTOOLS_COMPILER_STATE_ENDPOINT =
  "/__elfui_devtools/compiler-state" as const;
export const DEVTOOLS_COMPILER_UPDATE_EVENT =
  "elfui-devtools:compiler-update" as const;

export type PrimitiveValue = string | number | boolean | null;

export interface SerializedPrimitive {
  kind: "primitive";
  value: PrimitiveValue;
}

export interface SerializedSpecial {
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

export interface SerializedReference {
  kind: "reference";
  id: number;
  preview: string;
}

export interface SerializedArray {
  kind: "array";
  id: number;
  items: SerializedValue[];
  truncated: boolean;
}

export interface SerializedObject {
  kind: "object";
  id: number;
  name: string;
  entries: Array<{ key: string; value: SerializedValue }>;
  truncated: boolean;
}

export interface SerializedCollection {
  kind: "map" | "set";
  id: number;
  entries:
    | SerializedValue[]
    | Array<{ key: SerializedValue; value: SerializedValue }>;
  truncated: boolean;
}

export type SerializedValue =
  | SerializedPrimitive
  | SerializedSpecial
  | SerializedReference
  | SerializedArray
  | SerializedObject
  | SerializedCollection;

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

/** Symbol.for() key for development-only DOM-to-template metadata. */
export const ELFUI_TEMPLATE_NODE_DEBUG_KEY =
  "elfui.devtools.template-node" as const;

export interface TemplateNodeDebugInfo {
  sourceId: string;
  templateNodeId: string;
  /** @deprecated Compatibility with ElfUI beta.15 debug markers. */
  fragment?: string;
  source: SourceLocation;
}

export interface InspectorElementSnapshot {
  tag: string;
  id?: string;
  classes: string[];
  role?: string;
  text?: string;
}

export interface InspectorTargetSnapshot {
  componentId: string;
  domPath: string;
  element: InspectorElementSnapshot;
  sourcePrecision: "template-node" | "component" | "unresolved";
  source?: SourceLocation;
  sourceId?: string;
  templateNodeId?: string;
  /** @deprecated Compatibility with ElfUI beta.15 debug markers. */
  fragment?: string;
}

export type VisualTarget = VisualTargetModel<
  InspectorTargetSnapshot,
  SerializedValue,
  ComponentBindingSnapshot
>;

export type VisualDraft = VisualDraftModel<VisualTarget>;

export interface ProjectContextSummary {
  framework: "elfui";
  frameworkVersion?: string;
  projectName?: string;
}

export interface PageContextSummary {
  url: string;
  route: string;
  title: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  scroll: { x: number; y: number };
}

export interface SourceContextBlock {
  id: string;
  sourceId: string;
  component?: string;
  /** @deprecated Compatibility with ElfUI beta.15 requests. */
  fragment?: string;
  templateNodeId?: string;
  range?: SourceLocation;
  content?: string;
}

export interface SourceReadRange {
  startLine: number;
  endLine: number;
}

export interface SourceReadRequest {
  sourceId: string;
  range?: SourceReadRange;
}

export interface SourceReadResult {
  sourceId: string;
  range: SourceReadRange;
  content: string;
  totalLines: number;
  characterCount: number;
  truncated: boolean;
}

export interface AIContextBudget {
  maxSourceBlocks: number;
  maxSourceCharacters: number;
  maxScreenshotBytes: number;
  maxUserMessageCharacters: number;
}

export const DEFAULT_AI_CONTEXT_BUDGET: AIContextBudget = {
  maxSourceBlocks: 12,
  maxSourceCharacters: 32_000,
  maxScreenshotBytes: 8_000_000,
  maxUserMessageCharacters: 4_000,
};

export type AIContextOmissionReason =
  | "approval-required"
  | "not-allowed"
  | "source-budget"
  | "screenshot-budget"
  | "diagnostic-budget";

export interface AIContextOmission {
  kind: "source" | "screenshot" | "diagnostic";
  id: string;
  reason: AIContextOmissionReason;
}

export interface AIContextRedactionSummary {
  location: "source" | "user-message" | "diagnostic";
  id?: string;
  replacements: number;
}

export interface AIContextUsage {
  sourceBlocks: number;
  sourceCharacters: number;
  screenshotCount: number;
  screenshotBytes: number;
  userMessageCharacters: number;
}

export interface AIContextGovernance {
  budget: AIContextBudget;
  usage: AIContextUsage;
  approvedSourceIds: string[];
  pendingSourceApprovals: string[];
  omissions: AIContextOmission[];
  redactions: AIContextRedactionSummary[];
  userMessageTruncated: boolean;
}

export interface AIChangeConstraints {
  preserveResponsiveLayout: boolean;
  preserveAccessibility: boolean;
  preservePublicAPI: boolean;
  allowedFiles?: string[];
}

export type AIChangeFollowUpStatus = "partial" | "unmet";

export interface AIChangeFollowUpReference {
  kind: "visual-intent" | "annotation";
  id: string;
  status: AIChangeFollowUpStatus;
}

export interface AIChangeFollowUpContext {
  previousRequestId: string;
  proposalId: string;
  applicationId: string;
  verificationId: string;
  reviewId: string;
  resultScreenshotId: string;
  references: AIChangeFollowUpReference[];
}

export interface AIChangeDiagnostic {
  id: string;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  sourceId?: string;
  source?: SourceLocation;
}

export interface AIChangeRequest {
  schemaVersion: typeof DEVTOOLS_AI_CHANGE_SCHEMA_VERSION;
  id: string;
  conversationId: string;
  project: ProjectContextSummary;
  page: PageContextSummary;
  targets: VisualTarget[];
  intents: VisualIntent[];
  annotations: VisualAnnotation[];
  screenshots: ScreenshotAsset[];
  sourceContext: SourceContextBlock[];
  diagnostics?: AIChangeDiagnostic[];
  userMessage?: string;
  followUp?: AIChangeFollowUpContext;
  constraints: AIChangeConstraints;
  governance: AIContextGovernance;
}

export interface ComponentNodeSnapshot {
  id: string;
  appId: string;
  parentId: string | null;
  tag: string;
  displayName: string;
  mounted: boolean;
  shadowMode: "open" | "closed" | "none";
  children: string[];
  source?: SourceLocation;
}

export interface ComponentBindingSnapshot {
  effectId: string;
  kind: string;
  name: string;
  source?: SourceLocation;
  triggerCount: number;
  runCount: number;
  lastDuration: number | null;
}

export interface ComponentDiagnosticSnapshot {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  hint?: string;
  source?: SourceLocation;
}

export interface ComponentDetailSnapshot extends ComponentNodeSnapshot {
  props: SerializedValue;
  attrs: SerializedValue;
  setup: SerializedValue;
  exposed: SerializedValue;
  bindings: ComponentBindingSnapshot[];
  diagnostics: ComponentDiagnosticSnapshot[];
  lifecycle: {
    updateCount: number;
    lastUpdatedAt: number | null;
    error: SerializedValue | null;
  };
}

export interface AppSnapshot {
  id: string;
  label: string;
  rootIds: string[];
}

export interface TimelineEvent {
  id: string;
  appId: string;
  componentId?: string;
  layer: "component" | "reactivity" | "events" | "router";
  type: string;
  at: number;
  summary: string;
  data?: SerializedValue;
}

export type PipelineStage =
  | "observation"
  | "target-snapshot"
  | "visual-intent"
  | "context-bundle"
  | "ai-request"
  | "provider-request"
  | "patch-proposal"
  | "verification";

export type PipelineRecordSource =
  | "runtime"
  | "compiler"
  | "inspector"
  | "visual-tools"
  | "context-builder"
  | "ai"
  | "provider"
  | "patch-engine"
  | "verification";

export interface PipelineDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface PipelineRecord {
  id: string;
  taskId: string;
  parentId?: string;
  stage: PipelineStage;
  schemaVersion: typeof DEVTOOLS_PIPELINE_SCHEMA_VERSION;
  at: number;
  source: PipelineRecordSource;
  kind: string;
  summary: string;
  payload: SerializedValue;
  diagnostics: PipelineDiagnostic[];
}

export type CompilerArtifactKind = "metadata" | "diagnostics";

export interface CompilerArtifact {
  revision: number;
  capturedAt: number;
  id: string;
  sourceId: string;
  kind: CompilerArtifactKind;
  payload: unknown;
}

export interface CompilerStateSnapshot {
  protocolVersion: typeof DEVTOOLS_PROTOCOL_VERSION;
  revision: number;
  artifacts: CompilerArtifact[];
}

export interface DevtoolsSnapshot {
  protocolVersion: typeof DEVTOOLS_PROTOCOL_VERSION;
  apps: AppSnapshot[];
  components: ComponentNodeSnapshot[];
}
