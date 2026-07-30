import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEVTOOLS_AI_EXECUTION_CANCEL_ENDPOINT,
  DEVTOOLS_AI_EXECUTION_ENDPOINT,
  DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
  DEVTOOLS_AI_PROVIDER_CATALOG_ENDPOINT,
  DEVTOOLS_AI_PATCH_PROPOSAL_CATALOG_ENDPOINT,
  DEVTOOLS_AI_PATCH_PROPOSAL_DECISION_ENDPOINT,
  DEVTOOLS_AI_PATCH_ROLLBACK_ENDPOINT,
  DEVTOOLS_AI_SCREENSHOT_UPLOAD_ENDPOINT,
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  AIProviderError,
  AIProviderRegistry,
  deriveReadonlyAIProviderRequirements,
  isAIExecutionStartRequestProvider,
  isPatchApplicationRollbackRequest,
  isPatchProposalDecisionRequest,
  type AIExecutionCancelRequest,
  type AIExecutionEvent,
  type AIExecutionStartRequest,
  type AIProvider,
  type AIProviderApprovedPatch,
  type AIReference,
  type AIPatchVerificationAudit,
  type AIScreenshotUploadRequest,
  type AIAgentToolCall,
  type AIAgentToolName,
  type AIAgentToolResult,
} from "@elfui/devtools-ai";
import {
  DEVTOOLS_AI_CHANGE_SCHEMA_VERSION,
  isScreenshotAsset,
  redactSensitiveText,
  type AIChangeDiagnostic,
  type AIChangeRequest,
  type CompilerStateSnapshot,
  type ScreenshotAsset,
  type SourceContextBlock,
} from "@elfui/devtools-shared";

import {
  createProjectSourceReader,
  type ProjectSourceReader,
} from "./project-source-reader.js";
import {
  createReadonlyAIAgentTools,
  type AIAgentToolScope,
} from "./agent-tools.js";
import { runAIAgentSession } from "./agent-session.js";
import {
  ApprovedPatchApplicationError,
  createApprovedPatchApplier,
} from "./patch-application.js";
import {
  createPatchProposalStore,
  PatchProposalError,
} from "./patch-proposals.js";
import {
  createPatchVerificationCoordinator,
  type PatchVerificationAdapters,
  type PatchVerificationCoordinatorOptions,
  type PatchVerificationResult,
} from "./patch-verification.js";

const MAX_EXECUTION_REQUEST_BYTES = 512_000;
const MAX_SCREENSHOT_UPLOAD_REQUEST_BYTES = 10_750_000;
const MAX_SCREENSHOT_ASSET_BYTES = 8_000_000;
const MAX_SCREENSHOT_STORE_BYTES = 32_000_000;
const MAX_SCREENSHOT_STORE_ENTRIES = 64;
const MAX_GATEWAY_SOURCE_BLOCKS = 12;
const MAX_GATEWAY_SOURCE_CHARACTERS = 32_000;
const MAX_GATEWAY_USER_MESSAGE_CHARACTERS = 4_000;
const MAX_PROVIDER_EVENT_CHARACTERS = 64_000;
const MAX_EXECUTIONS = 50;
const MAX_PATCH_AUDIT_DIAGNOSTICS = 20;
const MAX_AI_CHANGE_DIAGNOSTICS = 50;
const MAX_AI_CHANGE_DIAGNOSTIC_CHARACTERS = 20_000;
const MAX_AI_REPLY_REFERENCES = 64;
const READONLY_AGENT_TOOLS: AIAgentToolName[] = [
  "project.search",
  "source.readRanges",
  "source.readFile",
  "patch.prepare",
];
const SCREENSHOT_UPLOAD_KEYS = new Set(["schemaVersion", "asset", "dataUrl"]);
const SCREENSHOT_ASSET_KEYS = new Set([
  "id",
  "kind",
  "phase",
  "mimeType",
  "width",
  "height",
  "devicePixelRatio",
  "route",
  "scroll",
  "capturedAt",
  "selection",
  "excludedRegions",
  "byteLength",
]);

export type AIGatewayMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;

export interface AIGatewayContextAudit {
  sourceBlocks: number;
  sourceCharacters: number;
  redactions: number;
  omissions: number;
}

export interface AssembledAIProviderRequest {
  changeRequest: AIChangeRequest;
  audit: AIGatewayContextAudit;
}

export interface AIGatewayPatchVerificationOptions extends Omit<
  PatchVerificationCoordinatorOptions,
  "now"
> {
  adapters: PatchVerificationAdapters;
}

interface ExecutionSession {
  input: AIExecutionStartRequest;
  controller: AbortController;
  terminal: boolean;
}

interface StoredScreenshotAsset {
  asset: ScreenshotAsset;
  dataUrl: string;
}

type WithoutSchema<T> = T extends unknown ? Omit<T, "schemaVersion"> : never;
type AIExecutionEventWithoutSchema = WithoutSchema<AIExecutionEvent>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const hasAccessToken = (
  request: IncomingMessage,
  accessToken: string,
): boolean => {
  const provided = request.headers["x-elfui-devtools-token"];
  if (typeof provided !== "string") return false;
  const expectedBytes = Buffer.from(accessToken);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
};

const readJsonBody = (
  request: IncomingMessage,
  maxCharacters = MAX_EXECUTION_REQUEST_BYTES,
): Promise<unknown> =>
  new Promise((resolveBody, rejectBody) => {
    let body = "";
    let settled = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (settled) return;
      body += chunk;
      if (body.length > maxCharacters) {
        settled = true;
        rejectBody(new Error("AI execution request is too large"));
      }
    });
    request.on("end", () => {
      if (settled) return;
      try {
        resolveBody(JSON.parse(body) as unknown);
      } catch {
        rejectBody(new Error("AI execution request is not valid JSON"));
      }
    });
    request.on("error", rejectBody);
  });

