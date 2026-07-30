// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  DEVTOOLS_AI_EXECUTION_CANCEL_ENDPOINT,
  DEVTOOLS_AI_EXECUTION_ENDPOINT,
  DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  DEVTOOLS_AI_PATCH_PROPOSAL_CATALOG_ENDPOINT,
  DEVTOOLS_AI_PATCH_PROPOSAL_DECISION_ENDPOINT,
  DEVTOOLS_AI_PATCH_ROLLBACK_ENDPOINT,
  DEVTOOLS_AI_PROVIDER_CATALOG_ENDPOINT,
  DEVTOOLS_AI_SCREENSHOT_UPLOAD_ENDPOINT,
  AIProviderRegistry,
  type AIExecutionStartRequest,
  type AIProvider,
} from "@elfui/devtools-ai";
import type {
  AIChangeRequest,
  CompilerStateSnapshot,
} from "@elfui/devtools-shared";
import { describe, expect, it, vi } from "vitest";

import {
  assembleReadonlyProviderRequest,
  createAIGatewayMiddleware,
} from "./ai-gateway";

const providerDescriptor = (id: string) => ({
  id,
  label: id,
  capabilities: {
    text: true,
    imageInput: false,
    toolCalling: false,
    structuredOutput: false,
    reasoning: false,
    temperature: false,
  },
  models: [{ id: `${id}-default`, label: "Default" }],
  defaultModelId: `${id}-default`,
});

const createChangeRequest = (): AIChangeRequest => ({
  schemaVersion: 1,
  id: "request:test",
  conversationId: "conversation:test",
  project: { framework: "elfui" },
  page: {
    url: "http://localhost/",
    route: "/",
    title: "Fixture",
    viewport: { width: 1280, height: 720 },
    devicePixelRatio: 1,
    scroll: { x: 0, y: 0 },
  },
  targets: [],
  intents: [],
  annotations: [],
  screenshots: [],
  sourceContext: [{ id: "source:test", sourceId: "src/Test.ts" }],
  userMessage: "Explain this target",
  constraints: {
    preserveResponsiveLayout: true,
    preserveAccessibility: true,
    preservePublicAPI: true,
  },
  governance: {
    budget: {
      maxSourceBlocks: 12,
      maxSourceCharacters: 32_000,
      maxScreenshotBytes: 8_000_000,
      maxUserMessageCharacters: 4_000,
    },
    usage: {
      sourceBlocks: 0,
      sourceCharacters: 0,
      screenshotCount: 0,
      screenshotBytes: 0,
      userMessageCharacters: 19,
    },
    approvedSourceIds: ["src/Test.ts"],
    pendingSourceApprovals: [],
    omissions: [],
    redactions: [],
    userMessageTruncated: false,
  },
});

const createStartRequest = (): AIExecutionStartRequest => ({
  schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
  executionId: "execution:test",
  conversationId: "conversation:test",
  assistantMessageId: "message:test",
  mode: "explain",
  changeRequest: createChangeRequest(),
});

const invokeMiddleware = (
  middleware: ReturnType<typeof createAIGatewayMiddleware>,
  path: string,
  body: unknown,
  method = "POST",
) => {
  const request = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  request.url = path;
  request.method = method;
  request.headers = { "x-elfui-devtools-token": "test-capability" };
  const chunks: string[] = [];
  const setHeader = vi.fn();
  let statusCode = 200;
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const response = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    setHeader,
    write: (value: unknown) => {
      chunks.push(String(value));
      return true;
    },
    end: (value = "") => {
      if (value) chunks.push(String(value));
      resolveCompleted();
    },
  } as unknown as ServerResponse;
  const next = vi.fn();
  middleware(request, response, next);
  return {
    chunks,
    completed,
    next,
    setHeader,
    get statusCode() {
      return statusCode;
    },
  };
};

