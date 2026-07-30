import type { AIProviderJSONValue } from "./provider.js";

export const DEVTOOLS_AI_AGENT_SCHEMA_VERSION = 1 as const;
export const DEVTOOLS_AI_PATCH_PROPOSAL_CATALOG_ENDPOINT =
  "/__elfui_devtools/ai-patch-proposals" as const;
export const DEVTOOLS_AI_PATCH_PROPOSAL_DECISION_ENDPOINT =
  "/__elfui_devtools/ai-patch-proposal-decision" as const;
export const DEVTOOLS_AI_PATCH_ROLLBACK_ENDPOINT =
  "/__elfui_devtools/ai-patch-rollback" as const;

export const AI_AGENT_TOOL_NAMES = [
  "project.search",
  "source.readRanges",
  "source.readFile",
  "patch.prepare",
  "patch.applyApproved",
  "checks.format",
  "checks.typecheck",
  "checks.testScoped",
  "hmr.wait",
  "diagnostics.read",
] as const;

export type AIAgentToolName = (typeof AI_AGENT_TOOL_NAMES)[number];

export interface AIAgentToolDefinition {
  name: AIAgentToolName;
  wireName: string;
  description: string;
  inputSchema: Record<string, AIProviderJSONValue>;
}

export type PatchRisk = "low" | "medium" | "high";

export type PatchValidationKind =
  | "format"
  | "typecheck"
  | "test-scoped"
  | "build"
  | "hmr"
  | "runtime-diagnostics";

export interface PatchValidationStep {
  id: string;
  kind: PatchValidationKind;
  required: boolean;
  files?: string[];
}

export interface PatchProposal {
  schemaVersion: typeof DEVTOOLS_AI_AGENT_SCHEMA_VERSION;
  id: string;
  requestId: string;
  summary: string;
  assumptions: string[];
  affectedFiles: string[];
  baseFileHashes: Record<string, string>;
  unifiedDiff: string;
  validationPlan: PatchValidationStep[];
  risk: PatchRisk;
}

export type PatchApprovalDecision = "approve" | "reject" | "revise";

export interface PatchApproval {
  schemaVersion: typeof DEVTOOLS_AI_AGENT_SCHEMA_VERSION;
  id: string;
  proposalId: string;
  requestId: string;
  decision: PatchApprovalDecision;
  approvedFiles: string[];
  approvedFileHashes: Record<string, string>;
  comment?: string;
  createdAt: number;
}

export type PatchProposalReviewStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "revision-requested";

export interface PatchProposalReview {
  schemaVersion: typeof DEVTOOLS_AI_AGENT_SCHEMA_VERSION;
  proposal: PatchProposal;
  status: PatchProposalReviewStatus;
  decisions: PatchApproval[];
  createdAt: number;
  updatedAt: number;
}

export interface PatchProposalCatalog {
  schemaVersion: typeof DEVTOOLS_AI_AGENT_SCHEMA_VERSION;
  requestId: string;
  proposals: PatchProposalReview[];
}

export interface PatchProposalDecisionRequest {
  schemaVersion: typeof DEVTOOLS_AI_AGENT_SCHEMA_VERSION;
  proposalId: string;
  requestId: string;
  decision: PatchApprovalDecision;
  comment?: string;
}

export interface PatchApplicationRollbackRequest {
  schemaVersion: typeof DEVTOOLS_AI_AGENT_SCHEMA_VERSION;
  applicationId: string;
  verificationId: string;
  proposalId: string;
  requestId: string;
}

export interface PatchApplicationRollbackResult {
  schemaVersion: typeof DEVTOOLS_AI_AGENT_SCHEMA_VERSION;
  applicationId: string;
  verificationId: string;
  proposalId: string;
  approvalId: string;
  requestId: string;
  status: "rolled-back";
  reason: "user";
  files: string[];
  restoredFileHashes: Record<string, string>;
  rolledBackAt: number;
}

