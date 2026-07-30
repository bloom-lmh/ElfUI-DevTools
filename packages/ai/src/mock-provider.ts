import type {
  AIProvider,
  AIProviderEvent,
  AIProviderRequest,
  AIProviderStreamOptions,
} from "./provider.js";
import { summarizeAIChangeRequest } from "./intent-summary.js";

export interface DeterministicMockProviderOptions {
  chunkSize?: number;
  delayMs?: number;
  failAfterChunks?: number;
}

const positiveInteger = (
  value: number | undefined,
  fallback: number,
): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

const abortError = (): Error => {
  const error = new Error("AI execution was cancelled");
  error.name = "AbortError";
  return error;
};

const wait = (delayMs: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.reject(abortError());
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
};

const describeRequest = (request: AIProviderRequest): string => {
  const visualSummary = summarizeAIChangeRequest(request.changeRequest);
  const targetLabels = request.changeRequest.targets
    .map((target) => target.inspector.element.tag)
    .slice(0, 3);
  const targetSummary =
    targetLabels.length > 0 ? targetLabels.join("、") : "未命名目标";
  const intentTypes = [
    ...new Set(request.changeRequest.intents.map((intent) => intent.type)),
  ];
  const intentSummary =
    intentTypes.length > 0 ? intentTypes.join("、") : "仅上下文检查";
  const sourceBlocks = request.changeRequest.sourceContext.filter(
    (block) => typeof block.content === "string",
  ).length;

  if (request.mode === "plan")
    return (
      `只读实现方案：已定位 ${request.changeRequest.targets.length} 个视觉目标（${targetSummary}）和 ` +
      `${request.changeRequest.intents.length} 个意图（${intentSummary}）。` +
      `\n1. 依据稳定模板节点与源码引用确认修改位置。` +
      `\n2. 按视觉意图调整结构或样式，同时保留响应式布局、可访问性和公开 API。` +
      `\n3. 修改后执行格式化、类型检查、范围测试和 HMR 验证。` +
      (visualSummary.text
        ? `\n结构化视觉上下文：\n${visualSummary.text}`
        : "") +
      `\nNode Gateway 已装配 ${sourceBlocks} 个最小源码片段；本次只生成方案，不会写入文件。`
    );

  return (
    `只读解释：当前视觉草稿包含 ${request.changeRequest.targets.length} 个目标（${targetSummary}）、` +
    `${request.changeRequest.intents.length} 个意图（${intentSummary}）和 ` +
    `${request.changeRequest.annotations.length} 个标注。` +
    `这些操作表达期望结果，不会直接改变业务 DOM。` +
    (visualSummary.text
      ? `\n结构化视觉上下文：\n${visualSummary.text}\n`
      : "") +
    `Node Gateway 已装配 ${sourceBlocks} 个最小源码片段，并保留响应式布局、可访问性和公开 API 约束。`
  );
};

export class DeterministicMockProvider implements AIProvider {
  public readonly descriptor = {
    id: "elfui-mock",
    label: "ElfUI deterministic mock",
    description: "Local deterministic provider used for tests and demos.",
    capabilities: {
      text: true,
      imageInput: false,
      toolCalling: false,
      structuredOutput: false,
      reasoning: false,
      temperature: false,
    },
    models: [
      {
        id: "elfui-deterministic",
        label: "ElfUI deterministic",
      },
    ],
    defaultModelId: "elfui-deterministic",
  } as const;
  private readonly chunkSize: number;
  private readonly delayMs: number;
  private readonly failAfterChunks: number | null;

  public constructor(options: DeterministicMockProviderOptions = {}) {
    this.chunkSize = positiveInteger(options.chunkSize, 24);
    this.delayMs =
      typeof options.delayMs === "number" &&
      Number.isFinite(options.delayMs) &&
      options.delayMs >= 0
        ? options.delayMs
        : 8;
    this.failAfterChunks =
      typeof options.failAfterChunks === "number" &&
      Number.isSafeInteger(options.failAfterChunks) &&
      options.failAfterChunks >= 0
        ? options.failAfterChunks
        : null;
  }

  public async *stream(
    request: AIProviderRequest,
    options: AIProviderStreamOptions,
  ): AsyncIterable<AIProviderEvent> {
    const response = describeRequest(request);
    let emitted = 0;
    for (let offset = 0; offset < response.length; offset += this.chunkSize) {
      if (options.signal.aborted) throw abortError();
      if (this.failAfterChunks !== null && emitted >= this.failAfterChunks)
        throw new Error("Deterministic mock provider failure");
      await wait(this.delayMs, options.signal);
      emitted += 1;
      yield {
        type: "text-delta",
        text: response.slice(offset, offset + this.chunkSize),
      };
    }
    if (options.signal.aborted) throw abortError();
    yield { type: "completed" };
  }
}
