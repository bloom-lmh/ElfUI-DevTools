import { describe, expect, it, vi } from "vitest";

import { createDevtoolsBridge } from "@elfui/devtools-runtime";
import type { VisualTarget } from "@elfui/devtools-shared";

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
        frameworkVersion: "0.1.0-beta.15",
        projectName: "demo",
      },
      screenshots: [beforeScreenshot],
      userMessage: "Make the visual draft real.",
    });

    expect(request).toMatchObject({
      schemaVersion: 1,
      id: "ai-change:80:1",
      conversationId: "conversation:1",
      project: { framework: "elfui", frameworkVersion: "0.1.0-beta.15" },
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
    });
    expect(request.screenshots[0]).not.toHaveProperty("dataUrl");
    const records = bridge.getPipelineState().records;
    const context = records.find(
      (record) => record.kind === "ai.context.bundle",
    );
    const aiRequest = records.find(
      (record) => record.kind === "ai.request.create",
    );
    expect(aiRequest?.parentId).toBe(context?.id);
  });
});
