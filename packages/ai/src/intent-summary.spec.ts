import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_CONTEXT_BUDGET,
  DEVTOOLS_AI_CHANGE_SCHEMA_VERSION,
  type AIChangeRequest,
  type RectSnapshot,
  type VisualAnnotation,
  type VisualIntent,
  type VisualTarget,
} from "@elfui/devtools-shared";

import { summarizeAIChangeRequest } from "./intent-summary";
import { DeterministicMockProvider } from "./mock-provider";

type FixtureCategory =
  | "style"
  | "move"
  | "resize"
  | "structure"
  | "motion"
  | "annotation";

interface FixtureTarget {
  id: string;
  tag: string;
  text?: string;
  sourceId: string;
  templateNodeId: string;
  geometry?: RectSnapshot;
}

interface UnderstandingFixture {
  id: string;
  category: FixtureCategory;
  target: FixtureTarget;
  relatedTargets?: FixtureTarget[];
  intent?: VisualIntent;
  annotation?: VisualAnnotation;
  expectedFacts: string[];
}

interface UnderstandingFixtureFile {
  schemaVersion: 1;
  cases: UnderstandingFixture[];
}

const fixtureFile = JSON.parse(
  readFileSync(
    resolve("fixtures/visual-intent-understanding/cases.json"),
    "utf8",
  ),
) as UnderstandingFixtureFile;

const createTarget = (fixture: FixtureTarget, index: number): VisualTarget => {
  const geometry = fixture.geometry ?? {
    x: 16 + index * 12,
    y: 24 + index * 8,
    width: 160,
    height: 40,
  };
  return {
    id: fixture.id,
    runtimeNodeId: `runtime:${fixture.templateNodeId}`,
    componentId: `component:${fixture.sourceId}`,
    inspector: {
      componentId: `component:${fixture.sourceId}`,
      domPath: `${fixture.tag}:nth-child(${index + 1})`,
      element: {
        tag: fixture.tag,
        classes: [],
        ...(fixture.text ? { text: fixture.text } : {}),
      },
      sourcePrecision: "template-node",
      source: { file: fixture.sourceId, line: 10 + index, column: 3 },
      sourceId: fixture.sourceId,
      templateNodeId: fixture.templateNodeId,
    },
    source: {
      sourceId: fixture.sourceId,
      component: `component:${fixture.sourceId}`,
      templateNodeId: fixture.templateNodeId,
      range: { file: fixture.sourceId, line: 10 + index, column: 3 },
    },
    geometry,
  };
};

const createRequest = (fixture: UnderstandingFixture): AIChangeRequest => {
  const targets = [fixture.target, ...(fixture.relatedTargets ?? [])].map(
    createTarget,
  );
  return {
    schemaVersion: DEVTOOLS_AI_CHANGE_SCHEMA_VERSION,
    id: `ai-change:${fixture.id}`,
    conversationId: `conversation:${fixture.id}`,
    project: { framework: "elfui", frameworkVersion: "0.1.0-beta.18" },
    page: {
      url: `http://localhost:4174/${fixture.id}`,
      route: `/${fixture.id}`,
      title: fixture.id,
      viewport: { width: 1280, height: 720 },
      devicePixelRatio: 1,
      scroll: { x: 0, y: 0 },
    },
    targets,
    intents: fixture.intent ? [fixture.intent] : [],
    annotations: fixture.annotation ? [fixture.annotation] : [],
    screenshots: [],
    sourceContext: targets.map((target, index) => ({
      id: `source:${fixture.id}:${index}`,
      sourceId: target.source!.sourceId,
      ...(target.source!.component
        ? { component: target.source!.component }
        : {}),
      ...(target.source!.templateNodeId
        ? { templateNodeId: target.source!.templateNodeId }
        : {}),
      ...(target.source!.range ? { range: target.source!.range } : {}),
    })),
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
        screenshotCount: 0,
        screenshotBytes: 0,
        userMessageCharacters: 0,
      },
      approvedSourceIds: [],
      pendingSourceApprovals: [],
      omissions: [],
      redactions: [],
      userMessageTruncated: false,
    },
  };
};

