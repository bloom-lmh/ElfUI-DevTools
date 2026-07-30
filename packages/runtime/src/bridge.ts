import {
  DEVTOOLS_RPC_CAPABILITIES,
  DEVTOOLS_PIPELINE_SCHEMA_VERSION,
  DEVTOOLS_PROTOCOL_VERSION,
  serialize,
  type AppSnapshot,
  type ComponentBindingSnapshot,
  type ComponentDiagnosticSnapshot,
  type ComponentDetailSnapshot,
  type ComponentNodeSnapshot,
  type CompilerArtifact,
  type CompilerStateSnapshot,
  type DevtoolsCapability,
  type DevtoolsRpcFailure,
  type DevtoolsRpcHandler,
  type DevtoolsRpcRequest,
  type DevtoolsRpcResponse,
  type DevtoolsRpcSuccess,
  type DevtoolsRpcTransport,
  type DevtoolsSnapshot,
  type PipelineDiagnostic,
  type PipelineRecord,
  type PipelineRecordSource,
  type PipelineStage,
  type PipelineStateSnapshot,
  type SerializedValue,
  type SourceLocation,
  type TimelineEvent,
  type TimelineStatusSnapshot,
} from "@elfui/devtools-shared";

export interface DevtoolsComponentInput {
  id?: string;
  host: HTMLElement;
  appId?: string | null;
  parentId?: string | null;
  parentHost?: HTMLElement | null;
  tag: string;
  displayName?: string;
  shadowMode?: "open" | "closed" | "none";
  source?: SourceLocation;
  props?: () => Record<string, unknown>;
  attrs?: () => Record<string, unknown>;
  setup?: () => Record<string, unknown>;
  exposed?: () => Record<string, unknown>;
}

export type ElfUIRuntimeEvent =
  | {
      type: "app:mount";
      app: { id: string; label: string; root: HTMLElement };
    }
  | { type: "app:unmount"; appId: string }
  | { type: "component:mount"; component: DevtoolsComponentInput }
  | { type: "component:update"; host: HTMLElement }
  | { type: "component:unmount"; host: HTMLElement }
  | { type: "component:error"; host: HTMLElement; error: unknown }
  | {
      type: "component:emit";
      host: HTMLElement;
      event: string;
      args: unknown[];
    };

export type ElfUIReactivityEvent =
  | {
      type: "reactivity:trigger";
      id: string;
      parentTriggerId: string | null;
      targetId: string;
      targetName?: string;
      key: string;
      effects: Array<{
        effectId: string;
        componentId: string | null;
        debug?: EffectDebugInfo;
      }>;
    }
  | {
      type: "reactivity:effect";
      triggerId: string;
      effectId: string;
      componentId: string | null;
      debug?: EffectDebugInfo;
      duration: number;
    };

interface EffectDebugInfo {
  kind: string;
  name?: string;
  source?: { line: number; column: number };
}

export interface DevtoolsBridgeOptions {
  now?: () => number;
  maxTimelineEvents?: number;
  maxPipelineRecords?: number;
  maxTimelineEventsPerWindow?: number;
  timelineWindowMs?: number;
  aggregateWindowMs?: number;
}

export type TimelineStatus = TimelineStatusSnapshot;

export type DevtoolsListener = (event: TimelineEvent) => void;
export type PipelineListener = (record: PipelineRecord) => void;

export interface PipelineRecordInput {
  taskId?: string;
  parentId?: string;
  stage: PipelineStage;
  source: PipelineRecordSource;
  kind: string;
  summary: string;
  payload: unknown;
  diagnostics?: PipelineDiagnostic[];
}

interface AppRecord {
  id: string;
  label: string;
  rootIds: Set<string>;
}

interface ComponentRecord {
  id: string;
  appId: string;
  parentId: string | null;
  host: WeakRef<HTMLElement>;
  input: Omit<DevtoolsComponentInput, "host" | "parentHost">;
  mounted: boolean;
  children: Set<string>;
  updateCount: number;
  lastUpdatedAt: number | null;
  error: unknown | null;
  bindings: Map<string, ComponentBindingSnapshot>;
}

