import type { AIChangeRequest, ScreenshotAsset } from "@elfui/devtools-shared";

import type { AIReference } from "./model.js";
import {
  isAIProviderNegotiation,
  isAIProviderSelection,
} from "./provider-registry.js";
import type {
  AIProviderJSONValue,
  AIProviderNegotiation,
  AIProviderSelection,
  AIProviderToolCall,
} from "./provider.js";
import { AI_AGENT_TOOL_NAMES, type AIAgentToolName } from "./agent-protocol.js";

export const DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION = 1 as const;
export const DEVTOOLS_AI_EXECUTION_ENDPOINT =
  "/__elfui_devtools/ai-execution" as const;
export const DEVTOOLS_AI_EXECUTION_CANCEL_ENDPOINT =
  "/__elfui_devtools/ai-execution/cancel" as const;
export const DEVTOOLS_AI_SCREENSHOT_UPLOAD_ENDPOINT =
  "/__elfui_devtools/ai-screenshots" as const;

export type AIReadonlyMode = "explain" | "plan";

export interface AIExecutionStartRequest {
  schemaVersion: typeof DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION;
  executionId: string;
  conversationId: string;
  assistantMessageId: string;
  mode: AIReadonlyMode;
  changeRequest: AIChangeRequest;
  provider?: AIProviderSelection;
  retryOfExecutionId?: string;
}

export interface AIExecutionCancelRequest {
  executionId: string;
}

export interface AIScreenshotUploadRequest {
  schemaVersion: typeof DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION;
  asset: ScreenshotAsset;
  dataUrl: string;
}

interface AIExecutionEventBase {
  schemaVersion: typeof DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION;
  executionId: string;
  sequence: number;
  at: number;
}

export interface AIExecutionStartedEvent extends AIExecutionEventBase {
  type: "started";
  providerId: string;
  modelId?: string;
  negotiation?: AIProviderNegotiation;
  mode: AIReadonlyMode;
  context: {
    sourceBlocks: number;
    sourceCharacters: number;
    redactions: number;
    omissions: number;
  };
}

export interface AIExecutionTextDeltaEvent extends AIExecutionEventBase {
  type: "text-delta";
  text: string;
}

export interface AIExecutionReferenceEvent extends AIExecutionEventBase {
  type: "reference";
  reference: AIReference;
}

export interface AIExecutionToolCallEvent extends AIExecutionEventBase {
  type: "tool-call";
  call: AIProviderToolCall;
}