const providerText = async (request: AIChangeRequest): Promise<string> => {
  const provider = new DeterministicMockProvider({
    chunkSize: 4096,
    delayMs: 0,
  });
  let output = "";
  for await (const event of provider.stream(
    {
      executionId: `execution:${request.id}`,
      mode: "explain",
      changeRequest: request,
      settings: { modelId: "elfui-deterministic" },
      negotiation: {
        status: "supported",
        providerId: "elfui-mock",
        modelId: "elfui-deterministic",
        capabilities: provider.descriptor.capabilities,
        requirements: { required: ["text"], preferred: [] },
        missingRequired: [],
        downgraded: [],
        notices: [],
      },
    },
    { signal: new AbortController().signal },
  ))
    if (event.type === "text-delta") output += event.text;
  return output;
};

describe("visual intent understanding fixtures", () => {
  it("contains exactly 50 unique, intentionally distributed cases", () => {
    expect(fixtureFile.schemaVersion).toBe(1);
    expect(fixtureFile.cases).toHaveLength(50);
    expect(new Set(fixtureFile.cases.map((fixture) => fixture.id)).size).toBe(
      50,
    );
    const distribution = Object.fromEntries(
      [...new Set(fixtureFile.cases.map((fixture) => fixture.category))].map(
        (category) => [
          category,
          fixtureFile.cases.filter((fixture) => fixture.category === category)
            .length,
        ],
      ),
    );
    expect(distribution).toEqual({
      style: 10,
      move: 10,
      resize: 8,
      structure: 4,
      motion: 10,
      annotation: 8,
    });
  });

  it("repeats every target, intent, and source fact from structured context", async () => {
    for (const fixture of fixtureFile.cases) {
      const request = createRequest(fixture);
      expect(request.userMessage).toBeUndefined();
      expect(request.screenshots).toEqual([]);
      expect(
        request.sourceContext.every((source) => source.content === undefined),
      ).toBe(true);
      const summary = summarizeAIChangeRequest(request);
      const output = await providerText(request);
      for (const fact of fixture.expectedFacts) {
        expect(summary.text, `${fixture.id}: direct summary`).toContain(fact);
        expect(output, `${fixture.id}: provider output`).toContain(fact);
      }
    }
  });

  it("repeats stable unresolved references from a visual follow-up", async () => {
    const fixture = fixtureFile.cases.find((candidate) => candidate.intent)!;
    const request = createRequest(fixture);
    request.screenshots = [
      {
        id: "screenshot:result",
        kind: "viewport",
        phase: "result",
        mimeType: "image/png",
        width: 1280,
        height: 720,
        devicePixelRatio: 1,
        route: request.page.route,
        scroll: { x: 0, y: 0 },
        capturedAt: 1,
        excludedRegions: [],
        byteLength: 3,
      },
    ];
    request.followUp = {
      previousRequestId: "request:previous",
      proposalId: "proposal:previous",
      applicationId: "application:previous",
      verificationId: "verification:previous",
      reviewId: "review:previous",
      resultScreenshotId: "screenshot:result",
      references: [
        {
          kind: "visual-intent",
          id: fixture.intent!.id,
          status: "unmet",
        },
      ],
    };
    request.diagnostics = [
      {
        id: "diagnostic:visual-follow-up",
        severity: "warning",
        code: "ELF_VISUAL_FOLLOW_UP",
        message: "The reviewed visual intent is still unresolved.",
        sourceId: fixture.target.sourceId,
      },
    ];

    const summary = summarizeAIChangeRequest(request);
    const output = await providerText(request);

    for (const fact of [
      "上一轮结果核对",
      "previousRequestId=request:previous",
      `id=${fixture.intent!.id}`,
      "status=unmet",
      "resultScreenshotId=screenshot:result",
      "diagnostic diagnostic:visual-follow-up",
      "code=ELF_VISUAL_FOLLOW_UP",
    ]) {
      expect(summary.text).toContain(fact);
      expect(output).toContain(fact);
    }
  });
});