const send = (
  response: ServerResponse,
  statusCode: number,
  body = "",
): void => {
  response.statusCode = statusCode;
  response.end(body);
};

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  send(response, statusCode, JSON.stringify(body));
};

const isBoundedId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 240;

const isSourceLocation = (value: unknown): boolean =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ["file", "line", "column", "endLine", "endColumn"].includes(key),
  ) &&
  typeof value.file === "string" &&
  value.file.length > 0 &&
  value.file.length <= 4_096 &&
  Number.isSafeInteger(value.line) &&
  (value.line as number) > 0 &&
  Number.isSafeInteger(value.column) &&
  (value.column as number) > 0 &&
  (value.endLine === undefined ||
    (Number.isSafeInteger(value.endLine) && (value.endLine as number) > 0)) &&
  (value.endColumn === undefined ||
    (Number.isSafeInteger(value.endColumn) && (value.endColumn as number) > 0));

const isChangeDiagnostic = (value: unknown): value is AIChangeDiagnostic =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ["id", "severity", "code", "message", "sourceId", "source"].includes(key),
  ) &&
  isBoundedId(value.id) &&
  (value.severity === "error" ||
    value.severity === "warning" ||
    value.severity === "info") &&
  typeof value.code === "string" &&
  value.code.length > 0 &&
  value.code.length <= 100 &&
  typeof value.message === "string" &&
  value.message.length > 0 &&
  value.message.length <= 500 &&
  (value.sourceId === undefined ||
    (typeof value.sourceId === "string" &&
      value.sourceId.length > 0 &&
      value.sourceId.length <= 4_096)) &&
  (value.source === undefined || isSourceLocation(value.source));

