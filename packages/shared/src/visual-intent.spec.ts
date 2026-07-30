import { describe, expect, it } from "vitest";

import {
  DEFAULT_AI_CONTEXT_BUDGET,
  DEVTOOLS_AI_CHANGE_SCHEMA_VERSION,
  DEVTOOLS_VISUAL_SCHEMA_VERSION,
  serialize,
  type AIChangeRequest,
  type VisualDraft,
} from "./index";

describe("Visual Intent protocol", () => {
  it("serializes target, move intent, and annotation without DOM references", () => {
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
          source: {
            sourceId: "src/Card.elf",
            component: "elf-card",
            templateNodeId: "src/Card.elf:component:button:12:5",
            range: { file: "src/Card.elf", line: 12, column: 5 },
          },
          geometry: { x: 16, y: 24, width: 120, height: 40 },
          computedStyle: { display: "block", marginLeft: "0px" },
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
          from: { x: 24, y: 84 },
          createdAt: 100,
        },
      ],
      screenshotIds: [],
    };

    const serialized = serialize(draft);
    expect(serialized.kind).toBe("object");
    if (serialized.kind !== "object") return;
    const entries = new Map(
      serialized.entries.map((entry) => [entry.key, entry.value]),
    );
    expect(entries.get("schemaVersion")).toEqual({
      kind: "primitive",
      value: 1,
    });
    expect(entries.get("intents")?.kind).toBe("array");
    expect(entries.get("annotations")?.kind).toBe("array");
    expect(JSON.stringify(serialized)).not.toContain("HTML");
  });

  it("keeps intent variants explicit and provider-neutral", () => {
    const styleIntent = {
      id: "intent:style",
      type: "style" as const,
      targetId: "target:card",
      before: { gap: "8px" },
      desired: { gap: "16px" },
    };
    const resizeIntent = {
      id: "intent:resize",
      type: "resize" as const,
      targetId: "target:card",
      before: { x: 0, y: 0, width: 200, height: 100 },
      desired: { x: 0, y: 0, width: 240, height: 100 },
    };
    const motionIntent = {
      id: "intent:motion",
      type: "motion" as const,
      targetId: "target:card",
      desired: {
        kind: "transition" as const,
        trigger: "hover" as const,
        properties: ["opacity", "transform"],
        durationMs: 240,
        delayMs: 20,
        easing: "ease-out",
        respectReducedMotion: true,
      },
    };
    expect(styleIntent.type).toBe("style");
    expect(resizeIntent.type).toBe("resize");
    expect(JSON.parse(JSON.stringify(motionIntent))).toEqual(motionIntent);
    expect(JSON.stringify(motionIntent)).not.toContain("CSSStyle");
  });

  it("round-trips a provider-neutral AI change request as JSON", () => {
    const request: AIChangeRequest = {
      schemaVersion: DEVTOOLS_AI_CHANGE_SCHEMA_VERSION,
      id: "ai-change:1",
      conversationId: "conversation:1",
      project: { framework: "elfui", frameworkVersion: "0.1.0-beta.18" },
      page: {
        url: "http://localhost:5173/card",
        route: "/card",
        title: "Card demo",
        viewport: { width: 1280, height: 720 },
        devicePixelRatio: 2,
        scroll: { x: 0, y: 100 },
      },
      targets: [],
      intents: [],
      annotations: [],
      screenshots: [
        {
          id: "screenshot:before",
          kind: "viewport",
          phase: "before",
          mimeType: "image/png",
          width: 2560,
          height: 1440,
          devicePixelRatio: 2,
          route: "/card",
          scroll: { x: 0, y: 100 },
          capturedAt: 100,
          excludedRegions: [],
          byteLength: 2048,
        },
      ],
      sourceContext: [],
      constraints: {
        preserveResponsiveLayout: true,
        preserveAccessibility: true,
        preservePublicAPI: true,
      },
      governance: {
        budget: DEFAULT_AI_CONTEXT_BUDGET,
        usage: {
          sourceBlocks: 0,
          sourceCharacters: 0,
          screenshotCount: 1,
          screenshotBytes: 2048,
          userMessageCharacters: 0,
        },
        approvedSourceIds: [],
        pendingSourceApprovals: [],
        omissions: [],
        redactions: [],
        userMessageTruncated: false,
      },
    };

    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(JSON.stringify(request)).not.toContain("openai");
    expect(JSON.stringify(request)).not.toContain("anthropic");
  });
});