export interface AIExecutionToolResultEvent extends AIExecutionEventBase {
  type: "tool-result";
  callId: string;
  name: AIAgentToolName;
  status: "completed" | "failed";
  outputCharacters: number;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export const AI_PATCH_VERIFICATION_STEPS = [
  "format",
  "typecheck",
  "test-scoped",
  "build",
  "hmr",
  "diagnostics",
] as const;

export type AIPatchVerificationStep =
  (typeof AI_PATCH_VERIFICATION_STEPS)[number];

export interface AIPatchVerificationAuditFile {
  sourceId: string;
  beforeHash: string;
  afterHash: string;
  restoredHash?: string;
}

export interface AIPatchVerificationAuditCheck {
  step: AIPatchVerificationStep;
  status: "passed" | "failed" | "skipped";
  required: boolean;
  summary: string;
  durationMs: number;
}

export interface AIPatchVerificationAuditDiagnostic {
  step: AIPatchVerificationStep;
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
  sourceId?: string;
}

export interface AIPatchVerificationAudit {
  verificationId: string;
  applicationId: string;
  proposalId: string;
  approvalId: string;
  requestId: string;
  status: "verified" | "rolled-back";
  files: AIPatchVerificationAuditFile[];
  checks: AIPatchVerificationAuditCheck[];
  diagnostics: AIPatchVerificationAuditDiagnostic[];
  diagnosticsTruncated: boolean;
  failedStep?: AIPatchVerificationStep;
  appliedAt: number;
  startedAt: number;
  completedAt: number;
  rolledBackAt?: number;
}

export interface AIExecutionPatchVerificationEvent extends AIExecutionEventBase {
  type: "patch-verification";
  verification: AIPatchVerificationAudit;
}

export interface AIExecutionStructuredOutputEvent extends AIExecutionEventBase {
  type: "structured-output";
  value: AIProviderJSONValue;
}

export interface AIExecutionCompletedEvent extends AIExecutionEventBase {
  type: "completed";
  finishReason: "stop";
}

export interface AIExecutionCancelledEvent extends AIExecutionEventBase {
  type: "cancelled";
  reason: string;
}

export interface AIExecutionFailedEvent extends AIExecutionEventBase {
  type: "failed";
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export type AIExecutionEvent =
  | AIExecutionStartedEvent
  | AIExecutionTextDeltaEvent
  | AIExecutionReferenceEvent
  | AIExecutionToolCallEvent
  | AIExecutionToolResultEvent
  | AIExecutionPatchVerificationEvent
  | AIExecutionStructuredOutputEvent
  | AIExecutionCompletedEvent
  | AIExecutionCancelledEvent
  | AIExecutionFailedEvent;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const isJSONValue = (value: unknown, depth = 0): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 20) return false;
  if (Array.isArray(value))
    return value.every((item) => isJSONValue(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJSONValue(item, depth + 1));
};

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_PATCH_AUDIT_FILES = 100;
const MAX_PATCH_AUDIT_FILE_CHARACTERS = 20_000;
const MAX_PATCH_AUDIT_DIAGNOSTICS = 20;

const isBoundedString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

const isPatchVerificationStep = (
  value: unknown,
): value is AIPatchVerificationStep =>
  typeof value === "string" &&
  AI_PATCH_VERIFICATION_STEPS.includes(value as AIPatchVerificationStep);

const isPatchVerificationDiagnostic = (
  value: unknown,
): value is AIPatchVerificationAuditDiagnostic =>
  isRecord(value) &&
  hasOnlyKeys(value, ["step", "severity", "message", "code", "sourceId"]) &&
  isPatchVerificationStep(value.step) &&
  (value.severity === "error" ||
    value.severity === "warning" ||
    value.severity === "info") &&
  isBoundedString(value.message, 500) &&
  (value.code === undefined || isBoundedString(value.code, 100)) &&
  (value.sourceId === undefined || isBoundedString(value.sourceId, 4_096));

const isPatchVerificationAudit = (
  value: unknown,
): value is AIPatchVerificationAudit => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "verificationId",
      "applicationId",
      "proposalId",
      "approvalId",
      "requestId",
      "status",
      "files",
      "checks",
      "diagnostics",
      "diagnosticsTruncated",
      "failedStep",
      "appliedAt",
      "startedAt",
      "completedAt",
      "rolledBackAt",
    ]) ||
    !isBoundedString(value.verificationId, 240) ||
    !isBoundedString(value.applicationId, 240) ||
    !isBoundedString(value.proposalId, 240) ||
    !isBoundedString(value.approvalId, 240) ||
    !isBoundedString(value.requestId, 240) ||
    (value.status !== "verified" && value.status !== "rolled-back") ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > MAX_PATCH_AUDIT_FILES ||
    value.files.reduce(
      (characters, file) =>
        characters +
        (isRecord(file) && typeof file.sourceId === "string"
          ? file.sourceId.length
          : 0),
      0,
    ) > MAX_PATCH_AUDIT_FILE_CHARACTERS ||
    !value.files.every(
      (file) =>
        isRecord(file) &&
        hasOnlyKeys(file, [
          "sourceId",
          "beforeHash",
          "afterHash",
          "restoredHash",
        ]) &&
        isBoundedString(file.sourceId, 4_096) &&
        typeof file.beforeHash === "string" &&
        HASH_PATTERN.test(file.beforeHash) &&
        typeof file.afterHash === "string" &&
        HASH_PATTERN.test(file.afterHash) &&
        (file.restoredHash === undefined ||
          (typeof file.restoredHash === "string" &&
            HASH_PATTERN.test(file.restoredHash))),
    ) ||
    new Set(
      value.files.map((file) => (isRecord(file) ? String(file.sourceId) : "")),
    ).size !== value.files.length ||
    !Array.isArray(value.checks) ||
    value.checks.length === 0 ||
    value.checks.length > AI_PATCH_VERIFICATION_STEPS.length ||
    !value.checks.every(
      (check) =>
        isRecord(check) &&
        hasOnlyKeys(check, [
          "step",
          "status",
          "required",
          "summary",
          "durationMs",
        ]) &&
        isPatchVerificationStep(check.step) &&
        (check.status === "passed" ||
          check.status === "failed" ||
          check.status === "skipped") &&
        typeof check.required === "boolean" &&
        isBoundedString(check.summary, 1_000) &&
        Number.isFinite(check.durationMs) &&
        (check.durationMs as number) >= 0,
    ) ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > MAX_PATCH_AUDIT_DIAGNOSTICS ||
    !value.diagnostics.every(isPatchVerificationDiagnostic) ||
    typeof value.diagnosticsTruncated !== "boolean" ||
    !Number.isFinite(value.appliedAt) ||
    !Number.isFinite(value.startedAt) ||
    !Number.isFinite(value.completedAt) ||
    (value.rolledBackAt !== undefined &&
      !Number.isFinite(value.rolledBackAt)) ||
    (value.completedAt as number) < (value.startedAt as number) ||
    (value.appliedAt as number) < (value.startedAt as number) ||
    (value.appliedAt as number) > (value.completedAt as number)
  )
    return false;

  const steps = value.checks.map((check) =>
    isRecord(check) ? check.step : undefined,
  );
  const expectedPrefix = AI_PATCH_VERIFICATION_STEPS.slice(0, steps.length);
  if (!steps.every((step, index) => step === expectedPrefix[index]))
    return false;
  const failedChecks = value.checks.filter(
    (check) => isRecord(check) && check.status === "failed",
  );
  if (value.status === "verified")
    return (
      value.checks.length === AI_PATCH_VERIFICATION_STEPS.length &&
      failedChecks.length === 0 &&
      value.failedStep === undefined &&
      value.rolledBackAt === undefined &&
      value.files.every(
        (file) => isRecord(file) && file.restoredHash === undefined,
      )
    );
  return (
    isPatchVerificationStep(value.failedStep) &&
    failedChecks.length === 1 &&
    isRecord(failedChecks[0]) &&
    failedChecks[0].step === value.failedStep &&
    Number.isFinite(value.rolledBackAt) &&
    (value.rolledBackAt as number) >= (value.appliedAt as number) &&
    (value.rolledBackAt as number) <= (value.completedAt as number) &&
    value.files.every(
      (file) =>
        isRecord(file) &&
        typeof file.restoredHash === "string" &&
        HASH_PATTERN.test(file.restoredHash) &&
        file.restoredHash === file.beforeHash,
    )
  );
};