interface AIAgentToolCallBase<TName extends AIAgentToolName, TArguments> {
  schemaVersion: typeof DEVTOOLS_AI_AGENT_SCHEMA_VERSION;
  id: string;
  executionId: string;
  name: TName;
  arguments: TArguments;
}

export type AIAgentToolCall =
  | AIAgentToolCallBase<
      "project.search",
      { query: string; include?: string[]; maxResults?: number }
    >
  | AIAgentToolCallBase<
      "source.readRanges",
      {
        sourceId: string;
        ranges: Array<{ startLine: number; endLine: number }>;
      }
    >
  | AIAgentToolCallBase<"source.readFile", { sourceId: string }>
  | AIAgentToolCallBase<"patch.prepare", { proposal: PatchProposal }>
  | AIAgentToolCallBase<
      "patch.applyApproved",
      { proposalId: string; approvalId: string }
    >
  | AIAgentToolCallBase<
      "checks.format" | "checks.typecheck" | "checks.testScoped",
      { proposalId: string }
    >
  | AIAgentToolCallBase<"hmr.wait", { proposalId: string; timeoutMs?: number }>
  | AIAgentToolCallBase<"diagnostics.read", { proposalId: string }>;

export interface AIAgentToolResult {
  schemaVersion: typeof DEVTOOLS_AI_AGENT_SCHEMA_VERSION;
  callId: string;
  name: AIAgentToolName;
  status: "completed" | "failed";
  output?: AIProviderJSONValue;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

const stringSchema = {
  type: "string",
  minLength: 1,
} as const;

const proposalIdSchema = {
  type: "object",
  properties: { proposalId: stringSchema },
  required: ["proposalId"],
  additionalProperties: false,
} as const;

const patchProposalSchema = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    id: stringSchema,
    requestId: stringSchema,
    summary: stringSchema,
    assumptions: {
      type: "array",
      items: stringSchema,
      maxItems: 1_000,
    },
    affectedFiles: {
      type: "array",
      items: stringSchema,
      minItems: 1,
      maxItems: 1_000,
    },
    baseFileHashes: {
      type: "object",
      additionalProperties: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
    },
    unifiedDiff: { type: "string", minLength: 1, maxLength: 2_000_000 },
    validationPlan: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          id: stringSchema,
          kind: {
            type: "string",
            enum: [
              "format",
              "typecheck",
              "test-scoped",
              "build",
              "hmr",
              "runtime-diagnostics",
            ],
          },
          required: { type: "boolean" },
          files: {
            type: "array",
            items: stringSchema,
            maxItems: 1_000,
          },
        },
        required: ["id", "kind", "required"],
        additionalProperties: false,
      },
    },
    risk: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "schemaVersion",
    "id",
    "requestId",
    "summary",
    "assumptions",
    "affectedFiles",
    "baseFileHashes",
    "unifiedDiff",
    "validationPlan",
    "risk",
  ],
  additionalProperties: false,
} as const;

