import { describe, expect, it, vi } from "vitest";

import { createDevtoolsBridge } from "@elfui/devtools-runtime";
import type { AIChangeFollowUpContext } from "@elfui/devtools-shared";
import type {
  ScreenshotAsset,
  VisualTarget,
} from "@elfui/devtools-visual-intent";

import {
  AIContextBuilder,
  DisplayMediaScreenshotAdapter,
  ScreenshotController,
  type CapturedScreenshotAsset,
  type ScreenshotCaptureAdapter,
  projectScreenshotCapture,
} from "./context";
import { VisualIntentSession } from "./visual";

const target: VisualTarget = {
  id: "visual-target:save",
  runtimeNodeId: "src/Card.ts:component:button:8:3",
  componentId: "component:card",
  inspector: {
    componentId: "component:card",
    domPath: "elf-card > button",
    element: { tag: "button", classes: ["primary"], text: "Save" },
    sourcePrecision: "template-node",
    sourceId: "src/Card.ts",
    templateNodeId: "src/Card.ts:component:button:8:3",
    source: { file: "src/Card.ts", line: 8, column: 3 },
  },
  source: {
    sourceId: "src/Card.ts",
    component: "elf-card",
    templateNodeId: "src/Card.ts:component:button:8:3",
    range: { file: "src/Card.ts", line: 8, column: 3 },
  },
  geometry: { x: 20, y: 30, width: 120, height: 40 },
};

