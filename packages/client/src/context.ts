import {
  DEVTOOLS_AI_CHANGE_SCHEMA_VERSION,
  type AIChangeConstraints,
  type AIChangeRequest,
  type ProjectContextSummary,
  type RectSnapshot,
  type ScreenshotAsset,
  type ScreenshotKind,
  type ScreenshotPhase,
  type SourceContextBlock,
  type VisualDraft,
} from "@elfui/devtools-shared";
import type { ElfUIDevtoolsBridge } from "@elfui/devtools-runtime";

export interface VisualDraftContext {
  readonly id: string;
  getDraft(): VisualDraft;
  attachScreenshot(screenshotId: string): void;
}

export interface ScreenshotCaptureInput {
  kind: ScreenshotKind;
  selection?: RectSnapshot;
  excludedRegions: RectSnapshot[];
}

export interface ScreenshotCaptureResult {
  dataUrl: string;
  mimeType: ScreenshotAsset["mimeType"];
  width: number;
  height: number;
}

export interface ScreenshotCaptureAdapter {
  capture(input: ScreenshotCaptureInput): Promise<ScreenshotCaptureResult>;
}

export interface CapturedScreenshotAsset extends ScreenshotAsset {
  dataUrl: string;
}

export interface ScreenshotControllerOptions {
  document?: Document;
  now?: () => number;
}

const dataUrlByteLength = (dataUrl: string): number => {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
};

const screenshotMetadata = (
  asset: ScreenshotAsset | CapturedScreenshotAsset,
): ScreenshotAsset => {
  const metadata = { ...asset } as ScreenshotAsset & { dataUrl?: string };
  delete metadata.dataUrl;
  return metadata;
};

export class ScreenshotController {
  private readonly document: Document;
  private readonly now: () => number;
  private readonly assets = new Map<string, CapturedScreenshotAsset>();
  private nextId = 1;

  public constructor(
    private readonly bridge: ElfUIDevtoolsBridge,
    private readonly visualSession: VisualDraftContext,
    private readonly adapter: ScreenshotCaptureAdapter,
    options: ScreenshotControllerOptions = {},
  ) {
    this.document = options.document ?? document;
    this.now = options.now ?? Date.now;
  }

  public async capture(
    phase: ScreenshotPhase,
    kind: ScreenshotKind,
    options: {
      selection?: RectSnapshot;
      excludedRegions?: RectSnapshot[];
    } = {},
  ): Promise<CapturedScreenshotAsset> {
    const excludedRegions = (options.excludedRegions ?? []).map((region) => ({
      ...region,
    }));
    const result = await this.adapter.capture({
      kind,
      ...(options.selection ? { selection: { ...options.selection } } : {}),
      excludedRegions,
    });
    const view = this.document.defaultView;
    const asset: CapturedScreenshotAsset = {
      id: `screenshot:${this.now()}:${this.nextId++}`,
      kind,
      phase,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
      devicePixelRatio: view?.devicePixelRatio ?? 1,
      route: view?.location
        ? `${view.location.pathname}${view.location.search}${view.location.hash}`
        : "/",
      scroll: { x: view?.scrollX ?? 0, y: view?.scrollY ?? 0 },
      capturedAt: this.now(),
      ...(options.selection ? { selection: { ...options.selection } } : {}),
      excludedRegions,
      byteLength: dataUrlByteLength(result.dataUrl),
      dataUrl: result.dataUrl,
    };
    this.assets.set(asset.id, asset);
    this.visualSession.attachScreenshot(asset.id);
    this.bridge.recordPipeline({
      taskId: this.visualSession.id,
      stage: "visual-intent",
      source: "visual-tools",
      kind: "visual.screenshot.capture",
      summary: `Captured ${phase} ${kind} screenshot ${result.width}×${result.height}`,
      payload: {
        asset: screenshotMetadata(asset),
        binary: { stored: true, byteLength: asset.byteLength },
      },
    });
    return { ...asset, excludedRegions: [...asset.excludedRegions] };
  }

  public getAsset(id: string): CapturedScreenshotAsset | null {
    const asset = this.assets.get(id);
    return asset
      ? {
          ...asset,
          excludedRegions: asset.excludedRegions.map((item) => ({ ...item })),
        }
      : null;
  }