export const AI_AGENT_TOOL_DEFINITIONS: readonly AIAgentToolDefinition[] = [
  {
    name: "project.search",
    wireName: "project_search",
    description:
      "Search approved text source files in the current ElfUI project. Returns bounded, redacted matches and never writes files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 4_000 },
        include: {
          type: "array",
          items: stringSchema,
          maxItems: 50,
        },
        maxResults: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "source.readRanges",
    wireName: "source_read_ranges",
    description:
      "Read approved line ranges from one source file. Paths and ranges are revalidated by the Node gateway and content is redacted.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: stringSchema,
        ranges: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              startLine: { type: "integer", minimum: 1 },
              endLine: { type: "integer", minimum: 1 },
            },
            required: ["startLine", "endLine"],
            additionalProperties: false,
          },
        },
      },
      required: ["sourceId", "ranges"],
      additionalProperties: false,
    },
  },
  {
    name: "source.readFile",
    wireName: "source_read_file",
    description:
      "Read one approved source file with its Node-computed SHA-256 hash. Content is bounded and redacted; the tool never writes files.",
    inputSchema: {
      type: "object",
      properties: { sourceId: stringSchema },
      required: ["sourceId"],
      additionalProperties: false,
    },
  },
  {
    name: "patch.prepare",
    wireName: "patch_prepare",
    description:
      "Validate and store a read-only PatchProposal for user review. The proposal must use exact approved files and current SHA-256 hashes; this does not apply the patch.",
    inputSchema: {
      type: "object",
      properties: { proposal: patchProposalSchema },
      required: ["proposal"],
      additionalProperties: false,
    },
  },
  {
    name: "patch.applyApproved",
    wireName: "patch_apply_approved",
    description:
      "Apply a previously prepared patch only when it has a still-valid explicit user approval. The Node gateway rechecks file hashes.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: stringSchema,
        approvalId: stringSchema,
      },
      required: ["proposalId", "approvalId"],
      additionalProperties: false,
    },
  },
  ...(
    [
      ["checks.format", "checks_format", "Run the approved formatter scope."],
      [
        "checks.typecheck",
        "checks_typecheck",
        "Run type checking for an approved proposal.",
      ],
      [
        "checks.testScoped",
        "checks_test_scoped",
        "Run bounded tests selected for an approved proposal.",
      ],
    ] as const
  ).map(([name, wireName, description]) => ({
    name,
    wireName,
    description,
    inputSchema: proposalIdSchema,
  })),
  {
    name: "hmr.wait",
    wireName: "hmr_wait",
    description:
      "Wait for bounded HMR completion for an approved proposal and return its status.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: stringSchema,
        timeoutMs: { type: "integer", minimum: 100, maximum: 120_000 },
      },
      required: ["proposalId"],
      additionalProperties: false,
    },
  },
  {
    name: "diagnostics.read",
    wireName: "diagnostics_read",
    description:
      "Read bounded Compiler and Runtime diagnostics for an approved proposal.",
    inputSchema: proposalIdSchema,
  },
];

const TOOL_DEFINITION_BY_NAME = new Map(
  AI_AGENT_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
);
const TOOL_NAME_BY_WIRE_NAME = new Map(
  AI_AGENT_TOOL_DEFINITIONS.map((definition) => [
    definition.wireName,
    definition.name,
  ]),
);

export const getAIAgentToolDefinition = (
  name: AIAgentToolName,
): AIAgentToolDefinition => TOOL_DEFINITION_BY_NAME.get(name)!;

export const fromAIAgentWireToolName = (
  wireName: string,
): AIAgentToolName | undefined => TOOL_NAME_BY_WIRE_NAME.get(wireName);

const MAX_ID_LENGTH = 240;
const MAX_PATH_LENGTH = 4_096;
const MAX_SUMMARY_LENGTH = 20_000;
const MAX_DIFF_LENGTH = 2_000_000;
const MAX_COMMENT_LENGTH = 20_000;
const MAX_LIST_ITEMS = 1_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VALIDATION_KINDS = new Set<PatchValidationKind>([
  "format",
  "typecheck",
  "test-scoped",
  "build",
  "hmr",
  "runtime-diagnostics",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isJSONValue = (value: unknown, depth = 0): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 20) return false;
  if (Array.isArray(value))
    return value.every((item) => isJSONValue(item, depth + 1));
  return (
    isRecord(value) &&
    Object.values(value).every((item) => isJSONValue(item, depth + 1))
  );
};

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const isBoundedString = (
  value: unknown,
  maximum = MAX_SUMMARY_LENGTH,
): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

const isId = (value: unknown): value is string =>
  isBoundedString(value, MAX_ID_LENGTH);

export const isProjectRelativePath = (value: unknown): value is string => {
  if (!isBoundedString(value, MAX_PATH_LENGTH)) return false;
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value)
  )
    return false;
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
};

