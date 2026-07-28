import { describe, expect, it } from "vitest";

import {
  DEVTOOLS_VISUAL_SCHEMA_VERSION,
  serialize,
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
    expect(styleIntent.type).toBe("style");
    expect(resizeIntent.type).toBe("resize");
  });
});