export const isAIExecutionEvent = (
  value: unknown,
): value is AIExecutionEvent => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION ||
    typeof value.executionId !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    !Number.isFinite(value.at) ||
    typeof value.type !== "string"
  )
    return false;
  switch (value.type) {
    case "started":
      return (
        typeof value.providerId === "string" &&
        (value.modelId === undefined || typeof value.modelId === "string") &&
        (value.negotiation === undefined ||
          isAIProviderNegotiation(value.negotiation)) &&
        (value.mode === "explain" || value.mode === "plan") &&
        isRecord(value.context) &&
        Number.isSafeInteger(value.context.sourceBlocks) &&
        Number.isSafeInteger(value.context.sourceCharacters) &&
        Number.isSafeInteger(value.context.redactions) &&
        Number.isSafeInteger(value.context.omissions)
      );
    case "text-delta":
      return typeof value.text === "string";
    case "reference":
      return (
        isRecord(value.reference) &&
        hasOnlyKeys(value.reference, ["kind", "id", "label"]) &&
        (value.reference.kind === "visual-intent" ||
          value.reference.kind === "annotation" ||
          value.reference.kind === "file" ||
          value.reference.kind === "diagnostic") &&
        isBoundedString(value.reference.id, 4_096) &&
        (value.reference.label === undefined ||
          isBoundedString(value.reference.label, 500))
      );
    case "tool-call":
      return (
        isRecord(value.call) &&
        typeof value.call.id === "string" &&
        value.call.id.length > 0 &&
        typeof value.call.name === "string" &&
        value.call.name.length > 0 &&
        typeof value.call.arguments === "string"
      );
    case "tool-result":
      return (
        typeof value.callId === "string" &&
        value.callId.length > 0 &&
        typeof value.name === "string" &&
        AI_AGENT_TOOL_NAMES.includes(value.name as AIAgentToolName) &&
        (value.status === "completed" || value.status === "failed") &&
        Number.isSafeInteger(value.outputCharacters) &&
        (value.outputCharacters as number) >= 0 &&
        (value.error === undefined ||
          (isRecord(value.error) &&
            typeof value.error.code === "string" &&
            typeof value.error.message === "string" &&
            typeof value.error.retryable === "boolean"))
      );
    case "patch-verification":
      return isPatchVerificationAudit(value.verification);
    case "structured-output":
      return isJSONValue(value.value);
    case "completed":
      return value.finishReason === "stop";
    case "cancelled":
      return typeof value.reason === "string";
    case "failed":
      return (
        isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string" &&
        typeof value.error.retryable === "boolean"
      );
    default:
      return false;
  }
};

export const isAIExecutionStartRequestProvider = (
  value: unknown,
): value is AIProviderSelection | undefined =>
  value === undefined || isAIProviderSelection(value);