const isPathList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_LIST_ITEMS &&
  value.every(isProjectRelativePath) &&
  new Set(value).size === value.length;

const isIncludeList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 50 &&
  value.every(
    (item) =>
      typeof item === "string" &&
      item.length <= MAX_ID_LENGTH &&
      isProjectRelativePath(item),
  ) &&
  new Set(value).size === value.length;

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_LIST_ITEMS &&
  value.every((item) => isBoundedString(item));

const isHashMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.keys(value).length <= MAX_LIST_ITEMS &&
  Object.entries(value).every(
    ([file, hash]) =>
      isProjectRelativePath(file) &&
      typeof hash === "string" &&
      HASH_PATTERN.test(hash),
  );

const isValidationStep = (value: unknown): value is PatchValidationStep =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "kind", "required", "files"]) &&
  isId(value.id) &&
  typeof value.kind === "string" &&
  VALIDATION_KINDS.has(value.kind as PatchValidationKind) &&
  typeof value.required === "boolean" &&
  (value.files === undefined || isPathList(value.files));

export const isPatchProposal = (value: unknown): value is PatchProposal => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "id",
      "requestId",
      "summary",
      "assumptions",
      "affectedFiles",
      "baseFileHashes",
      "unifiedDiff",
      "validationPlan",
      "risk",
    ]) ||
    value.schemaVersion !== DEVTOOLS_AI_AGENT_SCHEMA_VERSION ||
    !isId(value.id) ||
    !isId(value.requestId) ||
    !isBoundedString(value.summary) ||
    !isStringList(value.assumptions) ||
    !isPathList(value.affectedFiles) ||
    value.affectedFiles.length === 0 ||
    !isHashMap(value.baseFileHashes) ||
    typeof value.unifiedDiff !== "string" ||
    value.unifiedDiff.length === 0 ||
    value.unifiedDiff.length > MAX_DIFF_LENGTH ||
    !Array.isArray(value.validationPlan) ||
    value.validationPlan.length === 0 ||
    value.validationPlan.length > 50 ||
    !value.validationPlan.every(isValidationStep) ||
    (value.risk !== "low" && value.risk !== "medium" && value.risk !== "high")
  )
    return false;
  const affected = new Set(value.affectedFiles);
  return (
    Object.keys(value.baseFileHashes).length === affected.size &&
    Object.keys(value.baseFileHashes).every((file) => affected.has(file)) &&
    value.validationPlan.every(
      (step) => !step.files || step.files.every((file) => affected.has(file)),
    )
  );
};

export const isPatchApproval = (value: unknown): value is PatchApproval => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "id",
      "proposalId",
      "requestId",
      "decision",
      "approvedFiles",
      "approvedFileHashes",
      "comment",
      "createdAt",
    ]) ||
    value.schemaVersion !== DEVTOOLS_AI_AGENT_SCHEMA_VERSION ||
    !isId(value.id) ||
    !isId(value.proposalId) ||
    !isId(value.requestId) ||
    (value.decision !== "approve" &&
      value.decision !== "reject" &&
      value.decision !== "revise") ||
    !isPathList(value.approvedFiles) ||
    !isHashMap(value.approvedFileHashes) ||
    (value.comment !== undefined &&
      (typeof value.comment !== "string" ||
        value.comment.length > MAX_COMMENT_LENGTH)) ||
    !Number.isFinite(value.createdAt)
  )
    return false;
  if (value.decision === "approve" && value.approvedFiles.length === 0)
    return false;
  const approved = new Set(value.approvedFiles);
  return (
    Object.keys(value.approvedFileHashes).length === approved.size &&
    Object.keys(value.approvedFileHashes).every((file) => approved.has(file))
  );
};

