import type { AIChangeRequest, ScreenshotAsset } from "@elfui/devtools-shared";

import type { AIReadonlyMode } from "./execution.js";
import type {
  AIAgentToolCall,
  AIAgentToolName,
  AIAgentToolResult,
} from "./agent-protocol.js";

export const DEVTOOLS_AI_PROVIDER_CATALOG_SCHEMA_VERSION = 1 as const;
export const DEVTOOLS_AI_PROVIDER_CATALOG_ENDPOINT =
  "/__elfui_devtools/ai-providers" as const;

export const AI_PROVIDER_CAPABILITIES = [
  "text",
  "image-input",
  "tool-calling",
  "structured-output",
  "reasoning",
  "temperature",
] as const;

export type AIProviderCapability = (typeof AI_PROVIDER_CAPABILITIES)[number];

export interface AIProviderCapabilities {
  text: boolean;
  imageInput: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  temperature: boolean;
}

export interface AIProviderModel {
  id: string;
  label: string;
  description?: string;
  capabilities?: Partial<AIProviderCapabilities>;
}

export interface AIProviderDescriptor {
  id: string;
  label: string;
  description?: string;
  capabilities: AIProviderCapabilities;
  models: readonly AIProviderModel[];
  defaultModelId: string;
  allowsCustomModelId?: boolean;
  allowsEndpointOverride?: boolean;
}

export interface AIProviderCatalog {
  schemaVersion: typeof DEVTOOLS_AI_PROVIDER_CATALOG_SCHEMA_VERSION;
  defaultProviderId: string;
  providers: AIProviderDescriptor[];
}

export type AIReasoningEffort = "none" | "low" | "medium" | "high";

export interface AIProviderPublicSettings {
  modelId?: string;
  endpoint?: string;
  temperature?: number;
  reasoning?: AIReasoningEffort;
  maxOutputTokens?: number;
}

export interface AIProviderSelection {
  providerId: string;
  settings?: AIProviderPublicSettings;
}

export interface AIResolvedProviderSettings extends Omit<
  AIProviderPublicSettings,
  "modelId"
> {
  modelId: string;
}

export interface AIProviderRequirements {
  required: AIProviderCapability[];
  preferred: AIProviderCapability[];
}

export interface AIProviderCapabilityNotice {
  capability: AIProviderCapability;
  severity: "warning" | "error";
  code: "AI_PROVIDER_CAPABILITY_DOWNGRADED" | "AI_PROVIDER_CAPABILITY_MISSING";
  message: string;
}

export interface AIProviderNegotiation {
  status: "supported" | "downgraded" | "rejected";
  providerId: string;
  modelId: string;
  capabilities: AIProviderCapabilities;
  requirements: AIProviderRequirements;
  missingRequired: AIProviderCapability[];
  downgraded: AIProviderCapability[];
  notices: AIProviderCapabilityNotice[];
}

export class AIProviderError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}

export interface AIProviderRequest {
  executionId: string;
  mode: AIReadonlyMode;
  changeRequest: AIChangeRequest;
  settings: AIResolvedProviderSettings;
  negotiation: AIProviderNegotiation;
  resolveScreenshot?: (
    screenshot: ScreenshotAsset,
    signal: AbortSignal,
  ) => Promise<string>;
  agent?: {
    turn: number;
    availableTools: AIAgentToolName[];
    approvedPatches?: AIProviderApprovedPatch[];
    exchanges: Array<{
      calls: AIAgentToolCall[];
      results: AIAgentToolResult[];
    }>;
  };
}

export interface AIProviderApprovedPatch {
  proposalId: string;
  approvalId: string;
  requestId: string;
  summary: string;
  affectedFiles: string[];
}

export type AIProviderJSONValue =
  | null
  | boolean
  | number
  | string
  | readonly AIProviderJSONValue[]
  | { [key: string]: AIProviderJSONValue };

export interface AIProviderToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type AIProviderEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; call: AIProviderToolCall }
  | { type: "structured-output"; value: AIProviderJSONValue }
  | { type: "completed" };

export interface AIProviderStreamOptions {
  signal: AbortSignal;
}

export interface AIProvider {
  readonly descriptor: AIProviderDescriptor;
  stream(
    request: AIProviderRequest,
    options: AIProviderStreamOptions,
  ): AsyncIterable<AIProviderEvent>;
}
