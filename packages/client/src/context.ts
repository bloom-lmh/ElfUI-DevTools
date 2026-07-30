import {
  DEFAULT_AI_CONTEXT_BUDGET,
  DEVTOOLS_AI_CHANGE_SCHEMA_VERSION,
  redactSensitiveText,
  type AIChangeConstraints,
  type AIChangeDiagnostic,
  type AIChangeFollowUpContext,
  type AIChangeRequest,
  type AIContextBudget,
  type AIContextGovernance,
  type AIContextOmission,
  type AIContextRedactionSummary,
  type PipelineDiagnostic,
  type ProjectContextSummary,
  type SourceContextBlock,
} from "@elfui/devtools-shared";
import {
  type RectSnapshot,
  type ScreenshotAsset,
  type ScreenshotKind,
  type ScreenshotPhase,
  type VisualDraft,
} from "@elfui/devtools-visual-intent";
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
  devicePixelRatio?: number;
}

export interface ScreenshotCaptureAdapter {
  capture(input: ScreenshotCaptureInput): Promise<ScreenshotCaptureResult>;
}

export interface CapturedScreenshotAsset extends ScreenshotAsset {
  dataUrl: string;
}

type DisplayMediaCapture = (
  options: DisplayMediaStreamOptions,
) => Promise<MediaStream>;

export interface DisplayMediaScreenshotAdapterOptions {
  document?: Document;
  getDisplayMedia?: DisplayMediaCapture;
  createVideo?: () => HTMLVideoElement;
  createCanvas?: () => HTMLCanvasElement;
}

export interface ProjectedScreenshotCapture {
  clip: RectSnapshot;
  source: RectSnapshot;
  output: { width: number; height: number };
  masks: RectSnapshot[];
  scaleX: number;
  scaleY: number;
}

const intersectRects = (
  first: RectSnapshot,
  second: RectSnapshot,
): RectSnapshot | null => {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
};

export const projectScreenshotCapture = (
  viewport: { width: number; height: number },
  frame: { width: number; height: number },
  input: ScreenshotCaptureInput,
): ProjectedScreenshotCapture => {
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    frame.width <= 0 ||
    frame.height <= 0
  )
    throw new Error("Screenshot dimensions must be greater than zero");
  const viewportRect: RectSnapshot = {
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
  };
  if (input.kind === "selection" && !input.selection)
    throw new Error("Selection screenshots require a selection rectangle");
  const clip =
    input.kind === "selection" && input.selection
      ? intersectRects(viewportRect, input.selection)
      : viewportRect;
  if (!clip) throw new Error("Screenshot selection is outside the viewport");
  const scaleX = frame.width / viewport.width;
  const scaleY = frame.height / viewport.height;
  const output = {
    width: Math.max(1, Math.round(clip.width * scaleX)),
    height: Math.max(1, Math.round(clip.height * scaleY)),
  };
  const masks = input.excludedRegions.flatMap((region) => {
    const intersection = intersectRects(clip, region);
    return intersection
      ? [
          {
            x: Math.round((intersection.x - clip.x) * scaleX),
            y: Math.round((intersection.y - clip.y) * scaleY),
            width: Math.round(intersection.width * scaleX),
            height: Math.round(intersection.height * scaleY),
          },
        ]
      : [];
  });
  return {
    clip,
    source: {
      x: clip.x * scaleX,
      y: clip.y * scaleY,
      width: clip.width * scaleX,
      height: clip.height * scaleY,
    },
    output,
    masks,
    scaleX,
    scaleY,
  };
};

export class DisplayMediaScreenshotAdapter implements ScreenshotCaptureAdapter {
  private readonly document: Document;
  private readonly getDisplayMedia: DisplayMediaCapture | undefined;
  private readonly createVideo: () => HTMLVideoElement;
  private readonly createCanvas: () => HTMLCanvasElement;

  public constructor(options: DisplayMediaScreenshotAdapterOptions = {}) {
    this.document = options.document ?? document;
    const mediaDevices = this.document.defaultView?.navigator.mediaDevices;
    this.getDisplayMedia =
      options.getDisplayMedia ??
      (mediaDevices?.getDisplayMedia
        ? mediaDevices.getDisplayMedia.bind(mediaDevices)
        : undefined);
    this.createVideo =
      options.createVideo ?? (() => this.document.createElement("video"));
    this.createCanvas =
      options.createCanvas ?? (() => this.document.createElement("canvas"));
  }