export const isPatchProposalDecisionRequest = (
  value: unknown,
): value is PatchProposalDecisionRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "schemaVersion",
    "proposalId",
    "requestId",
    "decision",
    "comment",
  ]) &&
  value.schemaVersion === DEVTOOLS_AI_AGENT_SCHEMA_VERSION &&
  isId(value.proposalId) &&
  isId(value.requestId) &&
  (value.decision === "approve" ||
    value.decision === "reject" ||
    value.decision === "revise") &&
  (value.comment === undefined ||
    (typeof value.comment === "string" &&
      value.comment.length <= MAX_COMMENT_LENGTH)) &&
  (value.decision !== "revise" ||
    (typeof value.comment === "string" && value.comment.trim().length > 0));

export const isPatchApplicationRollbackRequest = (
  value: unknown,
): value is PatchApplicationRollbackRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "schemaVersion",
    "applicationId",
    "verificationId",
    "proposalId",
    "requestId",
  ]) &&
  value.schemaVersion === DEVTOOLS_AI_AGENT_SCHEMA_VERSION &&
  isId(value.applicationId) &&
  isId(value.verificationId) &&
  isId(value.proposalId) &&
  isId(value.requestId);

export const isPatchApplicationRollbackResult = (
  value: unknown,
): value is PatchApplicationRollbackResult => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "applicationId",
      "verificationId",
      "proposalId",
      "approvalId",
      "requestId",
      "status",
      "reason",
      "files",
      "restoredFileHashes",
      "rolledBackAt",
    ]) ||
    value.schemaVersion !== DEVTOOLS_AI_AGENT_SCHEMA_VERSION ||
    !isId(value.applicationId) ||
    !isId(value.verificationId) ||
    !isId(value.proposalId) ||
    !isId(value.approvalId) ||
    !isId(value.requestId) ||
    value.status !== "rolled-back" ||
    value.reason !== "user" ||
    !isPathList(value.files) ||
    value.files.length === 0 ||
    value.files.length > 100 ||
    value.files.reduce((characters, file) => characters + file.length, 0) >
      20_000 ||
    !isHashMap(value.restoredFileHashes) ||
    !Number.isFinite(value.rolledBackAt)
  )
    return false;
  const files = new Set(value.files);
  return (
    Object.keys(value.restoredFileHashes).length === files.size &&
    Object.keys(value.restoredFileHashes).every((file) => files.has(file))
  );
};

const isPatchProposalReviewStatus = (
  value: unknown,
): value is PatchProposalReviewStatus =>
  value === "pending" ||
  value === "approved" ||
  value === "rejected" ||
  value === "revision-requested";

export const isPatchProposalReview = (
  value: unknown,
): value is PatchProposalReview =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "schemaVersion",
    "proposal",
    "status",
    "decisions",
    "createdAt",
    "updatedAt",
  ]) &&
  value.schemaVersion === DEVTOOLS_AI_AGENT_SCHEMA_VERSION &&
  isPatchProposal(value.proposal) &&
  isPatchProposalReviewStatus(value.status) &&
  Array.isArray(value.decisions) &&
  value.decisions.length <= 50 &&
  value.decisions.every(isPatchApproval) &&
  Number.isFinite(value.createdAt) &&
  Number.isFinite(value.updatedAt) &&
  (value.updatedAt as number) >= (value.createdAt as number) &&
  ((value.status === "pending" && value.decisions.length === 0) ||
    (value.status !== "pending" &&
      value.decisions.length > 0 &&
      value.decisions.at(-1)?.decision ===
        (value.status === "revision-requested"
          ? "revise"
          : value.status === "approved"
            ? "approve"
            : "reject")));

export const isPatchProposalCatalog = (
  value: unknown,
): value is PatchProposalCatalog =>
  isRecord(value) &&
  hasOnlyKeys(value, ["schemaVersion", "requestId", "proposals"]) &&
  value.schemaVersion === DEVTOOLS_AI_AGENT_SCHEMA_VERSION &&
  isId(value.requestId) &&
  Array.isArray(value.proposals) &&
  value.proposals.length <= 50 &&
  value.proposals.every(
    (review) =>
      isPatchProposalReview(review) &&
      review.proposal.requestId === value.requestId,
  );

