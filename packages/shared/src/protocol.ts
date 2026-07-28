export const DEVTOOLS_PROTOCOL_VERSION = 2 as const;
export const DEVTOOLS_PIPELINE_SCHEMA_VERSION = 1 as const;
export const DEVTOOLS_OPEN_IN_EDITOR_ENDPOINT =
  "/__elfui_devtools/open-in-editor" as const;
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
  fragment?: string;
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

export interface ComponentDetailSnapshot extends ComponentNodeSnapshot {
  props: SerializedValue;
  attrs: SerializedValue;
  setup: SerializedValue;
  exposed: SerializedValue;
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