  public get supported(): boolean {
    return Boolean(this.getDisplayMedia);
  }

  public async capture(
    input: ScreenshotCaptureInput,
  ): Promise<ScreenshotCaptureResult> {
    if (!this.getDisplayMedia)
      throw new Error("Browser tab capture is not supported in this browser");
    const stream = await this.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: false,
    });
    const video = this.createVideo();
    try {
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("Screen capture did not provide a video");
      const displaySurface = track.getSettings().displaySurface;
      if (displaySurface && displaySurface !== "browser")
        throw new Error("Choose the current browser tab for an exact capture");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      if (!video.videoWidth || !video.videoHeight)
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("loadedmetadata", () => resolve(), {
            once: true,
          });
          video.addEventListener(
            "error",
            () => reject(new Error("Could not read the captured browser tab")),
            { once: true },
          );
        });
      await video.play();
      const view = this.document.defaultView;
      const projection = projectScreenshotCapture(
        {
          width: view?.innerWidth ?? video.videoWidth,
          height: view?.innerHeight ?? video.videoHeight,
        },
        { width: video.videoWidth, height: video.videoHeight },
        input,
      );
      const canvas = this.createCanvas();
      canvas.width = projection.output.width;
      canvas.height = projection.output.height;
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("Canvas screenshot rendering is unavailable");
      context.drawImage(
        video,
        projection.source.x,
        projection.source.y,
        projection.source.width,
        projection.source.height,
        0,
        0,
        projection.output.width,
        projection.output.height,
      );
      context.fillStyle = "#111827";
      for (const mask of projection.masks)
        context.fillRect(mask.x, mask.y, mask.width, mask.height);
      return {
        dataUrl: canvas.toDataURL("image/png"),
        mimeType: "image/png",
        width: projection.output.width,
        height: projection.output.height,
        devicePixelRatio: projection.scaleX,
      };
    } finally {
      video.srcObject = null;
      for (const track of stream.getTracks()) track.stop();
    }
  }
}

export const createDisplayMediaScreenshotAdapter = (
  options: DisplayMediaScreenshotAdapterOptions = {},
): DisplayMediaScreenshotAdapter | null => {
  const adapter = new DisplayMediaScreenshotAdapter(options);
  return adapter.supported ? adapter : null;
};

export interface ScreenshotControllerOptions {
  document?: Document;
  now?: () => number;
}

export interface ScreenshotControllerCaptureOptions {
  selection?: RectSnapshot;
  excludedRegions?: RectSnapshot[];
  attachToDraft?: boolean;
}

const dataUrlByteLength = (dataUrl: string): number => {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
};