const isFollowUpContext = (
  value: unknown,
  changeRequest: Record<string, unknown>,
): boolean => {
  if (value === undefined) return true;
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      [
        "previousRequestId",
        "proposalId",
        "applicationId",
        "verificationId",
        "reviewId",
        "resultScreenshotId",
        "references",
      ].includes(key),
    ) ||
    !isBoundedId(value.previousRequestId) ||
    !isBoundedId(value.proposalId) ||
    !isBoundedId(value.applicationId) ||
    !isBoundedId(value.verificationId) ||
    !isBoundedId(value.reviewId) ||
    !isBoundedId(value.resultScreenshotId) ||
    !Array.isArray(value.references) ||
    value.references.length === 0 ||
    value.references.length > 64 ||
    !Array.isArray(changeRequest.intents) ||
    !Array.isArray(changeRequest.annotations) ||
    !Array.isArray(changeRequest.screenshots) ||
    !changeRequest.screenshots.some(
      (screenshot) =>
        isRecord(screenshot) &&
        screenshot.id === value.resultScreenshotId &&
        screenshot.phase === "result",
    )
  )
    return false;
  const intentIds = new Set(
    changeRequest.intents.flatMap((intent) =>
      isRecord(intent) && isBoundedId(intent.id) ? [intent.id] : [],
    ),
  );
  const annotationIds = new Set(
    changeRequest.annotations.flatMap((annotation) =>
      isRecord(annotation) && isBoundedId(annotation.id) ? [annotation.id] : [],
    ),
  );
  const seen = new Set<string>();
  return value.references.every((reference) => {
    if (
      !isRecord(reference) ||
      !Object.keys(reference).every((key) =>
        ["kind", "id", "status"].includes(key),
      ) ||
      (reference.kind !== "visual-intent" && reference.kind !== "annotation") ||
      !isBoundedId(reference.id) ||
      (reference.status !== "partial" && reference.status !== "unmet")
    )
      return false;
    const key = `${reference.kind}:${reference.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return reference.kind === "visual-intent"
      ? intentIds.has(reference.id)
      : annotationIds.has(reference.id);
  });
};

const isStartRequest = (value: unknown): value is AIExecutionStartRequest => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION ||
    !isBoundedId(value.executionId) ||
    !isBoundedId(value.conversationId) ||
    !isBoundedId(value.assistantMessageId) ||
    (value.mode !== "explain" && value.mode !== "plan") ||
    !isRecord(value.changeRequest) ||
    value.changeRequest.schemaVersion !== DEVTOOLS_AI_CHANGE_SCHEMA_VERSION ||
    value.changeRequest.conversationId !== value.conversationId ||
    !Array.isArray(value.changeRequest.sourceContext) ||
    (value.changeRequest.diagnostics !== undefined &&
      (!Array.isArray(value.changeRequest.diagnostics) ||
        value.changeRequest.diagnostics.length > MAX_AI_CHANGE_DIAGNOSTICS ||
        !value.changeRequest.diagnostics.every(isChangeDiagnostic) ||
        new Set(
          value.changeRequest.diagnostics.map((diagnostic) =>
            isRecord(diagnostic) ? diagnostic.id : undefined,
          ),
        ).size !== value.changeRequest.diagnostics.length ||
        value.changeRequest.diagnostics.reduce(
          (characters, diagnostic) =>
            characters +
            (isRecord(diagnostic) && typeof diagnostic.message === "string"
              ? diagnostic.message.length
              : 0),
          0,
        ) > MAX_AI_CHANGE_DIAGNOSTIC_CHARACTERS)) ||
    !isFollowUpContext(value.changeRequest.followUp, value.changeRequest) ||
    !isAIExecutionStartRequestProvider(value.provider)
  )
    return false;
  return (
    value.retryOfExecutionId === undefined ||
    isBoundedId(value.retryOfExecutionId)
  );
};

const isCancelRequest = (value: unknown): value is AIExecutionCancelRequest =>
  isRecord(value) && isBoundedId(value.executionId);

const parseScreenshotDataUrl = (
  value: unknown,
): { mimeType: ScreenshotAsset["mimeType"]; byteLength: number } | null => {
  if (typeof value !== "string") return null;
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(
      value,
    );
  if (!match || match[2]!.length === 0 || match[2]!.length % 4 !== 0)
    return null;
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.toString("base64") !== match[2]) return null;
  return {
    mimeType: match[1] as ScreenshotAsset["mimeType"],
    byteLength: bytes.byteLength,
  };
};

const isScreenshotUploadRequest = (
  value: unknown,
): value is AIScreenshotUploadRequest =>
  isRecord(value) &&
  Object.keys(value).every((key) => SCREENSHOT_UPLOAD_KEYS.has(key)) &&
  value.schemaVersion === DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION &&
  isScreenshotAsset(value.asset) &&
  Object.keys(value.asset).every((key) => SCREENSHOT_ASSET_KEYS.has(key)) &&
  isBoundedId(value.asset.id) &&
  Number.isSafeInteger(value.asset.width) &&
  value.asset.width > 0 &&
  value.asset.width <= 32_768 &&
  Number.isSafeInteger(value.asset.height) &&
  value.asset.height > 0 &&
  value.asset.height <= 32_768 &&
  value.asset.devicePixelRatio > 0 &&
  value.asset.devicePixelRatio <= 16 &&
  value.asset.route.length <= 4_096 &&
  value.asset.excludedRegions.length <= 256 &&
  Number.isSafeInteger(value.asset.byteLength) &&
  value.asset.byteLength > 0 &&
  typeof value.dataUrl === "string";

const screenshotMetadataMatches = (
  stored: ScreenshotAsset,
  requested: ScreenshotAsset,
): boolean => JSON.stringify(stored) === JSON.stringify(requested);

const sourceRangeFor = (
  block: SourceContextBlock,
): { startLine: number; endLine: number } | undefined => {
  if (!block.range) return undefined;
  return {
    startLine: Math.max(1, block.range.line - 5),
    endLine: (block.range.endLine ?? block.range.line) + 5,
  };
};

const withoutSourceContent = (
  sourceContext: readonly SourceContextBlock[],
): SourceContextBlock[] =>
  sourceContext.map((block) => {
    const sanitized = { ...block };
    delete sanitized.content;
    return sanitized;
  });

const agentToolScopeFor = (
  changeRequest: AIChangeRequest,
): AIAgentToolScope => {
  const allowedFiles = changeRequest.constraints.allowedFiles
    ? new Set(changeRequest.constraints.allowedFiles)
    : null;
  const allowedSourceIds = [
    ...new Set([
      ...changeRequest.targets.flatMap((target) =>
        target.source ? [target.source.sourceId] : [],
      ),
      ...changeRequest.governance.approvedSourceIds,
    ]),
  ].filter((sourceId) => !allowedFiles || allowedFiles.has(sourceId));
  return { requestId: changeRequest.id, allowedSourceIds };
};

const completedToolResult = (
  call: AIAgentToolCall,
  output: AIAgentToolResult["output"],
): AIAgentToolResult => ({
  schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  callId: call.id,
  name: call.name,
  status: "completed",
  output: output ?? null,
});

const patchVerificationAuditFor = (
  verification: PatchVerificationResult,
): AIPatchVerificationAudit => {
  const allDiagnostics = verification.checks.flatMap((check) =>
    check.diagnostics.map((diagnostic) => ({
      step: check.step,
      severity: diagnostic.severity,
      message: diagnostic.message.slice(0, 500),
      ...(diagnostic.code ? { code: diagnostic.code.slice(0, 100) } : {}),
      ...(diagnostic.sourceId
        ? { sourceId: diagnostic.sourceId.slice(0, 4_096) }
        : {}),
    })),
  );
  return {
    verificationId: verification.verificationId,
    applicationId: verification.application.applicationId,
    proposalId: verification.proposalId,
    approvalId: verification.approvalId,
    requestId: verification.requestId,
    status: verification.status,
    files: verification.application.files.map((sourceId) => ({
      sourceId,
      beforeHash: verification.application.beforeHashes[sourceId]!,
      afterHash: verification.application.afterHashes[sourceId]!,
      ...(verification.rollback
        ? { restoredHash: verification.rollback.restoredHashes[sourceId]! }
        : {}),
    })),
    checks: verification.checks.map((check) => ({
      step: check.step,
      status: check.status,
      required: check.required,
      summary: check.summary,
      durationMs: check.durationMs,
    })),
    diagnostics: allDiagnostics.slice(0, MAX_PATCH_AUDIT_DIAGNOSTICS),
    diagnosticsTruncated: allDiagnostics.length > MAX_PATCH_AUDIT_DIAGNOSTICS,
    ...(verification.failedStep ? { failedStep: verification.failedStep } : {}),
    appliedAt: verification.application.appliedAt,
    startedAt: verification.startedAt,
    completedAt: verification.completedAt,
    ...(verification.rollback
      ? { rolledBackAt: verification.rollback.rolledBackAt }
      : {}),
  };
};

const failedToolResult = (
  call: AIAgentToolCall,
  error: unknown,
): AIAgentToolResult => {
  const expectedError =
    error instanceof PatchProposalError ||
    error instanceof ApprovedPatchApplicationError;
  return {
    schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
    callId: call.id,
    name: call.name,
    status: "failed",
    error: {
      code: expectedError ? error.code : "AI_AGENT_TOOL_FAILED",
      message: redactSensitiveText(
        expectedError
          ? error.message
          : "AI Agent tool failed within its approved scope",
      ).text,
      retryable: false,
    },
  };
};

export const assembleReadonlyProviderRequest = (
  input: AIExecutionStartRequest,
  readSource: ProjectSourceReader,
): AssembledAIProviderRequest => {
  if (
    input.changeRequest.sourceContext.some(
      (block) => typeof block.content === "string",
    )
  )
    throw new Error(
      "Browser AI execution requests must not contain source content",
    );

  const targetSourceIds = new Set(
    input.changeRequest.targets.flatMap((target) =>
      target.source ? [target.source.sourceId] : [],
    ),
  );
  const approvedSourceIds = new Set(
    input.changeRequest.governance.approvedSourceIds,
  );
  const allowedFiles = input.changeRequest.constraints.allowedFiles
    ? new Set(input.changeRequest.constraints.allowedFiles)
    : null;
  const blockLimit = Math.min(
    Math.max(0, input.changeRequest.governance.budget.maxSourceBlocks),
    MAX_GATEWAY_SOURCE_BLOCKS,
  );
  const characterLimit = Math.min(
    Math.max(0, input.changeRequest.governance.budget.maxSourceCharacters),
    MAX_GATEWAY_SOURCE_CHARACTERS,
  );
  const sourceContext: SourceContextBlock[] = [];
  let sourceCharacters = 0;
  let redactions = 0;
  let omissions = 0;

  for (const block of withoutSourceContent(input.changeRequest.sourceContext)) {
    if (
      (allowedFiles && !allowedFiles.has(block.sourceId)) ||
      (!targetSourceIds.has(block.sourceId) &&
        !approvedSourceIds.has(block.sourceId)) ||
      sourceContext.length >= blockLimit
    ) {
      omissions += 1;
      continue;
    }
    try {
      const range = sourceRangeFor(block);
      const result = readSource({
        sourceId: block.sourceId,
        ...(range ? { range } : {}),
      });
      const redacted = redactSensitiveText(result.content);
      const remaining = characterLimit - sourceCharacters;
      if (remaining <= 0) {
        omissions += 1;
        continue;
      }
      const content = redacted.text.slice(0, remaining);
      if (content.length === 0 && redacted.text.length > 0) {
        omissions += 1;
        continue;
      }
      redactions += redacted.replacements;
      sourceContext.push({ ...block, content });
      sourceCharacters += content.length;
      if (content.length < redacted.text.length) omissions += 1;
    } catch {
      omissions += 1;
    }
  }

  const diagnostics = (input.changeRequest.diagnostics ?? []).flatMap(
    (diagnostic) => {
      if (
        diagnostic.sourceId &&
        ((allowedFiles && !allowedFiles.has(diagnostic.sourceId)) ||
          (!targetSourceIds.has(diagnostic.sourceId) &&
            !approvedSourceIds.has(diagnostic.sourceId)))
      ) {
        omissions += 1;
        return [];
      }
      const redacted = redactSensitiveText(diagnostic.message);
      redactions += redacted.replacements;
      return [
        {
          ...diagnostic,
          message: redacted.text.slice(0, 500),
          ...(diagnostic.source ? { source: { ...diagnostic.source } } : {}),
        },
      ];
    },
  );

  const redactedMessage = input.changeRequest.userMessage
    ? redactSensitiveText(input.changeRequest.userMessage)
    : null;
  redactions += redactedMessage?.replacements ?? 0;
  const userMessage = redactedMessage?.text.slice(
    0,
    Math.min(
      Math.max(
        0,
        input.changeRequest.governance.budget.maxUserMessageCharacters,
      ),
      MAX_GATEWAY_USER_MESSAGE_CHARACTERS,
    ),
  );
  const changeRequest: AIChangeRequest = {
    ...input.changeRequest,
    sourceContext,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(userMessage ? { userMessage } : {}),
    governance: {
      ...input.changeRequest.governance,
      usage: {
        ...input.changeRequest.governance.usage,
        sourceBlocks: sourceContext.length,
        sourceCharacters,
        userMessageCharacters: userMessage?.length ?? 0,
      },
    },
  };
  if (diagnostics.length === 0) delete changeRequest.diagnostics;
  if (!userMessage) delete changeRequest.userMessage;
  return {
    changeRequest,
    audit: {
      sourceBlocks: sourceContext.length,
      sourceCharacters,
      redactions,
      omissions,
    },
  };
};

const aiReplyReferenceCatalog = (
  request: AIChangeRequest,
): Map<string, AIReference> => {
  const references = new Map<string, AIReference>();
  const add = (reference: AIReference): void => {
    const key = `${reference.kind}:${reference.id}`;
    if (!references.has(key)) references.set(key, reference);
  };
  for (const intent of request.intents)
    add({
      kind: "visual-intent",
      id: intent.id,
      label: `${intent.type} intent`,
    });
  for (const annotation of request.annotations)
    add({
      kind: "annotation",
      id: annotation.id,
      label: `${annotation.type} annotation`,
    });
  const sourceIds = new Set([
    ...request.sourceContext.map((source) => source.sourceId),
    ...request.targets.flatMap((target) => [
      ...(target.source?.sourceId ? [target.source.sourceId] : []),
      ...(target.inspector.sourceId ? [target.inspector.sourceId] : []),
    ]),
  ]);
  for (const sourceId of sourceIds)
    add({ kind: "file", id: sourceId, label: sourceId.slice(0, 500) });
  for (const diagnostic of request.diagnostics ?? [])
    add({
      kind: "diagnostic",
      id: diagnostic.id,
      label: `${diagnostic.severity} · ${diagnostic.code}`.slice(0, 500),
    });
  return references;
};

const referencedAIReplyItems = (
  catalog: ReadonlyMap<string, AIReference>,
  output: string,
): AIReference[] =>
  [...catalog.values()]
    .flatMap((reference) => {
      const index = output.indexOf(reference.id);
      return index < 0 ? [] : [{ reference, index }];
    })
    .sort(
      (left, right) =>
        left.index - right.index ||
        left.reference.kind.localeCompare(right.reference.kind) ||
        left.reference.id.localeCompare(right.reference.id),
    )
    .slice(0, MAX_AI_REPLY_REFERENCES)
    .map(({ reference }) => ({ ...reference }));

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

export const createAIGatewayMiddleware = (
  root: string,
  getSnapshot: () => CompilerStateSnapshot,
  accessToken: string,
  providerOrRegistry: AIProvider | AIProviderRegistry,
  now: () => number = Date.now,
  patchVerification?: AIGatewayPatchVerificationOptions,
): AIGatewayMiddleware => {
  const readSource = createProjectSourceReader(root, getSnapshot);
  const agentTools = createReadonlyAIAgentTools(root, getSnapshot);
  const proposalStore = createPatchProposalStore(root, getSnapshot, now);
  const patchApplier = patchVerification
    ? createApprovedPatchApplier(root, getSnapshot, proposalStore, { now })
    : null;
  const patchVerifier =
    patchVerification && patchApplier
      ? createPatchVerificationCoordinator(
          proposalStore,
          patchApplier,
          patchVerification.adapters,
          {
            now,
            ...(patchVerification.requiredSteps
              ? { requiredSteps: patchVerification.requiredSteps }
              : {}),
            ...(patchVerification.stepTimeoutMs
              ? { stepTimeoutMs: patchVerification.stepTimeoutMs }
              : {}),
          },
        )
      : null;
  const executions = new Map<string, ExecutionSession>();
  const screenshots = new Map<string, StoredScreenshotAsset>();
  const applyingProposalIds = new Set<string>();
  const rollingBackApplicationIds = new Set<string>();
  const verifiedProposalIds = new Set<string>();
  const verifiedApplications = new Map<string, AIPatchVerificationAudit>();
  const verifiedApplicationIdByProposal = new Map<string, string>();
  let screenshotStoreBytes = 0;
  const registry =
    providerOrRegistry instanceof AIProviderRegistry
      ? providerOrRegistry
      : new AIProviderRegistry([providerOrRegistry]);

  const approvedPatchesFor = (requestId: string): AIProviderApprovedPatch[] =>
    proposalStore
      .list(requestId)
      .filter(
        (review) =>
          review.status === "approved" &&
          !verifiedProposalIds.has(review.proposal.id),
      )
      .flatMap((review) => {
        const approval = review.decisions.find(
          (decision) => decision.decision === "approve",
        );
        return approval
          ? [
              {
                proposalId: review.proposal.id,
                approvalId: approval.id,
                requestId,
                summary: review.proposal.summary,
                affectedFiles: [...review.proposal.affectedFiles],
              },
            ]
          : [];
      });

  const evictTerminalExecutions = (): void => {
    if (executions.size < MAX_EXECUTIONS) return;
    for (const [id, session] of executions) {
      if (!session.terminal) continue;
      executions.delete(id);
      if (executions.size < MAX_EXECUTIONS) return;
    }
  };

  const storeScreenshot = (input: AIScreenshotUploadRequest): void => {
    const decoded = parseScreenshotDataUrl(input.dataUrl);
    if (
      !decoded ||
      decoded.mimeType !== input.asset.mimeType ||
      decoded.byteLength !== input.asset.byteLength ||
      decoded.byteLength > MAX_SCREENSHOT_ASSET_BYTES
    )
      throw new Error("AI screenshot upload does not match its metadata");
    const previous = screenshots.get(input.asset.id);
    if (previous) screenshotStoreBytes -= previous.asset.byteLength;
    screenshots.delete(input.asset.id);
    screenshots.set(input.asset.id, {
      asset: { ...input.asset },
      dataUrl: input.dataUrl,
    });
    screenshotStoreBytes += input.asset.byteLength;
    while (
      screenshots.size > MAX_SCREENSHOT_STORE_ENTRIES ||
      screenshotStoreBytes > MAX_SCREENSHOT_STORE_BYTES
    ) {
      const oldestId = screenshots.keys().next().value as string | undefined;
      if (!oldestId) break;
      const oldest = screenshots.get(oldestId);
      screenshots.delete(oldestId);
      screenshotStoreBytes -= oldest?.asset.byteLength ?? 0;
    }
  };

  const resolveScreenshot = async (
    asset: ScreenshotAsset,
    signal: AbortSignal,
  ): Promise<string> => {
    if (signal.aborted) {
      const error = new Error("AI execution was cancelled");
      error.name = "AbortError";
      throw error;
    }
    const stored = screenshots.get(asset.id);
    if (!stored || !screenshotMetadataMatches(stored.asset, asset))
      throw new AIProviderError(
        "AI_SCREENSHOT_ASSET_MISSING",
        `Screenshot asset ${asset.id} is unavailable or does not match its approved metadata`,
        false,
      );
    return stored.dataUrl;
  };

  const run = async (
    input: AIExecutionStartRequest,
    response: ServerResponse,
    session: ExecutionSession,
  ): Promise<void> => {
    let sequence = 0;
    const emit = (event: AIExecutionEventWithoutSchema): void => {
      response.write(
        `${JSON.stringify({
          schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
          ...event,
        })}\n`,
      );
    };
    try {
      const resolved = registry.resolve(
        input.provider,
        deriveReadonlyAIProviderRequirements(input.changeRequest, input.mode),
      );
      const assembled = assembleReadonlyProviderRequest(input, readSource);
      emit({
        type: "started",
        executionId: input.executionId,
        sequence: ++sequence,
        at: now(),
        providerId: resolved.descriptor.id,
        modelId: resolved.settings.modelId,
        negotiation: resolved.negotiation,
        mode: input.mode,
        context: assembled.audit,
      });
      let completed = false;
      let providerReferenceOutput = "";
      const agentScope = agentToolScopeFor(assembled.changeRequest);
      const approvedPatches = approvedPatchesFor(assembled.changeRequest.id);
      const patchVerificationAudits = new Map<
        string,
        AIPatchVerificationAudit
      >();
      const availableTools = resolved.negotiation.capabilities.toolCalling
        ? [
            ...READONLY_AGENT_TOOLS,
            ...(patchVerifier &&
            input.mode === "plan" &&
            approvedPatches.length > 0
              ? (["patch.applyApproved"] satisfies AIAgentToolName[])
              : []),
          ]
        : [];
      for await (const event of runAIAgentSession({
        provider: resolved.provider,
        request: {
          executionId: input.executionId,
          mode: input.mode,
          changeRequest: assembled.changeRequest,
          settings: resolved.settings,
          negotiation: resolved.negotiation,
          resolveScreenshot,
        },
        signal: session.controller.signal,
        availableTools,
        approvedPatches,
        executeTool: async (call) => {
          if (!availableTools.includes(call.name))
            return {
              schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
              callId: call.id,
              name: call.name,
              status: "failed",
              error: {
                code: "AI_AGENT_TOOL_NOT_AVAILABLE",
                message:
                  "This tool is not available before explicit user approval",
                retryable: false,
              },
            };
          if (call.name === "patch.prepare")
            try {
              const proposal = proposalStore.prepare(
                call.arguments.proposal,
                agentScope,
              );
              return completedToolResult(call, {
                proposalId: proposal.id,
                requestId: proposal.requestId,
                summary: proposal.summary,
                affectedFiles: proposal.affectedFiles,
                risk: proposal.risk,
                validationPlan: proposal.validationPlan.map((step) => ({
                  id: step.id,
                  kind: step.kind,
                  required: step.required,
                  ...(step.files ? { files: step.files } : {}),
                })),
              });
            } catch (error) {
              return failedToolResult(call, error);
            }
          if (call.name === "patch.applyApproved" && patchVerifier)
            try {
              const proposalId = call.arguments.proposalId;
              if (verifiedProposalIds.has(proposalId))
                throw new ApprovedPatchApplicationError(
                  "PATCH_ALREADY_APPLIED",
                  "The approved Patch has already been applied and verified",
                );
              if (applyingProposalIds.has(proposalId))
                throw new ApprovedPatchApplicationError(
                  "PATCH_APPLICATION_IN_PROGRESS",
                  "The approved Patch application is already in progress",
                );
              applyingProposalIds.add(proposalId);
              try {
                const verification = await patchVerifier.verify(
                  call.arguments,
                  agentScope,
                );
                const patchAudit = patchVerificationAuditFor(verification);
                if (verification.status === "verified") {
                  verifiedProposalIds.add(proposalId);
                  verifiedApplications.set(
                    patchAudit.applicationId,
                    patchAudit,
                  );
                  verifiedApplicationIdByProposal.set(
                    proposalId,
                    patchAudit.applicationId,
                  );
                }
                patchVerificationAudits.set(call.id, patchAudit);
                return completedToolResult(call, {
                  verificationId: verification.verificationId,
                  applicationId: verification.application.applicationId,
                  proposalId: verification.proposalId,
                  approvalId: verification.approvalId,
                  requestId: verification.requestId,
                  status: verification.status,
                  files: verification.application.files,
                  beforeHashes: verification.application.beforeHashes,
                  afterHashes: verification.application.afterHashes,
                  checks: verification.checks.map((check) => ({
                    step: check.step,
                    status: check.status,
                    required: check.required,
                    summary: check.summary,
                    durationMs: check.durationMs,
                    diagnostics: check.diagnostics.map((diagnostic) => ({
                      severity: diagnostic.severity,
                      message: diagnostic.message,
                      ...(diagnostic.code ? { code: diagnostic.code } : {}),
                      ...(diagnostic.sourceId
                        ? { sourceId: diagnostic.sourceId }
                        : {}),
                    })),
                  })),
                  diagnostics: verification.diagnostics.map((diagnostic) => ({
                    severity: diagnostic.severity,
                    message: diagnostic.message,
                    ...(diagnostic.code ? { code: diagnostic.code } : {}),
                    ...(diagnostic.sourceId
                      ? { sourceId: diagnostic.sourceId }
                      : {}),
                  })),
                  ...(verification.failedStep
                    ? { failedStep: verification.failedStep }
                    : {}),
                  ...(verification.rollback
                    ? {
                        rollback: {
                          rolledBack: true,
                          rolledBackAt: verification.rollback.rolledBackAt,
                          restoredHashes: verification.rollback.restoredHashes,
                        },
                      }
                    : {}),
                });
              } finally {
                applyingProposalIds.delete(proposalId);
              }
            } catch (error) {
              return failedToolResult(call, error);
            }
          return agentTools.execute(call, agentScope);
        },
      })) {
        if (event.type === "tool-result") {
          const outputCharacters =
            event.result.status === "completed"
              ? JSON.stringify(event.result.output).length
              : 0;
          emit({
            type: "tool-result",
            executionId: input.executionId,
            sequence: ++sequence,
            at: now(),
            callId: event.result.callId,
            name: event.result.name,
            status: event.result.status,
            outputCharacters,
            ...(event.result.error ? { error: { ...event.result.error } } : {}),
          });
          const patchAudit = patchVerificationAudits.get(event.result.callId);
          if (patchAudit) {
            patchVerificationAudits.delete(event.result.callId);
            emit({
              type: "patch-verification",
              executionId: input.executionId,
              sequence: ++sequence,
              at: now(),
              verification: patchAudit,
            });
          }
          continue;
        }
        if (event.type === "text-delta") {
          if (event.text.length > MAX_PROVIDER_EVENT_CHARACTERS)
            throw new AIProviderError(
              "AI_PROVIDER_EVENT_TOO_LARGE",
              "AI provider text event exceeded the size limit",
              false,
            );
          emit({
            type: "text-delta",
            executionId: input.executionId,
            sequence: ++sequence,
            at: now(),
            text: event.text,
          });
          providerReferenceOutput += event.text;
        } else if (event.type === "tool-call") {
          if (
            event.call.id.length === 0 ||
            event.call.id.length > 240 ||
            event.call.name.length === 0 ||
            event.call.name.length > 240 ||
            event.call.arguments.length > MAX_PROVIDER_EVENT_CHARACTERS
          )
            throw new AIProviderError(
              "AI_PROVIDER_EVENT_INVALID",
              "AI provider returned an invalid tool call event",
              false,
            );
          emit({
            type: "tool-call",
            executionId: input.executionId,
            sequence: ++sequence,
            at: now(),
            call: { ...event.call },
          });
        } else if (event.type === "structured-output") {
          const serialized = JSON.stringify(event.value);
          if (serialized.length > MAX_PROVIDER_EVENT_CHARACTERS)
            throw new AIProviderError(
              "AI_PROVIDER_EVENT_TOO_LARGE",
              "AI provider structured output exceeded the size limit",
              false,
            );
          emit({
            type: "structured-output",
            executionId: input.executionId,
            sequence: ++sequence,
            at: now(),
            value: JSON.parse(serialized) as typeof event.value,
          });
          providerReferenceOutput += `\n${serialized}`;
        } else {
          completed = true;
        }
      }
      if (!completed)
        throw new Error("AI provider stream ended without completion");
      for (const reference of referencedAIReplyItems(
        aiReplyReferenceCatalog(assembled.changeRequest),
        providerReferenceOutput,
      ))
        emit({
          type: "reference",
          executionId: input.executionId,
          sequence: ++sequence,
          at: now(),
          reference,
        });
      emit({
        type: "completed",
        executionId: input.executionId,
        sequence: ++sequence,
        at: now(),
        finishReason: "stop",
      });
    } catch (error) {
      if (session.controller.signal.aborted || isAbortError(error))
        emit({
          type: "cancelled",
          executionId: input.executionId,
          sequence: ++sequence,
          at: now(),
          reason: "Cancelled by user",
        });
      else
        emit({
          type: "failed",
          executionId: input.executionId,
          sequence: ++sequence,
          at: now(),
          error: {
            code:
              error instanceof AIProviderError
                ? error.code
                : "AI_PROVIDER_STREAM_FAILED",
            message: redactSensitiveText(
              error instanceof Error
                ? error.message
                : "Unknown AI provider error",
            ).text,
            retryable:
              error instanceof AIProviderError ? error.retryable : true,
          },
        });
    } finally {
      session.terminal = true;
      response.end();
    }
  };

  return (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://elfui.local");
    const isStart = url.pathname === DEVTOOLS_AI_EXECUTION_ENDPOINT;
    const isCancel = url.pathname === DEVTOOLS_AI_EXECUTION_CANCEL_ENDPOINT;
    const isCatalog = url.pathname === DEVTOOLS_AI_PROVIDER_CATALOG_ENDPOINT;
    const isPatchCatalog =
      url.pathname === DEVTOOLS_AI_PATCH_PROPOSAL_CATALOG_ENDPOINT;
    const isPatchDecision =
      url.pathname === DEVTOOLS_AI_PATCH_PROPOSAL_DECISION_ENDPOINT;
    const isPatchRollback =
      url.pathname === DEVTOOLS_AI_PATCH_ROLLBACK_ENDPOINT;
    const isScreenshotUpload =
      url.pathname === DEVTOOLS_AI_SCREENSHOT_UPLOAD_ENDPOINT;
    if (
      !isStart &&
      !isCancel &&
      !isCatalog &&
      !isPatchCatalog &&
      !isPatchDecision &&
      !isPatchRollback &&
      !isScreenshotUpload
    ) {
      next();
      return;
    }
    if (
      ((isCatalog || isPatchCatalog) && request.method !== "GET") ||
      (!isCatalog && !isPatchCatalog && request.method !== "POST")
    ) {
      send(response, 405, "Unsupported DevTools AI request method");
      return;
    }
    if (!hasAccessToken(request, accessToken)) {
      send(response, 403, "Invalid DevTools AI capability");
      return;
    }
    if (isCatalog) {
      sendJson(response, 200, registry.catalog());
      return;
    }
    if (isPatchCatalog) {
      const requestId = url.searchParams.get("requestId");
      if (!isBoundedId(requestId)) {
        send(response, 400, "Patch proposal catalog requires requestId");
        return;
      }
      sendJson(response, 200, {
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        requestId,
        proposals: proposalStore.list(requestId),
      });
      return;
    }

    void readJsonBody(
      request,
      isScreenshotUpload
        ? MAX_SCREENSHOT_UPLOAD_REQUEST_BYTES
        : MAX_EXECUTION_REQUEST_BYTES,
    )
      .then(async (body) => {
        if (isScreenshotUpload) {
          if (!isScreenshotUploadRequest(body)) {
            send(response, 400, "Invalid AI screenshot upload");
            return;
          }
          try {
            storeScreenshot(body);
          } catch (error) {
            send(
              response,
              400,
              error instanceof Error
                ? error.message
                : "Invalid AI screenshot upload",
            );
            return;
          }
          send(response, 204);
          return;
        }
        if (isPatchDecision) {
          if (!isPatchProposalDecisionRequest(body)) {
            send(response, 400, "Invalid patch proposal decision");
            return;
          }
          try {
            sendJson(response, 200, proposalStore.decide(body));
          } catch (error) {
            const statusCode =
              error instanceof PatchProposalError &&
              error.code === "PATCH_PROPOSAL_NOT_FOUND"
                ? 404
                : error instanceof PatchProposalError &&
                    (error.code === "PATCH_PROPOSAL_DECISION_CONFLICT" ||
                      error.code === "PATCH_PROPOSAL_HASH_MISMATCH")
                  ? 409
                  : 400;
            send(
              response,
              statusCode,
              redactSensitiveText(
                error instanceof Error
                  ? error.message
                  : "Patch proposal decision failed",
              ).text,
            );
          }
          return;
        }
        if (isPatchRollback) {
          if (!isPatchApplicationRollbackRequest(body)) {
            send(response, 400, "Invalid patch application rollback");
            return;
          }
          const verified = verifiedApplications.get(body.applicationId);
          if (
            !patchApplier ||
            !verified ||
            verified.verificationId !== body.verificationId ||
            verified.proposalId !== body.proposalId ||
            verified.requestId !== body.requestId ||
            verifiedApplicationIdByProposal.get(body.proposalId) !==
              body.applicationId
          ) {
            send(response, 404, "Verified patch application was not found");
            return;
          }
          if (rollingBackApplicationIds.has(body.applicationId)) {
            send(response, 409, "Patch application rollback is in progress");
            return;
          }
          rollingBackApplicationIds.add(body.applicationId);
          try {
            const rollback = await patchApplier.rollback(body.applicationId);
            verifiedProposalIds.delete(verified.proposalId);
            verifiedApplicationIdByProposal.delete(verified.proposalId);
            verifiedApplications.delete(body.applicationId);
            sendJson(response, 200, {
              schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
              applicationId: rollback.applicationId,
              verificationId: verified.verificationId,
              proposalId: rollback.proposalId,
              approvalId: rollback.approvalId,
              requestId: rollback.requestId,
              status: "rolled-back",
              reason: "user",
              files: rollback.files,
              restoredFileHashes: rollback.restoredHashes,
              rolledBackAt: rollback.rolledBackAt,
            });
          } catch (error) {
            const statusCode =
              error instanceof ApprovedPatchApplicationError &&
              error.code === "PATCH_APPLICATION_NOT_FOUND"
                ? 404
                : error instanceof ApprovedPatchApplicationError &&
                    error.code === "PATCH_SOURCE_CHANGED"
                  ? 409
                  : 400;
            send(
              response,
              statusCode,
              redactSensitiveText(
                error instanceof Error
                  ? error.message
                  : "Patch application rollback failed",
              ).text,
            );
          } finally {
            rollingBackApplicationIds.delete(body.applicationId);
          }
          return;
        }
        if (isCancel) {
          if (!isCancelRequest(body)) {
            send(response, 400, "Invalid AI cancellation request");
            return;
          }
          const session = executions.get(body.executionId);
          if (!session) {
            send(response, 404, "Unknown AI execution");
            return;
          }
          session.controller.abort();
          send(response, 202);
          return;
        }

        if (!isStartRequest(body)) {
          send(response, 400, "Invalid AI execution request");
          return;
        }
        if (executions.has(body.executionId)) {
          send(response, 409, "AI execution already exists");
          return;
        }
        if (body.retryOfExecutionId) {
          const previous = executions.get(body.retryOfExecutionId);
          if (
            !previous?.terminal ||
            previous.input.conversationId !== body.conversationId ||
            previous.input.mode !== body.mode ||
            previous.input.changeRequest.id !== body.changeRequest.id ||
            JSON.stringify(previous.input.provider ?? null) !==
              JSON.stringify(body.provider ?? null)
          ) {
            send(response, 409, "AI retry does not match a terminal execution");
            return;
          }
        }
        evictTerminalExecutions();
        if (executions.size >= MAX_EXECUTIONS) {
          send(response, 429, "Too many active AI executions");
          return;
        }
        const session: ExecutionSession = {
          input: body,
          controller: new AbortController(),
          terminal: false,
        };
        executions.set(body.executionId, session);
        response.statusCode = 200;
        response.setHeader(
          "content-type",
          "application/x-ndjson; charset=utf-8",
        );
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        response.flushHeaders?.();
        void run(body, response, session);
      })
      .catch((error: unknown) => {
        send(
          response,
          error instanceof Error &&
            error.message === "AI execution request is too large"
            ? 413
            : 400,
          error instanceof Error
            ? error.message
            : "Invalid AI execution request",
        );
      });
  };
};
