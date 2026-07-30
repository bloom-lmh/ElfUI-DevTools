import type { PatchValidationKind } from "@elfui/devtools-ai";
import { redactSensitiveText } from "@elfui/devtools-shared";

import type { AIAgentToolScope } from "./agent-tools.js";
import type {
  ApprovedPatchApplicationRequest,
  ApprovedPatchApplicationResult,
  ApprovedPatchApplier,
  ApprovedPatchRollbackResult,
} from "./patch-application.js";
import type { PatchProposalStore } from "./patch-proposals.js";

export const PATCH_VERIFICATION_STEPS = [
  "format",
  "typecheck",
  "test-scoped",
  "build",
  "hmr",
  "diagnostics",
] as const;

export type PatchVerificationStep = (typeof PATCH_VERIFICATION_STEPS)[number];

export interface PatchVerificationDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
  sourceId?: string;
}

export interface PatchVerificationAdapterResult {
  ok: boolean;
  summary?: string;
  diagnostics?: PatchVerificationDiagnostic[];
}

export interface PatchVerificationContext {
  applicationId: string;
  proposalId: string;
  approvalId: string;
  requestId: string;
  files: readonly string[];
  beforeHashes: Readonly<Record<string, string>>;
  afterHashes: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

export type PatchVerificationAdapter = (
  context: PatchVerificationContext,
) => Promise<PatchVerificationAdapterResult>;

export interface PatchVerificationAdapters {
  format?: PatchVerificationAdapter;
  typecheck?: PatchVerificationAdapter;
  testScoped?: PatchVerificationAdapter;
  build?: PatchVerificationAdapter;
  hmr?: PatchVerificationAdapter;
  diagnostics?: PatchVerificationAdapter;
}

export interface PatchVerificationCheckResult {
  step: PatchVerificationStep;
  status: "passed" | "failed" | "skipped";
  required: boolean;
  summary: string;
  durationMs: number;
  diagnostics: PatchVerificationDiagnostic[];
}

export interface PatchVerificationResult {
  verificationId: string;
  proposalId: string;
  approvalId: string;
  requestId: string;
  status: "verified" | "rolled-back";
  application: ApprovedPatchApplicationResult;
  checks: PatchVerificationCheckResult[];
  diagnostics: PatchVerificationDiagnostic[];
  failedStep?: PatchVerificationStep;
  rollback?: ApprovedPatchRollbackResult;
  startedAt: number;
  completedAt: number;
}

export interface PatchVerificationCoordinator {
  verify(
    input: ApprovedPatchApplicationRequest,
    scope: AIAgentToolScope,
  ): Promise<PatchVerificationResult>;
}

export interface PatchVerificationCoordinatorOptions {
  now?: () => number;
  stepTimeoutMs?: number;
  requiredSteps?: readonly PatchVerificationStep[];
}

const DEFAULT_REQUIRED_STEPS: readonly PatchVerificationStep[] = [
  "format",
  "typecheck",
  "test-scoped",
  "hmr",
  "diagnostics",
];
const MAX_SUMMARY_CHARACTERS = 1_000;
const MAX_DIAGNOSTICS = 100;
const MAX_DIAGNOSTIC_CHARACTERS = 1_000;
const MAX_AUDITABLE_FILES = 100;
const MAX_AUDITABLE_FILE_CHARACTERS = 20_000;

const stepForValidationKind = (
  kind: PatchValidationKind,
): PatchVerificationStep =>
  kind === "test-scoped"
    ? "test-scoped"
    : kind === "runtime-diagnostics"
      ? "diagnostics"
      : kind;

const adapterForStep = (
  adapters: PatchVerificationAdapters,
  step: PatchVerificationStep,
): PatchVerificationAdapter | undefined =>
  step === "test-scoped" ? adapters.testScoped : adapters[step];

const boundedText = (value: string, limit: number): string =>
  redactSensitiveText(value).text.slice(0, limit);

const normalizeDiagnostic = (
  diagnostic: PatchVerificationDiagnostic,
): PatchVerificationDiagnostic => ({
  severity: diagnostic.severity,
  message: boundedText(String(diagnostic.message), MAX_DIAGNOSTIC_CHARACTERS),
  ...(diagnostic.code
    ? { code: boundedText(String(diagnostic.code), 200) }
    : {}),
  ...(diagnostic.sourceId
    ? { sourceId: boundedText(String(diagnostic.sourceId), 500) }
    : {}),
});

const normalizeAdapterResult = (
  result: PatchVerificationAdapterResult,
  step: PatchVerificationStep,
): PatchVerificationAdapterResult => {
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean")
    return {
      ok: false,
      summary: `Node ${step} adapter returned an invalid result`,
      diagnostics: [],
    };
  return {
    ok: result.ok,
    summary: boundedText(
      typeof result.summary === "string"
        ? result.summary
        : result.ok
          ? `${step} passed`
          : `${step} failed`,
      MAX_SUMMARY_CHARACTERS,
    ),
    diagnostics: (Array.isArray(result.diagnostics) ? result.diagnostics : [])
      .slice(0, MAX_DIAGNOSTICS)
      .filter(
        (diagnostic) =>
          diagnostic &&
          typeof diagnostic === "object" &&
          ["error", "warning", "info"].includes(diagnostic.severity),
      )
      .map(normalizeDiagnostic),
  };
};

const contextFor = (
  application: ApprovedPatchApplicationResult,
  signal: AbortSignal,
): PatchVerificationContext => ({
  applicationId: application.applicationId,
  proposalId: application.proposalId,
  approvalId: application.approvalId,
  requestId: application.requestId,
  files: [...application.files],
  beforeHashes: { ...application.beforeHashes },
  afterHashes: { ...application.afterHashes },
  signal,
});

const runAdapter = async (
  adapter: PatchVerificationAdapter,
  context: PatchVerificationContext,
  step: PatchVerificationStep,
  timeoutMs: number,
): Promise<PatchVerificationAdapterResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const combinedContext = { ...context, signal: controller.signal };
  try {
    const result = await Promise.race([
      adapter(combinedContext),
      new Promise<PatchVerificationAdapterResult>((resolve) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            resolve({
              ok: false,
              summary: `Node ${step} adapter timed out`,
              diagnostics: [],
            }),
          { once: true },
        );
      }),
    ]);
    return normalizeAdapterResult(result, step);
  } catch {
    return {
      ok: false,
      summary: `Node ${step} adapter failed without exposing private error text`,
      diagnostics: [],
    };
  } finally {
    clearTimeout(timeout);
  }
};