export const toScreenshotMetadata = (
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
    options: ScreenshotControllerCaptureOptions = {},
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
      devicePixelRatio: result.devicePixelRatio ?? view?.devicePixelRatio ?? 1,
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
    const attachedToDraft = options.attachToDraft !== false;
    if (attachedToDraft) this.visualSession.attachScreenshot(asset.id);
    this.bridge.recordPipeline({
      taskId: this.visualSession.id,
      stage: "visual-intent",
      source: "visual-tools",
      kind: "visual.screenshot.capture",
      summary: `Captured ${phase} ${kind} screenshot ${result.width}×${result.height}`,
      payload: {
        asset: toScreenshotMetadata(asset),
        binary: { stored: true, byteLength: asset.byteLength },
        attachedToDraft,
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

  public retainAssets(ids: readonly string[]): void {
    const retained = new Set(ids);
    for (const id of this.assets.keys())
      if (!retained.has(id)) this.assets.delete(id);
  }

  public clear(): void {
    this.assets.clear();
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
  additionalScreenshotIds?: string[];
  sourceContext?: SourceContextBlock[];
  diagnostics?: AIChangeDiagnostic[];
  userMessage?: string;
  followUp?: AIChangeFollowUpContext;
  constraints?: Partial<AIChangeConstraints>;
  budget?: Partial<AIContextBudget>;
  approvedSourceIds?: string[];
}

const defaultConstraints: AIChangeConstraints = {
  preserveResponsiveLayout: true,
  preserveAccessibility: true,
  preservePublicAPI: true,
};

const MAX_FOLLOW_UP_REFERENCES = 64;
const MAX_ADDITIONAL_SCREENSHOTS = 8;
const MAX_CONTEXT_DIAGNOSTICS = 50;
const MAX_CONTEXT_DIAGNOSTIC_CHARACTERS = 20_000;

const isBoundedContextId = (value: string): boolean =>
  value.length > 0 && value.length <= 240;

const cloneFollowUpContext = (
  followUp: AIChangeFollowUpContext | undefined,
  draft: VisualDraft,
): AIChangeFollowUpContext | undefined => {
  if (!followUp) return undefined;
  for (const id of [
    followUp.previousRequestId,
    followUp.proposalId,
    followUp.applicationId,
    followUp.verificationId,
    followUp.reviewId,
    followUp.resultScreenshotId,
  ])
    if (!isBoundedContextId(id))
      throw new Error("Follow-up context contains an invalid correlation ID");
  if (
    followUp.references.length === 0 ||
    followUp.references.length > MAX_FOLLOW_UP_REFERENCES
  )
    throw new Error("Follow-up context exceeds the stable reference limit");
  const validReferences = new Set([
    ...draft.intents.map((intent) => `visual-intent:${intent.id}`),
    ...draft.annotations.map((annotation) => `annotation:${annotation.id}`),
  ]);
  const seen = new Set<string>();
  const references = followUp.references.map((reference) => {
    const key = `${reference.kind}:${reference.id}`;
    if (
      !isBoundedContextId(reference.id) ||
      (reference.status !== "partial" && reference.status !== "unmet") ||
      !validReferences.has(key) ||
      seen.has(key)
    )
      throw new Error(
        `Follow-up reference is not part of the current visual draft: ${key}`,
      );
    seen.add(key);
    return { ...reference };
  });
  return { ...followUp, references };
};

interface GovernedAIContext {
  sourceContext: SourceContextBlock[];
  screenshots: ScreenshotAsset[];
  diagnostics: AIChangeDiagnostic[];
  userMessage?: string;
  governance: AIContextGovernance;
}

const normalizedBudgetValue = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;

const normalizeContextBudget = (
  budget: Partial<AIContextBudget> | undefined,
): AIContextBudget => ({
  maxSourceBlocks: normalizedBudgetValue(
    budget?.maxSourceBlocks,
    DEFAULT_AI_CONTEXT_BUDGET.maxSourceBlocks,
  ),
  maxSourceCharacters: normalizedBudgetValue(
    budget?.maxSourceCharacters,
    DEFAULT_AI_CONTEXT_BUDGET.maxSourceCharacters,
  ),
  maxScreenshotBytes: normalizedBudgetValue(
    budget?.maxScreenshotBytes,
    DEFAULT_AI_CONTEXT_BUDGET.maxScreenshotBytes,
  ),
  maxUserMessageCharacters: normalizedBudgetValue(
    budget?.maxUserMessageCharacters,
    DEFAULT_AI_CONTEXT_BUDGET.maxUserMessageCharacters,
  ),
});

const governAIContext = (
  input: BuildAIChangeRequestInput,
  selectedSourceIds: ReadonlySet<string>,
  sourceCandidates: readonly SourceContextBlock[],
  screenshotCandidates: readonly ScreenshotAsset[],
  constraints: AIChangeConstraints,
): GovernedAIContext => {
  const budget = normalizeContextBudget(input.budget);
  const approvedSourceIds = [...new Set(input.approvedSourceIds ?? [])].sort();
  const approved = new Set(approvedSourceIds);
  const allowed = constraints.allowedFiles
    ? new Set(constraints.allowedFiles)
    : null;
  const pendingSourceApprovals = new Set<string>();
  const omissions: AIContextOmission[] = [];
  const redactions: AIContextRedactionSummary[] = [];
  const sourceContext: SourceContextBlock[] = [];
  let sourceCharacters = 0;

  for (const block of sourceCandidates) {
    if (allowed && !allowed.has(block.sourceId)) {
      omissions.push({ kind: "source", id: block.id, reason: "not-allowed" });
      continue;
    }
    if (
      !selectedSourceIds.has(block.sourceId) &&
      !approved.has(block.sourceId)
    ) {
      pendingSourceApprovals.add(block.sourceId);
      omissions.push({
        kind: "source",
        id: block.id,
        reason: "approval-required",
      });
      continue;
    }
    if (sourceContext.length >= budget.maxSourceBlocks) {
      omissions.push({
        kind: "source",
        id: block.id,
        reason: "source-budget",
      });
      continue;
    }
    const redacted =
      block.content === undefined ? null : redactSensitiveText(block.content);
    const contentLength = redacted?.text.length ?? 0;
    if (sourceCharacters + contentLength > budget.maxSourceCharacters) {
      omissions.push({
        kind: "source",
        id: block.id,
        reason: "source-budget",
      });
      continue;
    }
    if (redacted && redacted.replacements > 0)
      redactions.push({
        location: "source",
        id: block.id,
        replacements: redacted.replacements,
      });
    sourceContext.push({
      ...block,
      ...(redacted ? { content: redacted.text } : {}),
    });
    sourceCharacters += contentLength;
  }

  const diagnostics: AIChangeDiagnostic[] = [];
  const diagnosticIds = new Set<string>();
  let diagnosticCharacters = 0;
  for (const diagnostic of input.diagnostics ?? []) {
    if (
      !isBoundedContextId(diagnostic.id) ||
      diagnosticIds.has(diagnostic.id) ||
      !isBoundedContextId(diagnostic.code) ||
      !["error", "warning", "info"].includes(diagnostic.severity)
    )
      continue;
    if (
      diagnostic.sourceId &&
      ((allowed && !allowed.has(diagnostic.sourceId)) ||
        (!selectedSourceIds.has(diagnostic.sourceId) &&
          !approved.has(diagnostic.sourceId)))
    ) {
      omissions.push({
        kind: "diagnostic",
        id: diagnostic.id,
        reason: "not-allowed",
      });
      continue;
    }
    const redacted = redactSensitiveText(diagnostic.message);
    const message = redacted.text.slice(0, 500);
    if (
      diagnostics.length >= MAX_CONTEXT_DIAGNOSTICS ||
      diagnosticCharacters + message.length > MAX_CONTEXT_DIAGNOSTIC_CHARACTERS
    ) {
      omissions.push({
        kind: "diagnostic",
        id: diagnostic.id,
        reason: "diagnostic-budget",
      });
      continue;
    }
    diagnosticIds.add(diagnostic.id);
    diagnosticCharacters += message.length;
    if (redacted.replacements > 0)
      redactions.push({
        location: "diagnostic",
        id: diagnostic.id,
        replacements: redacted.replacements,
      });
    diagnostics.push({
      ...diagnostic,
      code: diagnostic.code.slice(0, 100),
      message,
      ...(diagnostic.source ? { source: { ...diagnostic.source } } : {}),
    });
  }

  const screenshots: ScreenshotAsset[] = [];
  let screenshotBytes = 0;
  for (const asset of screenshotCandidates) {
    if (screenshotBytes + asset.byteLength > budget.maxScreenshotBytes) {
      omissions.push({
        kind: "screenshot",
        id: asset.id,
        reason: "screenshot-budget",
      });
      continue;
    }
    screenshots.push(toScreenshotMetadata(asset));
    screenshotBytes += asset.byteLength;
  }

  const redactedMessage = input.userMessage
    ? redactSensitiveText(input.userMessage)
    : null;
  if (redactedMessage && redactedMessage.replacements > 0)
    redactions.push({
      location: "user-message",
      replacements: redactedMessage.replacements,
    });
  const userMessage = redactedMessage?.text.slice(
    0,
    budget.maxUserMessageCharacters,
  );

  return {
    sourceContext,
    screenshots,
    diagnostics,
    ...(userMessage ? { userMessage } : {}),
    governance: {
      budget,
      usage: {
        sourceBlocks: sourceContext.length,
        sourceCharacters,
        screenshotCount: screenshots.length,
        screenshotBytes,
        userMessageCharacters: userMessage?.length ?? 0,
      },
      approvedSourceIds,
      pendingSourceApprovals: [...pendingSourceApprovals].sort(),
      omissions,
      redactions,
      userMessageTruncated: Boolean(
        redactedMessage &&
        redactedMessage.text.length > budget.maxUserMessageCharacters,
      ),
    },
  };
};

const governanceDiagnostics = (
  governance: AIContextGovernance,
): PipelineDiagnostic[] => {
  const diagnostics: PipelineDiagnostic[] = [];
  if (governance.pendingSourceApprovals.length > 0)
    diagnostics.push({
      severity: "warning",
      code: "AI_CONTEXT_APPROVAL_REQUIRED",
      message: `Approval required for: ${governance.pendingSourceApprovals.join(", ")}`,
    });
  const budgetOmissions = governance.omissions.filter(
    (item) =>
      item.reason === "source-budget" ||
      item.reason === "screenshot-budget" ||
      item.reason === "diagnostic-budget",
  );
  if (budgetOmissions.length > 0)
    diagnostics.push({
      severity: "warning",
      code: "AI_CONTEXT_BUDGET_EXCEEDED",
      message: `${budgetOmissions.length} context items were omitted by the configured budget`,
    });
  const disallowed = governance.omissions.filter(
    (item) => item.reason === "not-allowed",
  );
  if (disallowed.length > 0)
    diagnostics.push({
      severity: "warning",
      code: "AI_CONTEXT_FILE_NOT_ALLOWED",
      message: `${disallowed.length} source blocks were outside the allowed file set`,
    });
  const redactionCount = governance.redactions.reduce(
    (total, item) => total + item.replacements,
    0,
  );
  if (redactionCount > 0)
    diagnostics.push({
      severity: "info",
      code: "AI_CONTEXT_REDACTED",
      message: `${redactionCount} sensitive values were redacted`,
    });
  return diagnostics;
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
      draft.annotations.length === 0 &&
      draft.screenshotIds.length === 0
    )
      throw new Error("Visual draft is empty");
    const view = this.document.defaultView;
    const location = view?.location;
    const sourceCandidates =
      input.sourceContext ?? this.sourceContextFromTargets(draft.targets);
    const additionalScreenshotIds = input.additionalScreenshotIds ?? [];
    if (additionalScreenshotIds.length > MAX_ADDITIONAL_SCREENSHOTS)
      throw new Error("AI context exceeds the additional screenshot limit");
    const allowedScreenshotIds = new Set([
      ...draft.screenshotIds,
      ...additionalScreenshotIds,
    ]);
    const screenshotCandidates = (input.screenshots ?? []).filter((asset) =>
      allowedScreenshotIds.has(asset.id),
    );
    const followUp = cloneFollowUpContext(input.followUp, draft);
    if (
      followUp &&
      !screenshotCandidates.some(
        (asset) => asset.id === followUp.resultScreenshotId,
      )
    )
      throw new Error(
        "Follow-up result screenshot is not available in the current context",
      );
    const constraints = { ...defaultConstraints, ...input.constraints };
    const selectedSourceIds = new Set(
      draft.targets.flatMap((target) =>
        target.source ? [target.source.sourceId] : [],
      ),
    );
    const governed = governAIContext(
      input,
      selectedSourceIds,
      sourceCandidates,
      screenshotCandidates,
      constraints,
    );
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
      screenshots: governed.screenshots,
      sourceContext: governed.sourceContext,
      ...(governed.diagnostics.length > 0
        ? { diagnostics: governed.diagnostics }
        : {}),
      ...(governed.userMessage ? { userMessage: governed.userMessage } : {}),
      ...(followUp ? { followUp } : {}),
      constraints,
      governance: governed.governance,
    };
    const governanceRecord = this.bridge.recordPipeline({
      taskId: request.id,
      stage: "context-bundle",
      source: "context-builder",
      kind: "ai.context.governance",
      summary: `Included ${request.sourceContext.length} source blocks and ${request.screenshots.length} screenshots; ${request.governance.omissions.length} omitted`,
      payload: request.governance,
      diagnostics: governanceDiagnostics(request.governance),
    });
    const contextRecord = this.bridge.recordPipeline({
      taskId: request.id,
      parentId: governanceRecord.id,
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