const elementParent = (element: HTMLElement): HTMLElement | null => {
  let current: Node | null = element.parentNode;
  while (current) {
    if (current instanceof HTMLElement) return current;
    if (current instanceof ShadowRoot && current.host instanceof HTMLElement)
      return current.host;
    current = current.parentNode;
  }
  return null;
};

const snapshotValue = (
  read?: () => Record<string, unknown>,
): SerializedValue => {
  try {
    return serialize(read?.() ?? {});
  } catch (error) {
    return serialize(error instanceof Error ? error : new Error(String(error)));
  }
};

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const normalizeSourceId = (value: string): string =>
  value.replaceAll("\\", "/").replace(/^\.\/+/u, "");

const sourceIdsMatch = (left: string, right: string): boolean => {
  const normalizedLeft = normalizeSourceId(left);
  const normalizedRight = normalizeSourceId(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
};

const bindingSourceLocation = (
  componentSource: SourceLocation | undefined,
  bindingSource: { line: number; column: number } | undefined,
): SourceLocation | undefined => {
  if (!componentSource || !bindingSource) return undefined;
  return {
    file: componentSource.file,
    line: componentSource.line + bindingSource.line - 1,
    column:
      bindingSource.line === 1
        ? componentSource.column + bindingSource.column - 1
        : bindingSource.column,
  };
};

const compilerArtifactSummary = (artifact: CompilerArtifact): string => {
  if (artifact.kind === "metadata") {
    const metadata = objectValue(artifact.payload);
    const components = Array.isArray(metadata?.components)
      ? metadata.components.length
      : 0;
    return `${artifact.sourceId}: ${components} component${components === 1 ? "" : "s"}`;
  }
  const count = Array.isArray(artifact.payload) ? artifact.payload.length : 0;
  return `${artifact.sourceId}: ${count} compiler diagnostic${count === 1 ? "" : "s"}`;
};

const compilerArtifactDiagnostics = (
  artifact: CompilerArtifact,
): PipelineDiagnostic[] => {
  if (artifact.kind !== "diagnostics" || !Array.isArray(artifact.payload))
    return [];
  return artifact.payload.flatMap((value) => {
    const diagnostic = objectValue(value);
    if (!diagnostic) return [];
    const severity =
      diagnostic.severity === "error" || diagnostic.severity === "warning"
        ? diagnostic.severity
        : "info";
    return [
      {
        severity,
        code:
          typeof diagnostic.code === "string"
            ? diagnostic.code
            : "ELF_COMPILER_DIAGNOSTIC",
        message:
          typeof diagnostic.message === "string"
            ? diagnostic.message
            : "Compiler diagnostic",
      } satisfies PipelineDiagnostic,
    ];
  });
};

export class ElfUIDevtoolsBridge implements DevtoolsRpcHandler {
  private readonly apps = new Map<string, AppRecord>();
  private readonly components = new Map<string, ComponentRecord>();
  private readonly componentIds = new WeakMap<HTMLElement, string>();
  private readonly listeners = new Set<DevtoolsListener>();
  private readonly pipelineListeners = new Set<PipelineListener>();
  private readonly timeline: TimelineEvent[] = [];
  private readonly pipeline: PipelineRecord[] = [];
  private readonly compilerArtifacts = new Map<string, CompilerArtifact>();
  private readonly compilerMetadataRecordIds = new Map<string, string>();
  private readonly now: () => number;
  private readonly maxTimelineEvents: number;
  private readonly maxPipelineRecords: number;
  private readonly maxTimelineEventsPerWindow: number;
  private readonly timelineWindowMs: number;
  private readonly aggregateWindowMs: number;
  private timelinePaused = false;
  private droppedTimelineEvents = 0;
  private aggregatedTimelineEvents = 0;
  private droppedPipelineRecords = 0;
  private timelineWindowStartedAt = 0;
  private timelineWindowEventCount = 0;
  private lastAggregationKey: string | null = null;
  private lastAggregationCount = 1;
  private nextAppId = 1;
  private nextComponentId = 1;
  private nextEventId = 1;
  private nextPipelineRecordId = 1;

  public constructor(options: DevtoolsBridgeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxTimelineEvents = options.maxTimelineEvents ?? 1000;
    this.maxPipelineRecords = options.maxPipelineRecords ?? 500;
    this.maxTimelineEventsPerWindow = options.maxTimelineEventsPerWindow ?? 500;
    this.timelineWindowMs = options.timelineWindowMs ?? 1000;
    this.aggregateWindowMs = options.aggregateWindowMs ?? 16;
  }

  public registerComponent(input: DevtoolsComponentInput): string {
    const existingId = this.componentIds.get(input.host);
    if (existingId) return existingId;

    const parentId =
      input.parentId !== undefined
        ? input.parentId
        : this.findParentId(input.host, input.parentHost);
    const parent = parentId ? this.components.get(parentId) : undefined;
    const appId =
      parent?.appId ??
      input.appId ??
      this.createApp(input.displayName ?? input.tag);
    this.ensureApp(appId, input.displayName ?? input.tag);
    const requestedId = input.id;
    const id =
      requestedId && !this.components.has(requestedId)
        ? requestedId
        : `component:${this.nextComponentId++}`;
    const { host, parentHost: _parentHost, ...storedInput } = input;
    void _parentHost;
    const record: ComponentRecord = {
      id,
      appId,
      parentId,
      host: new WeakRef(host),
      input: storedInput,
      mounted: true,
      children: new Set(),
      updateCount: 0,
      lastUpdatedAt: null,
      error: null,
      bindings: new Map(),
    };
    this.components.set(id, record);
    this.componentIds.set(host, id);
    if (parent) parent.children.add(id);
    else if (!parentId) this.apps.get(appId)?.rootIds.add(id);
    for (const child of this.components.values()) {
      if (child.parentId === id) record.children.add(child.id);
    }
    this.emit({
      appId,
      componentId: id,
      layer: "component",
      type: "mount",
      summary: `${input.tag} mounted`,
    });
    return id;
  }

  public unregisterComponent(host: HTMLElement): void {
    const id = this.componentIds.get(host);
    if (!id) return;
    this.removeComponent(id);
  }

  private removeComponent(id: string): void {
    const record = this.components.get(id);
    if (!record) return;

    for (const childId of Array.from(record.children)) {
      this.removeComponent(childId);
    }
    const parent = record.parentId
      ? this.components.get(record.parentId)
      : undefined;
    if (parent) parent.children.delete(id);
    else this.apps.get(record.appId)?.rootIds.delete(id);
    this.components.delete(id);
    const host = record.host.deref();
    if (host) this.componentIds.delete(host);
    this.emit({
      appId: record.appId,
      componentId: id,
      layer: "component",
      type: "unmount",
      summary: `${record.input.tag} unmounted`,
    });
  }

  public notifyUpdate(host: HTMLElement): void {
    const record = this.findComponent(host);
    if (!record) return;
    record.updateCount += 1;
    record.lastUpdatedAt = this.now();
    this.emit({
      appId: record.appId,
      componentId: record.id,
      layer: "component",
      type: "update",
      summary: `${record.input.tag} updated`,
    });
  }

  public notifyError(host: HTMLElement, error: unknown): void {
    const record = this.findComponent(host);
    if (!record) return;
    record.error = error;
    this.emit({
      appId: record.appId,
      componentId: record.id,
      layer: "component",
      type: "error",
      summary: `${record.input.tag} error`,
      data: serialize(
        error instanceof Error ? error : new Error(String(error)),
      ),
    });
  }

  public registerApp(id: string, label: string): void {
    this.ensureApp(id, label);
  }

  public unregisterApp(id: string): void {
    for (const component of Array.from(this.components.values())) {
      if (component.appId === id) this.removeComponent(component.id);
    }
    this.apps.delete(id);
  }

  public readonly emitRuntimeEvent = (event: ElfUIRuntimeEvent): void => {
    switch (event.type) {
      case "app:mount":
        this.registerApp(event.app.id, event.app.label);
        break;
      case "app:unmount":
        this.unregisterApp(event.appId);
        break;
      case "component:mount":
        this.registerComponent(event.component);
        break;
      case "component:update":
        this.notifyUpdate(event.host);
        break;
      case "component:unmount":
        this.unregisterComponent(event.host);
        break;
      case "component:error":
        this.notifyError(event.host, event.error);
        break;
      case "component:emit": {
        const component = this.findComponent(event.host);
        if (!component) break;
        this.emit({
          appId: component.appId,
          componentId: component.id,
          layer: "events",
          type: event.event,
          summary: `${component.input.tag} emitted ${event.event}`,
          data: serialize(event.args),
        });
        break;
      }
    }
  };

  public readonly emitReactivityEvent = (event: ElfUIReactivityEvent): void => {
    if (event.type === "reactivity:trigger") {
      for (const effect of event.effects) {
        if (!effect.componentId) continue;
        this.captureBinding(
          effect.componentId,
          effect.effectId,
          effect.debug,
          true,
        );
      }
    } else if (event.componentId) {
      this.captureBinding(
        event.componentId,
        event.effectId,
        event.debug,
        false,
        event.duration,
      );
    }
    const componentIds =
      event.type === "reactivity:trigger"
        ? event.effects.flatMap((effect) =>
            effect.componentId ? [effect.componentId] : [],
          )
        : event.componentId
          ? [event.componentId]
          : [];
    const component = componentIds
      .map((id) => this.components.get(id))
      .find((record) => record !== undefined);
    if (!component) return;

    const firstDebug =
      event.type === "reactivity:trigger"
        ? event.effects.find((effect) => effect.debug)?.debug
        : event.debug;
    const binding = firstDebug?.name ? ` → ${firstDebug.name}` : "";
    const source = bindingSourceLocation(
      component.input.source,
      firstDebug?.source,
    );
    const location = source
      ? ` @ ${source.file ? `${source.file}:` : ""}${source.line}:${source.column}`
      : "";
    const summary =
      event.type === "reactivity:trigger"
        ? `${event.targetName ?? event.targetId}.${event.key}${binding} triggered ${event.effects.length} effect${event.effects.length === 1 ? "" : "s"}${location}`
        : `${firstDebug?.name ?? event.effectId} ran in ${event.duration.toFixed(2)}ms${location}`;
    this.emit({
      appId: component.appId,
      componentId: component.id,
      layer: "reactivity",
      type: event.type === "reactivity:trigger" ? "trigger" : "effect",
      summary,
      data: serialize(event),
    });
  };

  private captureBinding(
    componentId: string,
    effectId: string,
    debug: EffectDebugInfo | undefined,
    triggered: boolean,
    duration: number | null = null,
  ): void {
    if (debug?.kind !== "binding") return;
    const component = this.components.get(componentId);
    if (!component) return;
    const previous = component.bindings.get(effectId);
    const source =
      bindingSourceLocation(component.input.source, debug.source) ??
      previous?.source;
    component.bindings.set(effectId, {
      effectId,
      kind: debug.kind,
      name: debug.name ?? previous?.name ?? effectId,
      ...(source ? { source } : {}),
      triggerCount: (previous?.triggerCount ?? 0) + (triggered ? 1 : 0),
      runCount: (previous?.runCount ?? 0) + (triggered ? 0 : 1),
      lastDuration:
        duration === null ? (previous?.lastDuration ?? null) : duration,
    });
  }

  public getSnapshot(): DevtoolsSnapshot {
    return {
      protocolVersion: DEVTOOLS_PROTOCOL_VERSION,
      apps: Array.from(this.apps.values(), (app) => this.toAppSnapshot(app)),
      components: Array.from(this.components.values(), (component) =>
        this.toNodeSnapshot(component),
      ),
    };
  }

  public getComponentDetail(id: string): ComponentDetailSnapshot | null {
    const component = this.components.get(id);
    if (!component) return null;
    return {
      ...this.toNodeSnapshot(component),
      props: snapshotValue(component.input.props),
      attrs: snapshotValue(component.input.attrs),
      setup: snapshotValue(component.input.setup),
      exposed: snapshotValue(component.input.exposed),
      bindings: Array.from(component.bindings.values(), (binding) => ({
        ...binding,
        ...(binding.source ? { source: { ...binding.source } } : {}),
      })).sort((left, right) => left.name.localeCompare(right.name)),
      diagnostics: this.componentDiagnostics(component),
      lifecycle: {
        updateCount: component.updateCount,
        lastUpdatedAt: component.lastUpdatedAt,
        error: component.error === null ? null : serialize(component.error),
      },
    };
  }

  private componentDiagnostics(
    component: ComponentRecord,
  ): ComponentDiagnosticSnapshot[] {
    const sourceFile = component.input.source?.file;
    if (!sourceFile) return [];
    return Array.from(this.compilerArtifacts.values()).flatMap((artifact) => {
      if (
        artifact.kind !== "diagnostics" ||
        !sourceIdsMatch(sourceFile, artifact.sourceId) ||
        !Array.isArray(artifact.payload)
      )
        return [];
      return artifact.payload.flatMap((value) => {
        const diagnostic = objectValue(value);
        if (!diagnostic) return [];
        if (
          typeof diagnostic.component === "string" &&
          diagnostic.component !== component.input.tag &&
          diagnostic.component !== component.input.displayName
        )
          return [];
        const line =
          typeof diagnostic.line === "number" ? diagnostic.line : undefined;
        const column =
          typeof diagnostic.column === "number" ? diagnostic.column : undefined;
        const file =
          typeof diagnostic.file === "string"
            ? diagnostic.file
            : artifact.sourceId;
        return [
          {
            severity:
              diagnostic.severity === "error" ||
              diagnostic.severity === "warning"
                ? diagnostic.severity
                : "info",
            code:
              typeof diagnostic.code === "string"
                ? diagnostic.code
                : "ELF_COMPILER_DIAGNOSTIC",
            message:
              typeof diagnostic.message === "string"
                ? diagnostic.message
                : "Compiler diagnostic",
            ...(typeof diagnostic.hint === "string"
              ? { hint: diagnostic.hint }
              : {}),
            ...(line !== undefined && column !== undefined
              ? { source: { file, line, column } }
              : {}),
          } satisfies ComponentDiagnosticSnapshot,
        ];
      });
    });
  }

  public getComponentId(host: HTMLElement): string | null {
    return this.componentIds.get(host) ?? null;
  }

  public getComponentHost(id: string): HTMLElement | null {
    return this.components.get(id)?.host.deref() ?? null;
  }

  public getTimeline(): readonly TimelineEvent[] {
    return this.timeline;
  }

  public isTimelineRecording(): boolean {
    return !this.timelinePaused;
  }

  public getTimelineStatus(): TimelineStatus {
    return {
      paused: this.timelinePaused,
      droppedEvents: this.droppedTimelineEvents,
      aggregatedEvents: this.aggregatedTimelineEvents,
    };
  }

  public setTimelinePaused(paused: boolean): void {
    this.timelinePaused = paused;
  }

  public clearTimeline(): void {
    this.timeline.length = 0;
    this.droppedTimelineEvents = 0;
    this.aggregatedTimelineEvents = 0;
    this.timelineWindowEventCount = 0;
    this.timelineWindowStartedAt = this.now();
    this.lastAggregationKey = null;
    this.lastAggregationCount = 1;
  }

  public recordPipeline(input: PipelineRecordInput): PipelineRecord {
    const record: PipelineRecord = {
      id: `pipeline:${this.nextPipelineRecordId++}`,
      taskId: input.taskId ?? "session:observation",
      ...(input.parentId ? { parentId: input.parentId } : {}),
      stage: input.stage,
      schemaVersion: DEVTOOLS_PIPELINE_SCHEMA_VERSION,
      at: this.now(),
      source: input.source,
      kind: input.kind,
      summary: input.summary,
      payload: serialize(input.payload),
      diagnostics: [...(input.diagnostics ?? [])],
    };
    this.pipeline.push(record);
    if (this.pipeline.length > this.maxPipelineRecords) {
      const removed = this.pipeline.length - this.maxPipelineRecords;
      this.pipeline.splice(0, removed);
      this.droppedPipelineRecords += removed;
    }
    for (const listener of this.pipelineListeners) listener(record);
    return record;
  }

  public getPipelineState(): PipelineStateSnapshot {
    return {
      droppedRecords: this.droppedPipelineRecords,
      records: [...this.pipeline],
    };
  }

  public clearPipeline(): PipelineStateSnapshot {
    this.pipeline.length = 0;
    this.droppedPipelineRecords = 0;
    return this.getPipelineState();
  }

  public ingestCompilerArtifact(artifact: CompilerArtifact): void {
    if (!Number.isSafeInteger(artifact.revision) || artifact.revision < 1)
      return;
    const key = `${artifact.kind}:${artifact.sourceId}`;
    const existing = this.compilerArtifacts.get(key);
    if (existing && existing.revision >= artifact.revision) return;
    this.compilerArtifacts.set(key, artifact);
    const record = this.recordPipeline({
      taskId: `compile:${artifact.sourceId}`,
      ...(artifact.kind === "diagnostics" &&
      this.compilerMetadataRecordIds.has(artifact.sourceId)
        ? {
            parentId: this.compilerMetadataRecordIds.get(artifact.sourceId)!,
          }
        : {}),
      stage: "observation",
      source: "compiler",
      kind: `compiler.${artifact.kind}`,
      summary: compilerArtifactSummary(artifact),
      payload: artifact,
      diagnostics: compilerArtifactDiagnostics(artifact),
    });
    if (artifact.kind === "metadata")
      this.compilerMetadataRecordIds.set(artifact.sourceId, record.id);
  }

  public getCompilerState(): CompilerStateSnapshot {
    const artifacts = [...this.compilerArtifacts.values()].sort(
      (left, right) => left.revision - right.revision,
    );
    return {
      protocolVersion: DEVTOOLS_PROTOCOL_VERSION,
      revision: artifacts.reduce(
        (latest, artifact) => Math.max(latest, artifact.revision),
        0,
      ),
      artifacts,
    };
  }

  public handleRpcRequest(request: DevtoolsRpcRequest): DevtoolsRpcResponse {
    const requestId =
      typeof request.requestId === "string" && request.requestId
        ? request.requestId
        : "invalid-request";
    if (request.protocolVersion !== DEVTOOLS_PROTOCOL_VERSION) {
      return this.rpcFailure(
        requestId,
        "PROTOCOL_MISMATCH",
        `Unsupported protocol version ${request.protocolVersion}; expected ${DEVTOOLS_PROTOCOL_VERSION}`,
        {
          received: request.protocolVersion,
          supported: DEVTOOLS_PROTOCOL_VERSION,
        },
      );
    }
    if (requestId === "invalid-request") {
      return this.rpcFailure(
        requestId,
        "INVALID_REQUEST",
        "requestId must be a non-empty string",
      );
    }

    try {
      switch (request.method) {
        case "protocol.handshake": {
          const params = request.params;
          if (
            !params ||
            typeof params.clientName !== "string" ||
            !Array.isArray(params.capabilities)
          ) {
            return this.rpcFailure(
              requestId,
              "INVALID_PARAMS",
              "Handshake requires clientName and capabilities",
            );
          }
          const supported = new Set<DevtoolsCapability>(
            DEVTOOLS_RPC_CAPABILITIES,
          );
          const negotiatedCapabilities = params.capabilities.filter(
            (capability): capability is DevtoolsCapability =>
              supported.has(capability),
          );
          return this.rpcSuccess(requestId, {
            protocolVersion: DEVTOOLS_PROTOCOL_VERSION,
            serverName: "@elfui/devtools-runtime",
            capabilities: [...DEVTOOLS_RPC_CAPABILITIES],
            negotiatedCapabilities,
          });
        }
        case "app.snapshot":
          return this.rpcSuccess(requestId, this.getSnapshot());
        case "component.detail":
          if (typeof request.params?.id !== "string") {
            return this.rpcFailure(
              requestId,
              "INVALID_PARAMS",
              "component.detail requires a string id",
            );
          }
          return this.rpcSuccess(
            requestId,
            this.getComponentDetail(request.params.id),
          );
        case "timeline.list":
          return this.rpcSuccess(requestId, {
            status: this.getTimelineStatus(),
            events: [...this.getTimeline()],
          });
        case "timeline.setPaused":
          if (typeof request.params?.paused !== "boolean") {
            return this.rpcFailure(
              requestId,
              "INVALID_PARAMS",
              "timeline.setPaused requires a boolean paused value",
            );
          }
          this.setTimelinePaused(request.params.paused);
          return this.rpcSuccess(requestId, this.getTimelineStatus());
        case "timeline.clear":
          this.clearTimeline();
          return this.rpcSuccess(requestId, this.getTimelineStatus());
        case "pipeline.list":
          return this.rpcSuccess(requestId, this.getPipelineState());
        case "pipeline.clear":
          return this.rpcSuccess(requestId, this.clearPipeline());
        case "compiler.state":
          return this.rpcSuccess(requestId, this.getCompilerState());
        default:
          return this.rpcFailure(
            requestId,
            "METHOD_NOT_FOUND",
            `Unknown RPC method: ${String((request as { method?: unknown }).method)}`,
          );
      }
    } catch (error) {
      return this.rpcFailure(
        requestId,
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  public on(listener: DevtoolsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onPipeline(listener: PipelineListener): () => void {
    this.pipelineListeners.add(listener);
    return () => this.pipelineListeners.delete(listener);
  }

  private createApp(label: string): string {
    const id = `app:${this.nextAppId++}`;
    this.apps.set(id, { id, label, rootIds: new Set() });
    return id;
  }

  private ensureApp(id: string, label: string): AppRecord {
    const existing = this.apps.get(id);
    if (existing) return existing;
    const app = { id, label, rootIds: new Set<string>() };
    this.apps.set(id, app);
    return app;
  }

  private findParentId(
    host: HTMLElement,
    explicitParent?: HTMLElement | null,
  ): string | null {
    if (explicitParent) {
      const explicitId = this.componentIds.get(explicitParent);
      if (explicitId) return explicitId;
    }
    let parent = elementParent(host);
    while (parent) {
      const id = this.componentIds.get(parent);
      if (id) return id;
      parent = elementParent(parent);
    }
    return null;
  }

  private findComponent(host: HTMLElement): ComponentRecord | null {
    const id = this.componentIds.get(host);
    return id ? (this.components.get(id) ?? null) : null;
  }

  private toAppSnapshot(app: AppRecord): AppSnapshot {
    return { id: app.id, label: app.label, rootIds: Array.from(app.rootIds) };
  }

  private toNodeSnapshot(component: ComponentRecord): ComponentNodeSnapshot {
    return {
      id: component.id,
      appId: component.appId,
      parentId: component.parentId,
      tag: component.input.tag,
      displayName: component.input.displayName ?? component.input.tag,
      mounted: component.mounted,
      shadowMode: component.input.shadowMode ?? "open",
      children: Array.from(component.children),
      ...(component.input.source ? { source: component.input.source } : {}),
    };
  }

  private emit(event: Omit<TimelineEvent, "id" | "at">): void {
    const at = this.now();
    this.recordPipeline({
      stage: "observation",
      source: "runtime",
      kind: `${event.layer}.${event.type}`,
      summary: event.summary,
      payload: { at, ...event },
    });
    if (this.timelinePaused) {
      this.droppedTimelineEvents += 1;
      return;
    }
    if (at - this.timelineWindowStartedAt >= this.timelineWindowMs) {
      this.timelineWindowStartedAt = at;
      this.timelineWindowEventCount = 0;
    }
    if (this.timelineWindowEventCount >= this.maxTimelineEventsPerWindow) {
      this.droppedTimelineEvents += 1;
      return;
    }
    this.timelineWindowEventCount += 1;

    const aggregateKey =
      event.layer === "reactivity"
        ? `${event.appId}:${event.componentId ?? ""}:${event.type}:${event.summary.replace(/\d+(?:\.\d+)?ms/g, "<duration>")}`
        : null;
    const previous = this.timeline.at(-1);
    if (
      aggregateKey &&
      aggregateKey === this.lastAggregationKey &&
      previous &&
      at - previous.at <= this.aggregateWindowMs
    ) {
      this.lastAggregationCount += 1;
      this.aggregatedTimelineEvents += 1;
      previous.at = at;
      previous.summary = `${event.summary} ×${this.lastAggregationCount}`;
      if (event.data) previous.data = event.data;
      for (const listener of this.listeners) listener(previous);
      return;
    }

    const timelineEvent: TimelineEvent = {
      id: `event:${this.nextEventId++}`,
      at,
      ...event,
    };
    this.lastAggregationKey = aggregateKey;
    this.lastAggregationCount = 1;
    this.timeline.push(timelineEvent);
    if (this.timeline.length > this.maxTimelineEvents)
      this.timeline.splice(0, this.timeline.length - this.maxTimelineEvents);
    for (const listener of this.listeners) listener(timelineEvent);
  }

  private rpcSuccess<Result>(
    requestId: string,
    result: Result,
  ): DevtoolsRpcSuccess<Result> {
    return {
      protocolVersion: DEVTOOLS_PROTOCOL_VERSION,
      requestId,
      ok: true,
      result,
    };
  }

  private rpcFailure(
    requestId: string,
    code: DevtoolsRpcFailure["error"]["code"],
    message: string,
    data?: unknown,
  ): DevtoolsRpcFailure {
    return {
      protocolVersion: DEVTOOLS_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    };
  }
}

export const createDevtoolsBridge = (
  options?: DevtoolsBridgeOptions,
): ElfUIDevtoolsBridge => new ElfUIDevtoolsBridge(options);

export const createInPageDevtoolsTransport = (
  handler: DevtoolsRpcHandler,
): DevtoolsRpcTransport => {
  let disposed = false;
  return {
    request: async (request) => {
      if (disposed) throw new Error("ElfUI DevTools transport is disposed");
      return await handler.handleRpcRequest(request);
    },
    dispose: () => {
      disposed = true;
    },
  };
};

export const DEVTOOLS_GLOBAL_HOOK = "__ELFUI_DEVTOOLS_GLOBAL_HOOK__";

export const installGlobalDevtoolsBridge = (
  bridge: ElfUIDevtoolsBridge,
  target: Record<string, unknown> = globalThis,
): (() => void) => {
  const previous = target[DEVTOOLS_GLOBAL_HOOK];
  target[DEVTOOLS_GLOBAL_HOOK] = bridge;
  return () => {
    if (target[DEVTOOLS_GLOBAL_HOOK] !== bridge) return;
    if (previous === undefined) delete target[DEVTOOLS_GLOBAL_HOOK];
    else target[DEVTOOLS_GLOBAL_HOOK] = previous;
  };
};