const isSourceId = (value: unknown): value is string =>
  isProjectRelativePath(value);

const isProposalIdArguments = (
  value: unknown,
): value is { proposalId: string } =>
  isRecord(value) &&
  hasOnlyKeys(value, ["proposalId"]) &&
  isId(value.proposalId);

export const isAIAgentToolCall = (value: unknown): value is AIAgentToolCall => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "id",
      "executionId",
      "name",
      "arguments",
    ]) ||
    value.schemaVersion !== DEVTOOLS_AI_AGENT_SCHEMA_VERSION ||
    !isId(value.id) ||
    !isId(value.executionId) ||
    typeof value.name !== "string" ||
    !AI_AGENT_TOOL_NAMES.includes(value.name as AIAgentToolName) ||
    !isRecord(value.arguments)
  )
    return false;
  const args = value.arguments;
  switch (value.name) {
    case "project.search":
      return (
        hasOnlyKeys(args, ["query", "include", "maxResults"]) &&
        isBoundedString(args.query, 4_000) &&
        (args.include === undefined || isIncludeList(args.include)) &&
        (args.maxResults === undefined ||
          (Number.isSafeInteger(args.maxResults) &&
            (args.maxResults as number) > 0 &&
            (args.maxResults as number) <= 200))
      );
    case "source.readRanges":
      return (
        hasOnlyKeys(args, ["sourceId", "ranges"]) &&
        isSourceId(args.sourceId) &&
        Array.isArray(args.ranges) &&
        args.ranges.length > 0 &&
        args.ranges.length <= 100 &&
        args.ranges.every(
          (range) =>
            isRecord(range) &&
            hasOnlyKeys(range, ["startLine", "endLine"]) &&
            Number.isSafeInteger(range.startLine) &&
            Number.isSafeInteger(range.endLine) &&
            (range.startLine as number) > 0 &&
            (range.endLine as number) >= (range.startLine as number),
        )
      );
    case "source.readFile":
      return hasOnlyKeys(args, ["sourceId"]) && isSourceId(args.sourceId);
    case "patch.prepare":
      return hasOnlyKeys(args, ["proposal"]) && isPatchProposal(args.proposal);
    case "patch.applyApproved":
      return (
        hasOnlyKeys(args, ["proposalId", "approvalId"]) &&
        isId(args.proposalId) &&
        isId(args.approvalId)
      );
    case "checks.format":
    case "checks.typecheck":
    case "checks.testScoped":
    case "diagnostics.read":
      return isProposalIdArguments(args);
    case "hmr.wait":
      return (
        hasOnlyKeys(args, ["proposalId", "timeoutMs"]) &&
        isId(args.proposalId) &&
        (args.timeoutMs === undefined ||
          (Number.isSafeInteger(args.timeoutMs) &&
            (args.timeoutMs as number) >= 100 &&
            (args.timeoutMs as number) <= 120_000))
      );
    default:
      return false;
  }
};

export const isAIAgentToolResult = (
  value: unknown,
): value is AIAgentToolResult => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "callId",
      "name",
      "status",
      "output",
      "error",
    ]) ||
    value.schemaVersion !== DEVTOOLS_AI_AGENT_SCHEMA_VERSION ||
    !isId(value.callId) ||
    typeof value.name !== "string" ||
    !AI_AGENT_TOOL_NAMES.includes(value.name as AIAgentToolName) ||
    (value.status !== "completed" && value.status !== "failed")
  )
    return false;
  if (value.status === "completed")
    return (
      value.output !== undefined &&
      isJSONValue(value.output) &&
      value.error === undefined
    );
  return (
    value.output === undefined &&
    isRecord(value.error) &&
    hasOnlyKeys(value.error, ["code", "message", "retryable"]) &&
    isId(value.error.code) &&
    isBoundedString(value.error.message) &&
    typeof value.error.retryable === "boolean"
  );
};