export const createPatchVerificationCoordinator = (
  proposals: PatchProposalStore,
  applier: ApprovedPatchApplier,
  adapters: PatchVerificationAdapters,
  options: PatchVerificationCoordinatorOptions = {},
): PatchVerificationCoordinator => {
  const now = options.now ?? Date.now;
  const timeoutMs =
    typeof options.stepTimeoutMs === "number" &&
    Number.isSafeInteger(options.stepTimeoutMs) &&
    options.stepTimeoutMs > 0
      ? options.stepTimeoutMs
      : 30_000;
  const policyRequired = new Set(
    options.requiredSteps ?? DEFAULT_REQUIRED_STEPS,
  );
  let nextVerificationId = 1;

  return {
    async verify(input, scope) {
      const startedAt = now();
      const review = proposals.getReview(input.proposalId);
      if (!review || review.proposal.requestId !== scope.requestId)
        throw new Error("Patch proposal is outside the verification scope");
      if (
        review.proposal.affectedFiles.length > MAX_AUDITABLE_FILES ||
        review.proposal.affectedFiles.reduce(
          (characters, file) => characters + file.length,
          0,
        ) > MAX_AUDITABLE_FILE_CHARACTERS
      )
        throw new Error(
          "Patch proposal exceeds the bounded verification audit scope",
        );
      const required = new Set(policyRequired);
      for (const step of review.proposal.validationPlan)
        if (step.required) required.add(stepForValidationKind(step.kind));

      let application = await applier.apply(input, scope);
      const checks: PatchVerificationCheckResult[] = [];
      const diagnostics: PatchVerificationDiagnostic[] = [];
      for (const step of PATCH_VERIFICATION_STEPS) {
        const adapter = adapterForStep(adapters, step);
        const stepStartedAt = now();
        const requiredStep = required.has(step);
        let outcome: PatchVerificationAdapterResult;
        if (!adapter)
          outcome = requiredStep
            ? {
                ok: false,
                summary: `Required Node ${step} adapter is not configured`,
                diagnostics: [],
              }
            : {
                ok: true,
                summary: `Optional ${step} check was skipped`,
                diagnostics: [],
              };
        else
          outcome = await runAdapter(
            adapter,
            contextFor(application, new AbortController().signal),
            step,
            timeoutMs,
          );

        if (step === "format")
          application = await applier.refresh(application.applicationId);
        const checkDiagnostics = outcome.diagnostics ?? [];
        diagnostics.push(...checkDiagnostics);
        const status = adapter
          ? outcome.ok
            ? "passed"
            : "failed"
          : requiredStep
            ? "failed"
            : "skipped";
        checks.push({
          step,
          status,
          required: requiredStep,
          summary: outcome.summary ?? `${step} ${status}`,
          durationMs: Math.max(0, now() - stepStartedAt),
          diagnostics: checkDiagnostics,
        });
        if (!outcome.ok) {
          const rollback = await applier.rollback(application.applicationId);
          return {
            verificationId: `verification:${nextVerificationId++}`,
            proposalId: application.proposalId,
            approvalId: application.approvalId,
            requestId: application.requestId,
            status: "rolled-back",
            application,
            checks,
            diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
            failedStep: step,
            rollback,
            startedAt,
            completedAt: now(),
          };
        }
      }

      return {
        verificationId: `verification:${nextVerificationId++}`,
        proposalId: application.proposalId,
        approvalId: application.approvalId,
        requestId: application.requestId,
        status: "verified",
        application,
        checks,
        diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
        startedAt,
        completedAt: now(),
      };
    },
  };
};