  public getAssets(): CapturedScreenshotAsset[] {
    return Array.from(this.assets.values(), (asset) => ({
      ...asset,
      excludedRegions: asset.excludedRegions.map((item) => ({ ...item })),
    }));
  }
}

export interface AIContextBuilderOptions {
  document?: Document;
  now?: () => number;
}

export interface BuildAIChangeRequestInput {
  conversationId: string;
  project?: ProjectContextSummary;
  screenshots?: ScreenshotAsset[];
  sourceContext?: SourceContextBlock[];
  userMessage?: string;
  constraints?: Partial<AIChangeConstraints>;
}

const defaultConstraints: AIChangeConstraints = {
  preserveResponsiveLayout: true,
  preserveAccessibility: true,
  preservePublicAPI: true,
};

export class AIContextBuilder {
  private readonly document: Document;
  private readonly now: () => number;
  private nextRequestId = 1;

  public constructor(
    private readonly bridge: ElfUIDevtoolsBridge,
    private readonly visualSession: Pick<VisualDraftContext, "getDraft">,
    options: AIContextBuilderOptions = {},
  ) {
    this.document = options.document ?? document;
    this.now = options.now ?? Date.now;
  }

  public build(input: BuildAIChangeRequestInput): AIChangeRequest {
    const draft = this.visualSession.getDraft();
    if (
      draft.targets.length === 0 &&
      draft.intents.length === 0 &&
      draft.annotations.length === 0
    )
      throw new Error("Visual draft is empty");
    const view = this.document.defaultView;
    const location = view?.location;
    const sourceContext =
      input.sourceContext ?? this.sourceContextFromTargets(draft.targets);
    const screenshots = (input.screenshots ?? [])
      .filter((asset) => draft.screenshotIds.includes(asset.id))
      .map(screenshotMetadata);
    const request: AIChangeRequest = {
      schemaVersion: DEVTOOLS_AI_CHANGE_SCHEMA_VERSION,
      id: `ai-change:${this.now()}:${this.nextRequestId++}`,
      conversationId: input.conversationId,
      project: input.project ?? { framework: "elfui" },
      page: {
        url: location?.href ?? "",
        route: location
          ? `${location.pathname}${location.search}${location.hash}`
          : "/",
        title: this.document.title,
        viewport: {
          width: view?.innerWidth ?? 0,
          height: view?.innerHeight ?? 0,
        },
        devicePixelRatio: view?.devicePixelRatio ?? 1,
        scroll: { x: view?.scrollX ?? 0, y: view?.scrollY ?? 0 },
      },
      targets: draft.targets,
      intents: draft.intents,
      annotations: draft.annotations,
      screenshots,
      sourceContext,
      ...(input.userMessage ? { userMessage: input.userMessage } : {}),
      constraints: { ...defaultConstraints, ...input.constraints },
    };
    const contextRecord = this.bridge.recordPipeline({
      taskId: request.id,
      stage: "context-bundle",
      source: "context-builder",
      kind: "ai.context.bundle",
      summary: `Bundled ${request.targets.length} targets, ${request.intents.length} intents, and ${request.screenshots.length} screenshots`,
      payload: request,
    });
    this.bridge.recordPipeline({
      taskId: request.id,
      parentId: contextRecord.id,
      stage: "ai-request",
      source: "ai",
      kind: "ai.request.create",
      summary: `Prepared AI change request ${request.id}`,
      payload: request,
    });
    return request;
  }

  private sourceContextFromTargets(
    targets: AIChangeRequest["targets"],
  ): SourceContextBlock[] {
    const blocks = new Map<string, SourceContextBlock>();
    for (const target of targets) {
      if (!target.source) continue;
      const key =
        target.source.templateNodeId ??
        `${target.source.sourceId}:${target.source.component ?? ""}:${target.source.fragment ?? ""}`;
      if (blocks.has(key)) continue;
      blocks.set(key, {
        id: `source-context:${key}`,
        sourceId: target.source.sourceId,
        ...(target.source.component
          ? { component: target.source.component }
          : {}),
        ...(target.source.fragment ? { fragment: target.source.fragment } : {}),
        ...(target.source.templateNodeId
          ? { templateNodeId: target.source.templateNodeId }
          : {}),
        ...(target.source.range ? { range: { ...target.source.range } } : {}),
      });
    }
    return [...blocks.values()];
  }
}
