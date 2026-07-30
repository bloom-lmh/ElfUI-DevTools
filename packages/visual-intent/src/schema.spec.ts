import { describe, expect, it } from "vitest";

import {
  DEVTOOLS_VISUAL_SCHEMA_VERSION,
  isScreenshotAsset,
  isVisualDraft,
  type VisualDraft,
} from "./index";

const draft: VisualDraft = {
  schemaVersion: DEVTOOLS_VISUAL_SCHEMA_VERSION,
  id: "visual-draft:1",
  targets: [
    {
      id: "visual-target:button",
      runtimeNodeId: "component:button",
      componentId: "component:card",
      inspector: {
        componentId: "component:card",
        domPath: "elf-card > button",
        element: { tag: "button", classes: ["primary"], text: "Save" },
        sourcePrecision: "template-node",
        source: { file: "src/Card.elf", line: 12, column: 5 },
        sourceId: "src/Card.elf",
        templateNodeId: "src/Card.elf:component:button:12:5",
      },
      geometry: { x: 16, y: 24, width: 120, height: 40 },
    },
  ],
  intents: [
    {
      id: "visual-intent:move-button",
      type: "move",
      targetId: "visual-target:button",
      before: { x: 16, y: 24, width: 120, height: 40 },
      desired: { x: 21, y: 24, width: 120, height: 40 },
      relations: [],
    },
  ],
  annotations: [
    {
      id: "annotation:comment",
      type: "comment",
      targetIds: ["visual-target:button"],
      text: "Move this five pixels right.",
      createdAt: 100,
    },
  ],
  screenshotIds: ["screenshot:before"],
};

describe("visual intent schema", () => {
  it("round-trips a provider-neutral draft without DOM references", () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(draft));
    expect(isVisualDraft(roundTripped)).toBe(true);
    expect(JSON.stringify(roundTripped)).not.toContain("HTML");
  });

  it("rejects unsupported versions and malformed intent geometry", () => {
    expect(isVisualDraft({ ...draft, schemaVersion: 2 })).toBe(false);
    expect(
      isVisualDraft({
        ...draft,
        intents: [{ ...draft.intents[0], desired: { x: 0 } }],
      }),
    ).toBe(false);
  });

  it("round-trips motion transitions and rejects malformed timing data", () => {
    const motionIntent = {
      id: "visual-intent:motion-button",
      type: "motion" as const,
      targetId: "visual-target:button",
      desired: {
        kind: "transition" as const,
        trigger: "hover" as const,
        properties: ["opacity", "transform"],
        durationMs: 240,
        delayMs: 40,
        easing: "ease-out",
        respectReducedMotion: true,
      },
    };
    const motionDraft = { ...draft, intents: [motionIntent] };
    expect(isVisualDraft(JSON.parse(JSON.stringify(motionDraft)))).toBe(true);

    for (const desired of [
      { ...motionIntent.desired, properties: [] },
      { ...motionIntent.desired, properties: ["opacity", "opacity"] },
      { ...motionIntent.desired, properties: ["Opacity"] },
      { ...motionIntent.desired, durationMs: -1 },
      { ...motionIntent.desired, delayMs: -1 },
      { ...motionIntent.desired, easing: " " },
      { ...motionIntent.desired, trigger: "scroll" },
    ])
      expect(
        isVisualDraft({
          ...motionDraft,
          intents: [{ ...motionIntent, desired }],
        }),
      ).toBe(false);
  });

  it("validates screenshot metadata without accepting raw bytes", () => {
    const asset = {
      id: "screenshot:before",
      kind: "viewport",
      phase: "before",
      mimeType: "image/png",
      width: 1280,
      height: 720,
      devicePixelRatio: 1,
      route: "/card",
      scroll: { x: 0, y: 0 },
      capturedAt: 100,
      excludedRegions: [],
      byteLength: 2048,
    };
    expect(isScreenshotAsset(asset)).toBe(true);
    expect(
      isScreenshotAsset({ ...asset, dataUrl: "data:image/png;base64,x" }),
    ).toBe(false);
    expect(isScreenshotAsset({ ...asset, byteLength: Number.NaN })).toBe(false);
  });
});