describe("Node readonly AI gateway", () => {
  it("rejects follow-up references outside the current visual draft", async () => {
    const stream = vi.fn(async function* () {
      yield { type: "completed" as const };
    });
    const middleware = createAIGatewayMiddleware(
      process.cwd(),
      () => ({ protocolVersion: 2, revision: 0, artifacts: [] }),
      "test-capability",
      {
        descriptor: providerDescriptor("test-provider"),
        stream,
      },
    );
    const input = createStartRequest();
    input.changeRequest.screenshots = [
      {
        id: "screenshot:result",
        kind: "viewport",
        phase: "result",
        mimeType: "image/png",
        width: 390,
        height: 844,
        devicePixelRatio: 1,
        route: "/",
        scroll: { x: 0, y: 0 },
        capturedAt: 1,
        excludedRegions: [],
        byteLength: 3,
      },
    ];
    input.changeRequest.followUp = {
      previousRequestId: "request:previous",
      proposalId: "proposal:previous",
      applicationId: "application:previous",
      verificationId: "verification:previous",
      reviewId: "review:previous",
      resultScreenshotId: "screenshot:result",
      references: [
        {
          kind: "visual-intent",
          id: "intent:foreign",
          status: "unmet",
        },
      ],
    };

    const response = invokeMiddleware(
      middleware,
      DEVTOOLS_AI_EXECUTION_ENDPOINT,
      input,
    );
    await response.completed;

    expect(response.statusCode).toBe(400);
    expect(stream).not.toHaveBeenCalled();
  });

  it("assembles source in Node, redacts it, and streams audited events", async () => {
    const root = await mkdtemp(join(process.cwd(), ".elfui-ai-gateway-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "src", "Test.ts"),
        'const apiKey = "secret-value";\nexport const test = true;',
      );
      const snapshot: CompilerStateSnapshot = {
        protocolVersion: 2,
        revision: 1,
        artifacts: [
          {
            revision: 1,
            capturedAt: 1,
            id: join(root, "src", "Test.ts"),
            sourceId: "src/Test.ts",
            kind: "metadata",
            payload: {},
          },
        ],
      };
      const received: AIChangeRequest[] = [];
      const provider: AIProvider = {
        descriptor: providerDescriptor("test-provider"),
        async *stream(request) {
          received.push(request.changeRequest);
          yield { type: "text-delta", text: "Audited result" };
          yield { type: "completed" };
        },
      };
      const middleware = createAIGatewayMiddleware(
        root,
        () => snapshot,
        "test-capability",
        provider,
        () => 50,
      );
      const response = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_EXECUTION_ENDPOINT,
        createStartRequest(),
      );
      await response.completed;

      expect(response.statusCode).toBe(200);
      expect(response.setHeader).toHaveBeenCalledWith(
        "content-type",
        "application/x-ndjson; charset=utf-8",
      );
      const events = response.chunks
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "text-delta",
        "completed",
      ]);
      expect(events[0]).toMatchObject({
        providerId: "test-provider",
        context: { sourceBlocks: 1, redactions: 1 },
      });
      expect(received[0]?.sourceContext[0]?.content).toContain("[REDACTED]");
      expect(JSON.stringify(events)).not.toContain("secret-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives bounded reply references only from exact entities in the assembled request", async () => {
    const root = await mkdtemp(join(process.cwd(), ".elfui-ai-references-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "src", "Test.ts"),
        "export const test = true;",
      );
      const input = createStartRequest();
      input.changeRequest.intents = [
        {
          id: "visual-intent:reply",
          type: "remove",
          targetId: "visual-target:reply",
        },
      ];
      input.changeRequest.annotations = [
        {
          id: "annotation:reply",
          type: "comment",
          targetIds: ["visual-target:reply"],
          text: "Keep this note attached.",
          createdAt: 1,
        },
      ];
      input.changeRequest.diagnostics = [
        {
          id: "diagnostic:reply",
          severity: "warning",
          code: "ELF_REPLY_HINT",
          message: "Bearer abcdefghijklmnop must be redacted.",
          sourceId: "src/Test.ts",
          source: { file: "src/Test.ts", line: 1, column: 1 },
        },
      ];
      const received: AIChangeRequest[] = [];
      const provider: AIProvider = {
        descriptor: providerDescriptor("reference-provider"),
        async *stream(request) {
          received.push(request.changeRequest);
          yield {
            type: "text-delta",
            text:
              "Address visual-intent:reply and annotation:reply in src/Test.ts; " +
              "see diagnostic:reply, not diagnostic:foreign.",
          };
          yield { type: "completed" };
        },
      };
      const middleware = createAIGatewayMiddleware(
        root,
        () => ({
          protocolVersion: 2,
          revision: 1,
          artifacts: [
            {
              revision: 1,
              capturedAt: 1,
              id: join(root, "src", "Test.ts"),
              sourceId: "src/Test.ts",
              kind: "metadata",
              payload: {},
            },
          ],
        }),
        "test-capability",
        provider,
        () => 60,
      );

      const response = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_EXECUTION_ENDPOINT,
        input,
      );
      await response.completed;

      const events = response.chunks
        .join("")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              reference?: { kind: string; id: string; label?: string };
            },
        );
      expect(
        events
          .filter((event) => event.type === "reference")
          .map((event) => [
            event.reference?.kind,
            event.reference?.id,
            event.reference?.label,
          ]),
      ).toEqual([
        ["visual-intent", "visual-intent:reply", "remove intent"],
        ["annotation", "annotation:reply", "comment annotation"],
        ["file", "src/Test.ts", "src/Test.ts"],
        ["diagnostic", "diagnostic:reply", "warning · ELF_REPLY_HINT"],
      ]);
      expect(received[0]?.diagnostics?.[0]?.message).not.toContain(
        "abcdefghijklmnop",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels an active stream and emits a terminal cancelled event", async () => {
    const root = await mkdtemp(join(process.cwd(), ".elfui-ai-cancel-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "src", "Test.ts"),
        "export const test = true;",
      );
      const snapshot: CompilerStateSnapshot = {
        protocolVersion: 2,
        revision: 1,
        artifacts: [
          {
            revision: 1,
            capturedAt: 1,
            id: join(root, "src", "Test.ts"),
            sourceId: "src/Test.ts",
            kind: "metadata",
            payload: {},
          },
        ],
      };
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const provider: AIProvider = {
        descriptor: providerDescriptor("slow-provider"),
        async *stream(_request, { signal }) {
          notifyStarted();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                const error = new Error("cancelled");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
          yield { type: "completed" };
        },
      };
      const middleware = createAIGatewayMiddleware(
        root,
        () => snapshot,
        "test-capability",
        provider,
      );
      const streaming = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_EXECUTION_ENDPOINT,
        createStartRequest(),
      );
      await started;
      const cancellation = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_EXECUTION_CANCEL_ENDPOINT,
        { executionId: "execution:test" },
      );
      await cancellation.completed;
      await streaming.completed;

      expect(cancellation.statusCode).toBe(202);
      expect(streaming.chunks.join("")).toContain('"type":"cancelled"');
      expect(streaming.chunks.join("")).not.toContain('"type":"completed"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("converts provider failures and accepts a matching terminal retry", async () => {
    const root = await mkdtemp(join(process.cwd(), ".elfui-ai-retry-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "src", "Test.ts"),
        "export const test = true;",
      );
      const snapshot: CompilerStateSnapshot = {
        protocolVersion: 2,
        revision: 1,
        artifacts: [
          {
            revision: 1,
            capturedAt: 1,
            id: join(root, "src", "Test.ts"),
            sourceId: "src/Test.ts",
            kind: "metadata",
            payload: {},
          },
        ],
      };
      let attempt = 0;
      const provider: AIProvider = {
        descriptor: providerDescriptor("retry-provider"),
        async *stream() {
          attempt += 1;
          if (attempt === 1) throw new Error("temporary provider failure");
          yield { type: "text-delta", text: "Recovered" };
          yield { type: "completed" };
        },
      };
      const middleware = createAIGatewayMiddleware(
        root,
        () => snapshot,
        "test-capability",
        provider,
      );
      const first = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_EXECUTION_ENDPOINT,
        createStartRequest(),
      );
      await first.completed;
      expect(first.chunks.join("")).toContain('"type":"failed"');

      const retry = createStartRequest();
      retry.executionId = "execution:retry";
      retry.assistantMessageId = "message:retry";
      retry.retryOfExecutionId = "execution:test";
      const second = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_EXECUTION_ENDPOINT,
        retry,
      );
      await second.completed;

      expect(second.statusCode).toBe(200);
      expect(second.chunks.join("")).toContain('"text":"Recovered"');
      expect(second.chunks.join("")).toContain('"type":"completed"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects browser-provided source content before provider assembly", () => {
    const input = createStartRequest();
    input.changeRequest.sourceContext[0]!.content = "untrusted source";
    expect(() =>
      assembleReadonlyProviderRequest(input, () => {
        throw new Error("source reader must not run");
      }),
    ).toThrow("must not contain source content");
  });

  it("selects a registered provider and forwards only validated public settings", async () => {
    const received: unknown[] = [];
    const first: AIProvider = {
      descriptor: providerDescriptor("first"),
      async *stream() {
        yield { type: "completed" };
      },
    };
    const second: AIProvider = {
      descriptor: {
        ...providerDescriptor("second"),
        capabilities: {
          ...providerDescriptor("second").capabilities,
          reasoning: true,
          temperature: true,
        },
        allowsEndpointOverride: true,
      },
      async *stream(request) {
        received.push(request);
        yield { type: "completed" };
      },
    };
    const middleware = createAIGatewayMiddleware(
      process.cwd(),
      () => ({ protocolVersion: 2, revision: 0, artifacts: [] }),
      "test-capability",
      new AIProviderRegistry([first, second]),
      () => 75,
    );
    const input = createStartRequest();
    input.changeRequest.sourceContext = [];
    input.changeRequest.governance.approvedSourceIds = [];
    input.provider = {
      providerId: "second",
      settings: {
        temperature: 0.25,
        reasoning: "low",
        maxOutputTokens: 4_096,
        endpoint: "https://example.test/v1/responses",
      },
    };
    const response = invokeMiddleware(
      middleware,
      DEVTOOLS_AI_EXECUTION_ENDPOINT,
      input,
    );
    await response.completed;

    const output = response.chunks.join("");
    expect(output).toContain('"providerId":"second"');
    expect(output).toContain('"modelId":"second-default"');
    expect(received).toEqual([
      expect.objectContaining({
        settings: {
          modelId: "second-default",
          temperature: 0.25,
          reasoning: "low",
          maxOutputTokens: 4_096,
          endpoint: "https://example.test/v1/responses",
        },
        changeRequest: expect.objectContaining({ id: "request:test" }),
      }),
    ]);
  });

  it("reports an explicit vision downgrade without changing the request", async () => {
    let receivedRequest: AIChangeRequest | undefined;
    const provider: AIProvider = {
      descriptor: providerDescriptor("text-only"),
      async *stream(request) {
        receivedRequest = request.changeRequest;
        yield { type: "completed" };
      },
    };
    const middleware = createAIGatewayMiddleware(
      process.cwd(),
      () => ({ protocolVersion: 2, revision: 0, artifacts: [] }),
      "test-capability",
      provider,
    );
    const input = createStartRequest();
    input.changeRequest.sourceContext = [];
    input.changeRequest.governance.approvedSourceIds = [];
    input.changeRequest.screenshots = [
      {
        id: "screenshot:desired",
        kind: "viewport",
        phase: "desired",
        mimeType: "image/png",
        width: 1280,
        height: 720,
        devicePixelRatio: 1,
        route: "/",
        scroll: { x: 0, y: 0 },
        capturedAt: 1,
        excludedRegions: [],
        byteLength: 1_024,
      },
    ];
    const before = JSON.stringify(input.changeRequest);
    const response = invokeMiddleware(
      middleware,
      DEVTOOLS_AI_EXECUTION_ENDPOINT,
      input,
    );
    await response.completed;

    const output = response.chunks.join("");
    expect(output).toContain('"status":"downgraded"');
    expect(output).toContain('"capability":"image-input"');
    expect(JSON.stringify(receivedRequest)).toBe(before);
  });

  it("rejects secret-bearing selection fields before calling a provider", async () => {
    const stream = vi.fn();
    const provider: AIProvider = {
      descriptor: providerDescriptor("safe-provider"),
      stream,
    };
    const middleware = createAIGatewayMiddleware(
      process.cwd(),
      () => ({ protocolVersion: 2, revision: 0, artifacts: [] }),
      "test-capability",
      provider,
    );
    const input = {
      ...createStartRequest(),
      provider: {
        providerId: "safe-provider",
        settings: { apiKey: "secret-value" },
      },
    };
    const response = invokeMiddleware(
      middleware,
      DEVTOOLS_AI_EXECUTION_ENDPOINT,
      input,
    );
    await response.completed;

    expect(response.statusCode).toBe(400);
    expect(response.chunks.join("")).toBe("Invalid AI execution request");
    expect(stream).not.toHaveBeenCalled();
  });

  it("redacts credentials from provider failure messages", async () => {
    const provider: AIProvider = {
      descriptor: providerDescriptor("failing-provider"),
      async *stream() {
        await Promise.reject(
          new Error("Authorization: Bearer provider-secret-value"),
        );
        yield { type: "completed" };
      },
    };
    const middleware = createAIGatewayMiddleware(
      process.cwd(),
      () => ({ protocolVersion: 2, revision: 0, artifacts: [] }),
      "test-capability",
      provider,
    );
    const input = createStartRequest();
    input.changeRequest.sourceContext = [];
    input.changeRequest.governance.approvedSourceIds = [];
    const response = invokeMiddleware(
      middleware,
      DEVTOOLS_AI_EXECUTION_ENDPOINT,
      input,
    );
    await response.completed;

    expect(response.chunks.join("")).toContain("[REDACTED]");
    expect(response.chunks.join("")).not.toContain("provider-secret-value");
  });

  it("returns a sanitized provider catalog without reading a body", async () => {
    const provider: AIProvider = {
      descriptor: providerDescriptor("catalog-provider"),
      async *stream() {
        yield { type: "completed" };
      },
    };
    Object.assign(provider.descriptor, { apiKey: "node-only-secret" });
    const middleware = createAIGatewayMiddleware(
      process.cwd(),
      () => ({ protocolVersion: 2, revision: 0, artifacts: [] }),
      "test-capability",
      provider,
    );
    const response = invokeMiddleware(
      middleware,
      DEVTOOLS_AI_PROVIDER_CATALOG_ENDPOINT,
      {},
      "GET",
    );
    await response.completed;

    expect(response.statusCode).toBe(200);
    expect(response.chunks.join("")).toContain(
      '"defaultProviderId":"catalog-provider"',
    );
    expect(response.chunks.join("")).not.toContain("node-only-secret");
    expect(response.setHeader).toHaveBeenCalledWith(
      "cache-control",
      "no-store",
    );
  });

  it("forwards structured output and a bounded empty-scope tool result", async () => {
    const provider: AIProvider = {
      descriptor: {
        ...providerDescriptor("event-provider"),
        capabilities: {
          ...providerDescriptor("event-provider").capabilities,
          toolCalling: true,
          structuredOutput: true,
        },
      },
      async *stream(request) {
        if (request.agent?.turn === 0) {
          yield {
            type: "tool-call",
            call: {
              id: "call:test",
              name: "project.search",
              arguments: '{"query":"target"}',
            },
          };
          yield {
            type: "structured-output",
            value: {
              summary: "Read-only plan",
              affectedFiles: ["src/Test.ts"],
            },
          };
        }
        yield { type: "completed" };
      },
    };
    const middleware = createAIGatewayMiddleware(
      process.cwd(),
      () => ({ protocolVersion: 2, revision: 0, artifacts: [] }),
      "test-capability",
      provider,
      () => 90,
    );
    const input = createStartRequest();
    input.changeRequest.sourceContext = [];
    input.changeRequest.governance.approvedSourceIds = [];
    const response = invokeMiddleware(
      middleware,
      DEVTOOLS_AI_EXECUTION_ENDPOINT,
      input,
    );
    await response.completed;

    const events = response.chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool-call",
      "structured-output",
      "tool-result",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      call: { id: "call:test", name: "project.search" },
    });
    expect(events[2]).toMatchObject({
      value: { summary: "Read-only plan" },
    });
    expect(events[3]).toMatchObject({
      name: "project.search",
      status: "completed",
    });
  });

  it("keeps screenshot bytes in a bounded Node asset channel and resolves approved metadata", async () => {
    const resolvedImages: string[] = [];
    const provider: AIProvider = {
      descriptor: {
        ...providerDescriptor("vision-provider"),
        capabilities: {
          ...providerDescriptor("vision-provider").capabilities,
          imageInput: true,
        },
      },
      async *stream(request, { signal }) {
        for (const screenshot of request.changeRequest.screenshots)
          resolvedImages.push(
            await request.resolveScreenshot!(screenshot, signal),
          );
        yield { type: "completed" };
      },
    };
    const middleware = createAIGatewayMiddleware(
      process.cwd(),
      () => ({ protocolVersion: 2, revision: 0, artifacts: [] }),
      "test-capability",
      provider,
    );
    const asset = {
      id: "screenshot:desired",
      kind: "viewport" as const,
      phase: "desired" as const,
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
      devicePixelRatio: 1,
      route: "/fixture",
      scroll: { x: 0, y: 0 },
      capturedAt: 1,
      excludedRegions: [],
      byteLength: 5,
    };
    const upload = invokeMiddleware(
      middleware,
      DEVTOOLS_AI_SCREENSHOT_UPLOAD_ENDPOINT,
      {
        schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
        asset,
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      },
    );
    await upload.completed;
    expect(upload.statusCode).toBe(204);

    const input = createStartRequest();
    input.changeRequest.sourceContext = [];
    input.changeRequest.governance.approvedSourceIds = [];
    input.changeRequest.screenshots = [asset];
    input.changeRequest.governance.usage.screenshotCount = 1;
    input.changeRequest.governance.usage.screenshotBytes = 5;
    const response = invokeMiddleware(
      middleware,
      DEVTOOLS_AI_EXECUTION_ENDPOINT,
      input,
    );
    await response.completed;

    expect(response.chunks.join("")).toContain('"status":"supported"');
    expect(response.chunks.join("")).not.toContain("aW1hZ2U=");
    expect(resolvedImages).toEqual(["data:image/png;base64,aW1hZ2U="]);
  });

  it("rejects screenshot uploads whose bytes do not match approved metadata", async () => {
    const provider: AIProvider = {
      descriptor: providerDescriptor("safe-provider"),
      async *stream() {
        yield { type: "completed" };
      },
    };
    const middleware = createAIGatewayMiddleware(
      process.cwd(),
      () => ({ protocolVersion: 2, revision: 0, artifacts: [] }),
      "test-capability",
      provider,
    );
    const upload = invokeMiddleware(
      middleware,
      DEVTOOLS_AI_SCREENSHOT_UPLOAD_ENDPOINT,
      {
        schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
        asset: {
          id: "screenshot:mismatch",
          kind: "viewport",
          phase: "before",
          mimeType: "image/jpeg",
          width: 1,
          height: 1,
          devicePixelRatio: 1,
          route: "/",
          scroll: { x: 0, y: 0 },
          capturedAt: 1,
          excludedRegions: [],
          byteLength: 5,
        },
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      },
    );
    await upload.completed;

    expect(upload.statusCode).toBe(400);
    expect(upload.chunks.join("")).toBe(
      "AI screenshot upload does not match its metadata",
    );
  });

  it("fails explicitly when approved screenshot metadata has no Node asset", async () => {
    const provider: AIProvider = {
      descriptor: {
        ...providerDescriptor("vision-provider"),
        capabilities: {
          ...providerDescriptor("vision-provider").capabilities,
          imageInput: true,
        },
      },
      async *stream(request, { signal }) {
        await request.resolveScreenshot!(
          request.changeRequest.screenshots[0]!,
          signal,
        );
        yield { type: "completed" };
      },
    };
    const middleware = createAIGatewayMiddleware(
      process.cwd(),
      () => ({ protocolVersion: 2, revision: 0, artifacts: [] }),
      "test-capability",
      provider,
    );
    const input = createStartRequest();
    input.changeRequest.sourceContext = [];
    input.changeRequest.governance.approvedSourceIds = [];
    input.changeRequest.screenshots = [
      {
        id: "screenshot:missing",
        kind: "viewport",
        phase: "desired",
        mimeType: "image/png",
        width: 1,
        height: 1,
        devicePixelRatio: 1,
        route: "/",
        scroll: { x: 0, y: 0 },
        capturedAt: 1,
        excludedRegions: [],
        byteLength: 5,
      },
    ];
    const response = invokeMiddleware(
      middleware,
      DEVTOOLS_AI_EXECUTION_ENDPOINT,
      input,
    );
    await response.completed;

    expect(response.chunks.join("")).toContain(
      '"code":"AI_SCREENSHOT_ASSET_MISSING"',
    );
    expect(response.chunks.join("")).not.toContain("data:image");
  });

  it("runs a bounded read and patch.prepare loop without exposing tool results or writing files", async () => {
    const root = await mkdtemp(join(process.cwd(), ".elfui-agent-gateway-"));
    try {
      await mkdir(join(root, "src"));
      const file = join(root, "src", "Test.ts");
      const source =
        'const apiKey = "secret-value";\nexport const value = 1;\n';
      await writeFile(file, source);
      const snapshot: CompilerStateSnapshot = {
        protocolVersion: 2,
        revision: 1,
        artifacts: [
          {
            revision: 1,
            capturedAt: 1,
            id: file,
            sourceId: "src/Test.ts",
            kind: "metadata",
            payload: {},
          },
        ],
      };
      const turns: unknown[] = [];
      let approvalWasRecorded = false;
      let postApprovalTools: string[] = [];
      const provider: AIProvider = {
        descriptor: {
          ...providerDescriptor("agent-provider"),
          capabilities: {
            ...providerDescriptor("agent-provider").capabilities,
            toolCalling: true,
            structuredOutput: true,
          },
        },
        async *stream(request) {
          turns.push(request.agent);
          if (approvalWasRecorded) {
            postApprovalTools = [...(request.agent?.availableTools ?? [])];
            yield { type: "text-delta", text: "Approval remains read-only" };
            yield { type: "completed" };
            return;
          }
          if (request.agent?.turn === 0) {
            yield {
              type: "tool-call",
              call: {
                id: "call:read",
                name: "source.readFile",
                arguments: '{"sourceId":"src/Test.ts"}',
              },
            };
          } else if (request.agent?.turn === 1) {
            const readResult = request.agent.exchanges.at(-1)?.results[0];
            expect(JSON.stringify(readResult)).toContain("[REDACTED]");
            expect(JSON.stringify(readResult)).not.toContain("secret-value");
            const output = readResult?.output as Record<string, unknown>;
            yield {
              type: "tool-call",
              call: {
                id: "call:prepare",
                name: "patch.prepare",
                arguments: JSON.stringify({
                  proposal: {
                    schemaVersion: 1,
                    id: "proposal:test",
                    requestId: "request:test",
                    summary: "Update the approved value.",
                    assumptions: [],
                    affectedFiles: ["src/Test.ts"],
                    baseFileHashes: { "src/Test.ts": output.sha256 },
                    unifiedDiff:
                      "diff --git a/src/Test.ts b/src/Test.ts\n--- a/src/Test.ts\n+++ b/src/Test.ts\n@@ -2,1 +2,1 @@\n-export const value = 1;\n+export const value = 2;\n",
                    validationPlan: [
                      {
                        id: "validation:typecheck",
                        kind: "typecheck",
                        required: true,
                        files: ["src/Test.ts"],
                      },
                    ],
                    risk: "low",
                  },
                }),
              },
            };
          } else {
            expect(request.agent?.exchanges.at(-1)?.results[0]).toMatchObject({
              status: "completed",
              output: { proposalId: "proposal:test" },
            });
            yield { type: "text-delta", text: "Proposal prepared" };
          }
          yield { type: "completed" };
        },
      };
      const middleware = createAIGatewayMiddleware(
        root,
        () => snapshot,
        "test-capability",
        provider,
        () => 100,
      );
      const input = createStartRequest();
      input.mode = "plan";
      const response = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_EXECUTION_ENDPOINT,
        input,
      );
      await response.completed;

      const events = response.chunks
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "tool-call",
        "tool-result",
        "tool-call",
        "tool-result",
        "text-delta",
        "completed",
      ]);
      expect(turns).toHaveLength(3);
      expect(response.chunks.join("")).not.toContain("secret-value");
      expect(response.chunks.join("")).not.toContain("redacted source");

      const catalogResponse = invokeMiddleware(
        middleware,
        `${DEVTOOLS_AI_PATCH_PROPOSAL_CATALOG_ENDPOINT}?requestId=request%3Atest`,
        null,
        "GET",
      );
      await catalogResponse.completed;
      expect(catalogResponse.statusCode).toBe(200);
      const catalog = JSON.parse(catalogResponse.chunks.join("")) as {
        proposals: Array<{
          proposal: { baseFileHashes: Record<string, string> };
          status: string;
        }>;
      };
      expect(catalog.proposals).toEqual([
        expect.objectContaining({
          status: "pending",
          proposal: expect.objectContaining({
            baseFileHashes: {
              "src/Test.ts": expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          }),
        }),
      ]);

      const decisionResponse = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_PATCH_PROPOSAL_DECISION_ENDPOINT,
        {
          schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
          proposalId: "proposal:test",
          requestId: "request:test",
          decision: "approve",
        },
      );
      await decisionResponse.completed;
      expect(decisionResponse.statusCode).toBe(200);
      const decided = JSON.parse(decisionResponse.chunks.join("")) as {
        status: string;
        decisions: Array<{
          approvedFiles: string[];
          approvedFileHashes: Record<string, string>;
        }>;
      };
      expect(decided).toMatchObject({
        status: "approved",
        decisions: [
          {
            approvedFiles: ["src/Test.ts"],
            approvedFileHashes: catalog.proposals[0]!.proposal.baseFileHashes,
          },
        ],
      });

      const forgedDecision = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_PATCH_PROPOSAL_DECISION_ENDPOINT,
        {
          schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
          proposalId: "proposal:test",
          requestId: "request:test",
          decision: "approve",
          approvedFiles: ["src/Injected.ts"],
        },
      );
      await forgedDecision.completed;
      expect(forgedDecision.statusCode).toBe(400);

      approvalWasRecorded = true;
      const postApprovalInput = createStartRequest();
      postApprovalInput.executionId = "execution:post-approval-readonly";
      postApprovalInput.assistantMessageId = "message:post-approval-readonly";
      postApprovalInput.mode = "plan";
      const postApprovalResponse = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_EXECUTION_ENDPOINT,
        postApprovalInput,
      );
      await postApprovalResponse.completed;
      expect(postApprovalTools).not.toContain("patch.applyApproved");
      expect(await readFile(file, "utf8")).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies only an approved patch through the fixed Node verification chain and rolls back failures", async () => {
    const root = await mkdtemp(join(process.cwd(), ".elfui-agent-apply-"));
    try {
      await mkdir(join(root, "src"));
      const file = join(root, "src", "Test.ts");
      await writeFile(file, "export const value = 1;\n");
      const snapshot: CompilerStateSnapshot = {
        protocolVersion: 2,
        revision: 1,
        artifacts: [
          {
            revision: 1,
            capturedAt: 1,
            id: file,
            sourceId: "src/Test.ts",
            kind: "metadata",
            payload: {},
          },
        ],
      };
      const preparationByExecution = new Map([
        [
          "execution:prepare-verified",
          {
            proposalId: "proposal:verified",
            before: 1,
            after: 2,
          },
        ],
        [
          "execution:prepare-rollback",
          {
            proposalId: "proposal:rollback",
            before: 2,
            after: 3,
          },
        ],
      ]);
      const applicationByExecution = new Map([
        ["execution:apply-verified", "proposal:verified"],
        ["execution:apply-rollback", "proposal:rollback"],
        ["execution:apply-external-edit", "proposal:verified"],
      ]);
      const approvalIds = new Map<string, string>();
      const applyResults = new Map<string, unknown>();
      const approvedPatchesSeen = new Map<string, unknown>();
      let postVerifiedTools: string[] = [];
      let postVerifiedPatches: unknown = null;
      let postRollbackTools: string[] = [];
      let postRollbackPatches: unknown = null;
      const provider: AIProvider = {
        descriptor: {
          ...providerDescriptor("verified-agent-provider"),
          capabilities: {
            ...providerDescriptor("verified-agent-provider").capabilities,
            toolCalling: true,
            structuredOutput: true,
          },
        },
        async *stream(request) {
          const preparation = preparationByExecution.get(request.executionId);
          if (preparation) {
            if (request.agent?.turn === 0)
              yield {
                type: "tool-call",
                call: {
                  id: `call:read:${preparation.proposalId}`,
                  name: "source.readFile",
                  arguments: '{"sourceId":"src/Test.ts"}',
                },
              };
            else if (request.agent?.turn === 1) {
              const readResult = request.agent.exchanges.at(-1)?.results[0];
              const output = readResult?.output as Record<string, unknown>;
              yield {
                type: "tool-call",
                call: {
                  id: `call:prepare:${preparation.proposalId}`,
                  name: "patch.prepare",
                  arguments: JSON.stringify({
                    proposal: {
                      schemaVersion: 1,
                      id: preparation.proposalId,
                      requestId: "request:test",
                      summary: `Update value to ${preparation.after}.`,
                      assumptions: [],
                      affectedFiles: ["src/Test.ts"],
                      baseFileHashes: { "src/Test.ts": output.sha256 },
                      unifiedDiff:
                        "diff --git a/src/Test.ts b/src/Test.ts\n" +
                        "--- a/src/Test.ts\n" +
                        "+++ b/src/Test.ts\n" +
                        "@@ -1,1 +1,1 @@\n" +
                        `-export const value = ${preparation.before};\n` +
                        `+export const value = ${preparation.after};\n`,
                      validationPlan: [
                        {
                          id: `validation:typecheck:${preparation.proposalId}`,
                          kind: "typecheck",
                          required: true,
                          files: ["src/Test.ts"],
                        },
                      ],
                      risk: "low",
                    },
                  }),
                },
              };
            } else
              yield {
                type: "text-delta",
                text: `Prepared ${preparation.proposalId}`,
              };
            yield { type: "completed" };
            return;
          }

          if (
            request.executionId === "execution:post-verified" ||
            request.executionId === "execution:post-user-rollback"
          ) {
            const tools = [...(request.agent?.availableTools ?? [])];
            const patches = JSON.parse(
              JSON.stringify(request.agent?.approvedPatches ?? []),
            );
            if (request.executionId === "execution:post-verified") {
              postVerifiedTools = tools;
              postVerifiedPatches = patches;
            } else {
              postRollbackTools = tools;
              postRollbackPatches = patches;
            }
            yield {
              type: "text-delta",
              text: "Verified Patch is no longer applicable",
            };
            yield { type: "completed" };
            return;
          }

          const proposalId = applicationByExecution.get(request.executionId);
          if (!proposalId) throw new Error("Unexpected test execution");
          if (request.agent?.turn === 0) {
            approvedPatchesSeen.set(
              proposalId,
              JSON.parse(JSON.stringify(request.agent.approvedPatches)),
            );
            yield {
              type: "tool-call",
              call: {
                id: `call:apply:${proposalId}`,
                name: "patch.applyApproved",
                arguments: JSON.stringify({
                  proposalId,
                  approvalId: approvalIds.get(proposalId),
                }),
              },
            };
          } else {
            applyResults.set(
              proposalId,
              request.agent?.exchanges.at(-1)?.results[0],
            );
            yield { type: "text-delta", text: `Verified ${proposalId}` };
          }
          yield { type: "completed" };
        },
      };
      const verificationSteps: string[] = [];
      let failTypecheck = false;
      let clock = 100;
      const middleware = createAIGatewayMiddleware(
        root,
        () => snapshot,
        "test-capability",
        provider,
        () => ++clock,
        {
          adapters: {
            format: vi.fn(async () => {
              verificationSteps.push("format");
              return { ok: true, summary: "formatted" };
            }),
            typecheck: vi.fn(async () => {
              verificationSteps.push("typecheck");
              return {
                ok: !failTypecheck,
                summary: failTypecheck ? "typecheck failed" : "typed",
              };
            }),
            testScoped: vi.fn(async () => {
              verificationSteps.push("test-scoped");
              return { ok: true, summary: "tests passed" };
            }),
            hmr: vi.fn(async () => {
              verificationSteps.push("hmr");
              return { ok: true, summary: "HMR settled" };
            }),
            diagnostics: vi.fn(async () => {
              verificationSteps.push("diagnostics");
              return { ok: true, summary: "no diagnostics" };
            }),
          },
        },
      );

      const prepareAndApprove = async (
        executionId: string,
        proposalId: string,
      ): Promise<void> => {
        const input = createStartRequest();
        input.executionId = executionId;
        input.assistantMessageId = `message:${executionId}`;
        input.mode = "plan";
        const prepared = invokeMiddleware(
          middleware,
          DEVTOOLS_AI_EXECUTION_ENDPOINT,
          input,
        );
        await prepared.completed;
        expect(prepared.chunks.join("")).toContain('"type":"completed"');

        const decision = invokeMiddleware(
          middleware,
          DEVTOOLS_AI_PATCH_PROPOSAL_DECISION_ENDPOINT,
          {
            schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
            proposalId,
            requestId: "request:test",
            decision: "approve",
          },
        );
        await decision.completed;
        expect(decision.statusCode).toBe(200);
        const review = JSON.parse(decision.chunks.join("")) as {
          decisions: Array<{ id: string }>;
        };
        approvalIds.set(proposalId, review.decisions[0]!.id);
      };

      const apply = async (executionId: string) => {
        const input = createStartRequest();
        input.executionId = executionId;
        input.assistantMessageId = `message:${executionId}`;
        input.mode = "plan";
        const response = invokeMiddleware(
          middleware,
          DEVTOOLS_AI_EXECUTION_ENDPOINT,
          input,
        );
        await response.completed;
        return response;
      };

      await prepareAndApprove(
        "execution:prepare-verified",
        "proposal:verified",
      );
      const verifiedResponse = await apply("execution:apply-verified");
      expect(await readFile(file, "utf8")).toBe("export const value = 2;\n");
      expect(verificationSteps).toEqual([
        "format",
        "typecheck",
        "test-scoped",
        "hmr",
        "diagnostics",
      ]);
      expect(approvedPatchesSeen.get("proposal:verified")).toEqual([
        expect.objectContaining({
          proposalId: "proposal:verified",
          approvalId: approvalIds.get("proposal:verified"),
          requestId: "request:test",
          affectedFiles: ["src/Test.ts"],
        }),
      ]);
      expect(applyResults.get("proposal:verified")).toMatchObject({
        status: "completed",
        output: {
          proposalId: "proposal:verified",
          status: "verified",
          files: ["src/Test.ts"],
          checks: [
            { step: "format", status: "passed" },
            { step: "typecheck", status: "passed" },
            { step: "test-scoped", status: "passed" },
            { step: "build", status: "skipped" },
            { step: "hmr", status: "passed" },
            { step: "diagnostics", status: "passed" },
          ],
        },
      });
      const verifiedEvents = verifiedResponse.chunks
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(verifiedEvents.map((event) => event.type)).toEqual([
        "started",
        "tool-call",
        "tool-result",
        "patch-verification",
        "text-delta",
        "completed",
      ]);
      const verifiedAuditEvent = verifiedEvents.find(
        (event) => event.type === "patch-verification",
      ) as
        | {
            verification: {
              applicationId: string;
              verificationId: string;
              proposalId: string;
              requestId: string;
            };
          }
        | undefined;
      expect(verifiedAuditEvent).toMatchObject({
        verification: {
          proposalId: "proposal:verified",
          status: "verified",
          files: [
            {
              sourceId: "src/Test.ts",
              beforeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
              afterHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          ],
          diagnosticsTruncated: false,
        },
      });
      expect(verifiedResponse.chunks.join("")).not.toContain(
        "export const value",
      );
      expect(verifiedResponse.chunks.join("")).not.toContain("beforeHashes");
      expect(verifiedResponse.chunks.join("")).not.toContain("afterHashes");
      await apply("execution:post-verified");
      expect(postVerifiedTools).not.toContain("patch.applyApproved");
      expect(postVerifiedPatches).toEqual([]);

      await prepareAndApprove(
        "execution:prepare-rollback",
        "proposal:rollback",
      );
      failTypecheck = true;
      const rollbackResponse = await apply("execution:apply-rollback");
      expect(await readFile(file, "utf8")).toBe("export const value = 2;\n");
      expect(verificationSteps.slice(-2)).toEqual(["format", "typecheck"]);
      expect(applyResults.get("proposal:rollback")).toMatchObject({
        status: "completed",
        output: {
          proposalId: "proposal:rollback",
          status: "rolled-back",
          failedStep: "typecheck",
          rollback: {
            rolledBack: true,
          },
        },
      });
      const rollbackEvents = rollbackResponse.chunks
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        rollbackEvents.find((event) => event.type === "patch-verification"),
      ).toMatchObject({
        verification: {
          proposalId: "proposal:rollback",
          status: "rolled-back",
          failedStep: "typecheck",
          files: [
            {
              sourceId: "src/Test.ts",
              beforeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
              afterHash: expect.stringMatching(/^[a-f0-9]{64}$/),
              restoredHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          ],
        },
      });
      expect(rollbackResponse.chunks.join("")).not.toContain(
        "export const value",
      );
      expect(rollbackResponse.chunks.join("")).not.toContain("beforeHashes");
      expect(rollbackResponse.chunks.join("")).not.toContain("afterHashes");

      const userRollbackResponse = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_PATCH_ROLLBACK_ENDPOINT,
        {
          schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
          applicationId: verifiedAuditEvent!.verification.applicationId,
          verificationId: verifiedAuditEvent!.verification.verificationId,
          proposalId: verifiedAuditEvent!.verification.proposalId,
          requestId: verifiedAuditEvent!.verification.requestId,
        },
      );
      await userRollbackResponse.completed;
      expect(userRollbackResponse.statusCode).toBe(200);
      expect(JSON.parse(userRollbackResponse.chunks.join(""))).toMatchObject({
        applicationId: verifiedAuditEvent!.verification.applicationId,
        verificationId: verifiedAuditEvent!.verification.verificationId,
        proposalId: "proposal:verified",
        requestId: "request:test",
        status: "rolled-back",
        reason: "user",
        files: ["src/Test.ts"],
        restoredFileHashes: {
          "src/Test.ts": expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(await readFile(file, "utf8")).toBe("export const value = 1;\n");

      const forgedRollback = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_PATCH_ROLLBACK_ENDPOINT,
        {
          schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
          applicationId: verifiedAuditEvent!.verification.applicationId,
          verificationId: verifiedAuditEvent!.verification.verificationId,
          proposalId: "proposal:forged",
          requestId: "request:test",
        },
      );
      await forgedRollback.completed;
      expect(forgedRollback.statusCode).toBe(404);

      await apply("execution:post-user-rollback");
      expect(postRollbackTools).toContain("patch.applyApproved");
      expect(postRollbackPatches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ proposalId: "proposal:verified" }),
        ]),
      );

      failTypecheck = false;
      const externalEditApply = await apply("execution:apply-external-edit");
      const externalEditAudit = externalEditApply.chunks
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((event) => event.type === "patch-verification") as {
        verification: {
          applicationId: string;
          verificationId: string;
          proposalId: string;
          requestId: string;
        };
      };
      await writeFile(file, "export const value = 99;\n");
      const unsafeRollback = invokeMiddleware(
        middleware,
        DEVTOOLS_AI_PATCH_ROLLBACK_ENDPOINT,
        {
          schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
          applicationId: externalEditAudit.verification.applicationId,
          verificationId: externalEditAudit.verification.verificationId,
          proposalId: externalEditAudit.verification.proposalId,
          requestId: externalEditAudit.verification.requestId,
        },
      );
      await unsafeRollback.completed;
      expect(unsafeRollback.statusCode).toBe(409);
      expect(await readFile(file, "utf8")).toBe("export const value = 99;\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