describe("ScreenshotController and AIContextBuilder", () => {
  it("projects viewport coordinates into captured pixels and masks exclusions", () => {
    expect(
      projectScreenshotCapture(
        { width: 800, height: 600 },
        { width: 1600, height: 1200 },
        {
          kind: "selection",
          selection: { x: 100, y: 50, width: 200, height: 100 },
          excludedRegions: [{ x: 150, y: 75, width: 50, height: 25 }],
        },
      ),
    ).toEqual({
      clip: { x: 100, y: 50, width: 200, height: 100 },
      source: { x: 200, y: 100, width: 400, height: 200 },
      output: { width: 400, height: 200 },
      masks: [{ x: 100, y: 50, width: 100, height: 50 }],
      scaleX: 2,
      scaleY: 2,
    });
    expect(() =>
      projectScreenshotCapture(
        { width: 800, height: 600 },
        { width: 1600, height: 1200 },
        { kind: "selection", excludedRegions: [] },
      ),
    ).toThrow("Selection screenshots require a selection rectangle");
  });

  it("captures the current tab, crops a selection, masks sensitive regions, and stops sharing", async () => {
    const stop = vi.fn();
    const track = {
      getSettings: () => ({ displaySurface: "browser" }),
      stop,
    };
    const stream = {
      getVideoTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    const play = vi.fn().mockResolvedValue(undefined);
    const video = {
      muted: false,
      playsInline: false,
      srcObject: null,
      videoWidth: 2048,
      videoHeight: 1536,
      play,
      addEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage, fillRect, fillStyle: "" }),
      toDataURL: () => "data:image/png;base64,AAAA",
    } as unknown as HTMLCanvasElement;
    const adapter = new DisplayMediaScreenshotAdapter({
      document,
      getDisplayMedia,
      createVideo: () => video,
      createCanvas: () => canvas,
    });

    const result = await adapter.capture({
      kind: "selection",
      selection: { x: 100, y: 50, width: 200, height: 100 },
      excludedRegions: [{ x: 150, y: 75, width: 50, height: 25 }],
    });

    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { displaySurface: "browser" },
      audio: false,
    });
    expect(drawImage).toHaveBeenCalledWith(
      video,
      200,
      100,
      400,
      200,
      0,
      0,
      400,
      200,
    );
    expect(fillRect).toHaveBeenCalledWith(100, 50, 100, 50);
    expect(result).toEqual({
      dataUrl: "data:image/png;base64,AAAA",
      mimeType: "image/png",
      width: 400,
      height: 200,
      devicePixelRatio: 2,
    });
    expect(play).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });

  it("stores screenshot bytes separately and exposes capture metadata in Pipeline", async () => {
    const bridge = createDevtoolsBridge({ now: () => 40 });
    const visual = new VisualIntentSession(bridge, {
      draftId: "visual-draft:test",
    });
    const capture = vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,AAAA",
      mimeType: "image/png",
      width: 800,
      height: 600,
    });
    const screenshots = new ScreenshotController(
      bridge,
      visual,
      { capture } satisfies ScreenshotCaptureAdapter,
      { document, now: () => 50 },
    );
    const asset = await screenshots.capture("before", "selection", {
      selection: { x: 10, y: 20, width: 200, height: 100 },
      excludedRegions: [{ x: 40, y: 50, width: 30, height: 20 }],
    });

    expect(capture).toHaveBeenCalledWith({
      kind: "selection",
      selection: { x: 10, y: 20, width: 200, height: 100 },
      excludedRegions: [{ x: 40, y: 50, width: 30, height: 20 }],
    });
    expect(asset).toMatchObject({
      id: "screenshot:50:1",
      kind: "selection",
      phase: "before",
      width: 800,
      height: 600,
      byteLength: 3,
      dataUrl: "data:image/png;base64,AAAA",
    });
    expect(visual.getDraft().screenshotIds).toEqual([asset.id]);
    const screenshotRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "visual.screenshot.capture");
    expect(JSON.stringify(screenshotRecord?.payload)).not.toContain(
      "data:image/png",
    );
  });

  it("captures a detached result screenshot without changing the desired visual draft", async () => {
    const bridge = createDevtoolsBridge({ now: () => 55 });
    const visual = new VisualIntentSession(bridge, {
      draftId: "visual-draft:result",
    });
    const screenshots = new ScreenshotController(
      bridge,
      visual,
      {
        capture: vi.fn().mockResolvedValue({
          dataUrl: "data:image/png;base64,AAAA",
          mimeType: "image/png",
          width: 390,
          height: 844,
        }),
      },
      { document, now: () => 60 },
    );

    const asset = await screenshots.capture("result", "viewport", {
      attachToDraft: false,
    });

    expect(asset.phase).toBe("result");
    expect(visual.getDraft().screenshotIds).toEqual([]);
    const record = bridge
      .getPipelineState()
      .records.find((item) => item.kind === "visual.screenshot.capture");
    expect(JSON.stringify(record?.payload)).toContain(
      '"key":"attachedToDraft","value":{"kind":"primitive","value":false}',
    );
  });

  it("freezes a provider-neutral AI change request from the visual draft", () => {
    const bridge = createDevtoolsBridge({ now: () => 75 });
    const visual = new VisualIntentSession(bridge, {
      draftId: "visual-draft:request",
    });
    visual.captureTarget(target);
    visual.previewMove(target.id, {
      x: 25,
      y: 30,
      width: 120,
      height: 40,
    });
    visual.attachScreenshot("screenshot:before");
    const builder = new AIContextBuilder(bridge, visual, {
      document,
      now: () => 80,
    });
    const beforeScreenshot: CapturedScreenshotAsset = {
      id: "screenshot:before",
      kind: "viewport",
      phase: "before",
      mimeType: "image/png",
      width: 800,
      height: 600,
      devicePixelRatio: 1,
      route: "/card",
      scroll: { x: 0, y: 0 },
      capturedAt: 70,
      excludedRegions: [],
      byteLength: 3,
      dataUrl: "data:image/png;base64,AAAA",
    };
    const request = builder.build({
      conversationId: "conversation:1",
      project: {
        framework: "elfui",
        frameworkVersion: "0.1.0-beta.18",
        projectName: "demo",
      },
      screenshots: [beforeScreenshot],
      userMessage: "Make the visual draft real.",
    });

    expect(request).toMatchObject({
      schemaVersion: 1,
      id: "ai-change:80:1",
      conversationId: "conversation:1",
      project: { framework: "elfui", frameworkVersion: "0.1.0-beta.18" },
      targets: [{ id: target.id }],
      intents: [{ type: "move", targetId: target.id }],
      screenshots: [{ id: "screenshot:before", byteLength: 3 }],
      sourceContext: [
        {
          sourceId: "src/Card.ts",
          component: "elf-card",
          templateNodeId: "src/Card.ts:component:button:8:3",
        },
      ],
      constraints: {
        preserveResponsiveLayout: true,
        preserveAccessibility: true,
        preservePublicAPI: true,
      },
      governance: {
        usage: {
          sourceBlocks: 1,
          screenshotCount: 1,
          screenshotBytes: 3,
        },
        pendingSourceApprovals: [],
        omissions: [],
        redactions: [],
      },
    });
    expect(request.screenshots[0]).not.toHaveProperty("dataUrl");
    const records = bridge.getPipelineState().records;
    const context = records.find(
      (record) => record.kind === "ai.context.bundle",
    );
    const aiRequest = records.find(
      (record) => record.kind === "ai.request.create",
    );
    const governance = records.find(
      (record) => record.kind === "ai.context.governance",
    );
    expect(context?.parentId).toBe(governance?.id);
    expect(aiRequest?.parentId).toBe(context?.id);
  });

  it("includes a detached result screenshot and stable unresolved references in a follow-up request", () => {
    const bridge = createDevtoolsBridge({ now: () => 82 });
    const visual = new VisualIntentSession(bridge, {
      draftId: "visual-draft:follow-up",
    });
    visual.captureTarget(target);
    visual.previewMove(target.id, {
      x: 25,
      y: 30,
      width: 120,
      height: 40,
    });
    visual.attachScreenshot("screenshot:desired");
    const intentId = visual.getDraft().intents[0]!.id;
    const screenshot = (
      id: string,
      phase: ScreenshotAsset["phase"],
    ): ScreenshotAsset => ({
      id,
      kind: "viewport",
      phase,
      mimeType: "image/png",
      width: 800,
      height: 600,
      devicePixelRatio: 1,
      route: "/card",
      scroll: { x: 0, y: 0 },
      capturedAt: 80,
      excludedRegions: [],
      byteLength: 3,
    });
    const followUp: AIChangeFollowUpContext = {
      previousRequestId: "request:previous",
      proposalId: "proposal:previous",
      applicationId: "application:previous",
      verificationId: "verification:previous",
      reviewId: "visual-result-review:previous",
      resultScreenshotId: "screenshot:result",
      references: [{ kind: "visual-intent", id: intentId, status: "unmet" }],
    };
    const builder = new AIContextBuilder(bridge, visual, {
      document,
      now: () => 85,
    });

    const request = builder.build({
      conversationId: "conversation:follow-up",
      screenshots: [
        screenshot("screenshot:desired", "desired"),
        screenshot("screenshot:result", "result"),
      ],
      additionalScreenshotIds: ["screenshot:result"],
      followUp,
    });

    expect(request.followUp).toEqual(followUp);
    expect(request.screenshots.map((asset) => asset.phase)).toEqual([
      "desired",
      "result",
    ]);
    expect(request.governance.usage.screenshotCount).toBe(2);
    followUp.references[0]!.status = "partial";
    expect(request.followUp?.references[0]?.status).toBe("unmet");
    expect(() =>
      builder.build({
        conversationId: "conversation:invalid-follow-up",
        screenshots: [screenshot("screenshot:result", "result")],
        additionalScreenshotIds: ["screenshot:result"],
        followUp: {
          ...followUp,
          references: [
            {
              kind: "annotation",
              id: "annotation:foreign",
              status: "unmet",
            },
          ],
        },
      }),
    ).toThrow("Follow-up reference is not part of the current visual draft");
  });

  it("budgets, redacts, and requires approval for expanded AI context", () => {
    const bridge = createDevtoolsBridge({ now: () => 100 });
    const visual = new VisualIntentSession(bridge, {
      draftId: "visual-draft:governed",
    });
    visual.captureTarget(target);
    visual.attachScreenshot("screenshot:first");
    visual.attachScreenshot("screenshot:second");
    const builder = new AIContextBuilder(bridge, visual, {
      document,
      now: () => 110,
    });
    const screenshot = (id: string): ScreenshotAsset => ({
      id,
      kind: "viewport",
      phase: "before",
      mimeType: "image/png",
      width: 800,
      height: 600,
      devicePixelRatio: 1,
      route: "/card",
      scroll: { x: 0, y: 0 },
      capturedAt: 90,
      excludedRegions: [],
      byteLength: 3,
    });

    const request = builder.build({
      conversationId: "conversation:governed",
      screenshots: [
        screenshot("screenshot:first"),
        screenshot("screenshot:second"),
      ],
      sourceContext: [
        {
          id: "source:selected",
          sourceId: "src/Card.ts",
          content: 'const apiKey = "secret-value";\nexport const Card = true;',
        },
        {
          id: "source:approved",
          sourceId: "src/theme.ts",
          content: "export const menuGap = 8;",
        },
        {
          id: "source:pending",
          sourceId: "src/admin.ts",
          content: "export const adminOnly = true;",
        },
      ],
      approvedSourceIds: ["src/theme.ts"],
      userMessage:
        "Bearer abcdefghijklmnop move the selected button below the menu.",
      budget: {
        maxSourceBlocks: 2,
        maxSourceCharacters: 200,
        maxScreenshotBytes: 3,
        maxUserMessageCharacters: 24,
      },
    });

    expect(request.sourceContext.map((block) => block.sourceId)).toEqual([
      "src/Card.ts",
      "src/theme.ts",
    ]);
    expect(request.screenshots.map((asset) => asset.id)).toEqual([
      "screenshot:first",
    ]);
    expect(request.governance).toMatchObject({
      usage: {
        sourceBlocks: 2,
        screenshotCount: 1,
        screenshotBytes: 3,
        userMessageCharacters: 24,
      },
      approvedSourceIds: ["src/theme.ts"],
      pendingSourceApprovals: ["src/admin.ts"],
      omissions: [
        {
          kind: "source",
          id: "source:pending",
          reason: "approval-required",
        },
        {
          kind: "screenshot",
          id: "screenshot:second",
          reason: "screenshot-budget",
        },
      ],
      userMessageTruncated: true,
    });
    expect(request.governance.redactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ location: "source", id: "source:selected" }),
        expect.objectContaining({ location: "user-message" }),
      ]),
    );
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain("adminOnly");
    const governanceRecord = bridge
      .getPipelineState()
      .records.find((record) => record.kind === "ai.context.governance");
    expect(governanceRecord?.diagnostics.map((item) => item.code)).toEqual([
      "AI_CONTEXT_APPROVAL_REQUIRED",
      "AI_CONTEXT_BUDGET_EXCEEDED",
      "AI_CONTEXT_REDACTED",
    ]);
    expect(JSON.stringify(governanceRecord?.payload)).not.toContain(
      "secret-value",
    );
  });

  it("redacts bounded diagnostic context and excludes diagnostics outside the approved source scope", () => {
    const bridge = createDevtoolsBridge({ now: () => 120 });
    const visual = new VisualIntentSession(bridge, {
      draftId: "visual-draft:diagnostics",
    });
    visual.captureTarget(target);
    const builder = new AIContextBuilder(bridge, visual, {
      document,
      now: () => 130,
    });

    const request = builder.build({
      conversationId: "conversation:diagnostics",
      diagnostics: [
        {
          id: "diagnostic:card",
          severity: "warning",
          code: "ELF_CARD_HINT",
          message: "Bearer abcdefghijklmnop is not a valid visual token.",
          sourceId: "src/Card.ts",
          source: { file: "src/Card.ts", line: 8, column: 3 },
        },
        {
          id: "diagnostic:foreign",
          severity: "error",
          code: "ELF_FOREIGN",
          message: "Outside the selected visual source.",
          sourceId: "src/Foreign.ts",
        },
      ],
    });

    expect(request.diagnostics).toEqual([
      expect.objectContaining({
        id: "diagnostic:card",
        sourceId: "src/Card.ts",
      }),
    ]);
    expect(request.diagnostics?.[0]?.message).not.toContain("abcdefghijklmnop");
    expect(request.governance.redactions).toContainEqual(
      expect.objectContaining({
        location: "diagnostic",
        id: "diagnostic:card",
      }),
    );
    expect(request.governance.omissions).toContainEqual({
      kind: "diagnostic",
      id: "diagnostic:foreign",
      reason: "not-allowed",
    });
    expect(
      JSON.stringify(
        bridge
          .getPipelineState()
          .records.find((record) => record.kind === "ai.context.bundle")
          ?.payload,
      ),
    ).not.toContain("abcdefghijklmnop");
  });
});
