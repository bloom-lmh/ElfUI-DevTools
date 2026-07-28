import {
  DEVTOOLS_PROTOCOL_VERSION,
  DEVTOOLS_RPC_CAPABILITIES,
  type ComponentDetailSnapshot,
  type CompilerStateSnapshot,
  type DevtoolsCapability,
  type DevtoolsHandshakeResult,
  type DevtoolsRpcError as DevtoolsRpcErrorPayload,
  type DevtoolsRpcMethod,
  type DevtoolsRpcParams,
  type DevtoolsRpcRequest,
  type DevtoolsRpcResult,
  type DevtoolsRpcTransport,
  type DevtoolsSnapshot,
  type PipelineStateSnapshot,
  type TimelineStateSnapshot,
  type TimelineStatusSnapshot,
} from "@elfui/devtools-shared";

export interface DevtoolsRpcClientOptions {
  clientName?: string;
  capabilities?: DevtoolsCapability[];
}

export class DevtoolsRpcClientError extends Error {
  public constructor(public readonly rpcError: DevtoolsRpcErrorPayload) {
    super(rpcError.message);
    this.name = "DevtoolsRpcClientError";
  }
}

export class DevtoolsRpcClient {
  private readonly clientName: string;
  private readonly requestedCapabilities: DevtoolsCapability[];
  private negotiated = new Set<DevtoolsCapability>();
  private handshake: DevtoolsHandshakeResult | null = null;
  private nextRequestId = 1;

  public constructor(
    private readonly transport: DevtoolsRpcTransport,
    options: DevtoolsRpcClientOptions = {},
  ) {
    this.clientName = options.clientName ?? "@elfui/devtools-client";
    this.requestedCapabilities = options.capabilities ?? [
      ...DEVTOOLS_RPC_CAPABILITIES,
    ];
  }

  public get connected(): boolean {
    return this.handshake !== null;
  }

  public get capabilities(): readonly DevtoolsCapability[] {
    return this.handshake?.negotiatedCapabilities ?? [];
  }

  public async connect(): Promise<DevtoolsHandshakeResult> {
    const handshake = await this.request("protocol.handshake", {
      clientName: this.clientName,
      capabilities: this.requestedCapabilities,
    });
    this.handshake = handshake;
    this.negotiated = new Set(handshake.negotiatedCapabilities);
    return handshake;
  }

  public async getSnapshot(): Promise<DevtoolsSnapshot> {
    this.requireCapability("component-tree");
    return await this.request("app.snapshot", {});
  }

  public async getComponentDetail(
    id: string,
  ): Promise<ComponentDetailSnapshot | null> {
    this.requireCapability("component-detail");
    return await this.request("component.detail", { id });
  }

  public async getTimeline(): Promise<TimelineStateSnapshot> {
    this.requireCapability("timeline");
    return await this.request("timeline.list", {});
  }

  public async setTimelinePaused(
    paused: boolean,
  ): Promise<TimelineStatusSnapshot> {
    this.requireCapability("timeline-control");
    return await this.request("timeline.setPaused", { paused });
  }

  public async clearTimeline(): Promise<TimelineStatusSnapshot> {
    this.requireCapability("timeline-control");
    return await this.request("timeline.clear", {});
  }

  public async getPipeline(): Promise<PipelineStateSnapshot> {
    this.requireCapability("pipeline");
    return await this.request("pipeline.list", {});
  }

  public async clearPipeline(): Promise<PipelineStateSnapshot> {
    this.requireCapability("pipeline-control");
    return await this.request("pipeline.clear", {});
  }

  public async getCompilerState(): Promise<CompilerStateSnapshot> {
    this.requireCapability("compiler-state");
    return await this.request("compiler.state", {});
  }

  public dispose(): void {
    this.handshake = null;
    this.negotiated.clear();
    this.transport.dispose?.();
  }

  private requireCapability(capability: DevtoolsCapability): void {
    if (!this.connected) {
      throw new Error("ElfUI DevTools RPC client is not connected");
    }
    if (!this.negotiated.has(capability)) {
      throw new Error(
        `ElfUI DevTools capability not negotiated: ${capability}`,
      );
    }
  }

  private async request<Method extends DevtoolsRpcMethod>(
    method: Method,
    params: DevtoolsRpcParams<Method>,
  ): Promise<DevtoolsRpcResult<Method>> {
    const requestId = `client:${this.nextRequestId++}`;
    const request = {
      protocolVersion: DEVTOOLS_PROTOCOL_VERSION,
      requestId,
      method,
      params,
    } as DevtoolsRpcRequest<Method>;
    const response = await this.transport.request(request);
    if (response.protocolVersion !== DEVTOOLS_PROTOCOL_VERSION) {
      throw new Error(
        `ElfUI DevTools response protocol mismatch: ${response.protocolVersion}`,
      );
    }
    if (response.requestId !== requestId) {
      throw new Error(
        `ElfUI DevTools response requestId mismatch: expected ${requestId}, received ${response.requestId}`,
      );
    }
    if (!response.ok) throw new DevtoolsRpcClientError(response.error);
    return response.result as DevtoolsRpcResult<Method>;
  }
}
