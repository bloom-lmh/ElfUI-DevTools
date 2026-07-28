import type {
  ComponentDetailSnapshot,
  CompilerStateSnapshot,
  DEVTOOLS_PROTOCOL_VERSION,
  DevtoolsSnapshot,
  PipelineRecord,
  TimelineEvent,
} from "./protocol.js";

export const DEVTOOLS_RPC_CAPABILITIES = [
  "component-tree",
  "component-detail",
  "timeline",
  "timeline-control",
  "reactivity-timeline",
  "pipeline",
  "pipeline-control",
  "compiler-state",
] as const;

export type DevtoolsCapability = (typeof DEVTOOLS_RPC_CAPABILITIES)[number];

export interface DevtoolsHandshakeParams {
  clientName: string;
  capabilities: DevtoolsCapability[];
}

export interface DevtoolsHandshakeResult {
  protocolVersion: typeof DEVTOOLS_PROTOCOL_VERSION;
  serverName: string;
  capabilities: DevtoolsCapability[];
  negotiatedCapabilities: DevtoolsCapability[];
}

export interface TimelineStatusSnapshot {
  paused: boolean;
  droppedEvents: number;
  aggregatedEvents: number;
}

export interface TimelineStateSnapshot {
  status: TimelineStatusSnapshot;
  events: TimelineEvent[];
}

export interface PipelineStateSnapshot {
  droppedRecords: number;
  records: PipelineRecord[];
}

export interface DevtoolsRpcMethodMap {
  "protocol.handshake": {
    params: DevtoolsHandshakeParams;
    result: DevtoolsHandshakeResult;
  };
  "app.snapshot": { params: Record<string, never>; result: DevtoolsSnapshot };
  "component.detail": {
    params: { id: string };
    result: ComponentDetailSnapshot | null;
  };
  "timeline.list": {
    params: Record<string, never>;
    result: TimelineStateSnapshot;
  };
  "timeline.setPaused": {
    params: { paused: boolean };
    result: TimelineStatusSnapshot;
  };
  "timeline.clear": {
    params: Record<string, never>;
    result: TimelineStatusSnapshot;
  };
  "pipeline.list": {
    params: Record<string, never>;
    result: PipelineStateSnapshot;
  };
  "pipeline.clear": {
    params: Record<string, never>;
    result: PipelineStateSnapshot;
  };
  "compiler.state": {
    params: Record<string, never>;
    result: CompilerStateSnapshot;
  };
}

export type DevtoolsRpcMethod = keyof DevtoolsRpcMethodMap;

export type DevtoolsRpcRequest<
  Method extends DevtoolsRpcMethod = DevtoolsRpcMethod,
> = Method extends DevtoolsRpcMethod
  ? {
      protocolVersion: number;
      requestId: string;
      method: Method;
      params: DevtoolsRpcMethodMap[Method]["params"];
    }
  : never;

export type DevtoolsRpcErrorCode =
  | "PROTOCOL_MISMATCH"
  | "INVALID_REQUEST"
  | "METHOD_NOT_FOUND"
  | "INVALID_PARAMS"
  | "INTERNAL_ERROR";

export interface DevtoolsRpcError {
  code: DevtoolsRpcErrorCode;
  message: string;
  data?: unknown;
}

export interface DevtoolsRpcSuccess<Result = unknown> {
  protocolVersion: typeof DEVTOOLS_PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: Result;
}

export interface DevtoolsRpcFailure {
  protocolVersion: typeof DEVTOOLS_PROTOCOL_VERSION;
  requestId: string;
  ok: false;
  error: DevtoolsRpcError;
}

export type DevtoolsRpcResponse<Result = unknown> =
  | DevtoolsRpcSuccess<Result>
  | DevtoolsRpcFailure;

export interface DevtoolsRpcHandler {
  handleRpcRequest(
    request: DevtoolsRpcRequest,
  ): Promise<DevtoolsRpcResponse> | DevtoolsRpcResponse;
}

export interface DevtoolsRpcTransport {
  request(request: DevtoolsRpcRequest): Promise<DevtoolsRpcResponse>;
  dispose?(): void;
}

export type DevtoolsRpcParams<Method extends DevtoolsRpcMethod> =
  DevtoolsRpcMethodMap[Method]["params"];

export type DevtoolsRpcResult<Method extends DevtoolsRpcMethod> =
  DevtoolsRpcMethodMap[Method]["result"];
