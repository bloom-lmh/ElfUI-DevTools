import type { AIChangeRequest } from "@elfui/devtools-shared";

import {
  AI_PROVIDER_CAPABILITIES,
  type AIProvider,
  type AIProviderCapabilities,
  type AIProviderCapability,
  type AIProviderDescriptor,
  type AIProviderModel,
  type AIProviderNegotiation,
  type AIProviderRequirements,
  type AIProviderSelection,
  type AIResolvedProviderSettings,
  AIProviderError,
  DEVTOOLS_AI_PROVIDER_CATALOG_SCHEMA_VERSION,
  type AIProviderCatalog,
} from "./provider.js";

const MAX_ID_LENGTH = 240;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_OUTPUT_TOKENS = 1_000_000;
const PUBLIC_SETTING_KEYS = new Set([
  "modelId",
  "endpoint",
  "temperature",
  "reasoning",
  "maxOutputTokens",
]);
const SELECTION_KEYS = new Set(["providerId", "settings"]);
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isBoundedId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ID_LENGTH;

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean => Object.keys(value).every((key) => allowed.has(key));

const capabilityValue = (
  capabilities: AIProviderCapabilities,
  capability: AIProviderCapability,
): boolean => {
  switch (capability) {
    case "text":
      return capabilities.text;
    case "image-input":
      return capabilities.imageInput;
    case "tool-calling":
      return capabilities.toolCalling;
    case "structured-output":
      return capabilities.structuredOutput;
    case "reasoning":
      return capabilities.reasoning;
    case "temperature":
      return capabilities.temperature;
  }
};

const capabilityLabel = (capability: AIProviderCapability): string => {
  switch (capability) {
    case "text":
      return "text generation";
    case "image-input":
      return "image input";
    case "tool-calling":
      return "tool calling";
    case "structured-output":
      return "structured output";
    case "reasoning":
      return "reasoning controls";
    case "temperature":
      return "temperature controls";
  }
};

const sanitizeCapabilities = (
  capabilities: AIProviderCapabilities,
): AIProviderCapabilities => ({
  text: capabilities.text === true,
  imageInput: capabilities.imageInput === true,
  toolCalling: capabilities.toolCalling === true,
  structuredOutput: capabilities.structuredOutput === true,
  reasoning: capabilities.reasoning === true,
  temperature: capabilities.temperature === true,
});

const sanitizeModel = (model: AIProviderModel): AIProviderModel => ({
  id: model.id,
  label: model.label,
  ...(model.description ? { description: model.description } : {}),
  ...(model.capabilities
    ? {
        capabilities: Object.fromEntries(
          Object.entries(model.capabilities).filter(
            ([key, value]) =>
              key in
                sanitizeCapabilities({
                  text: false,
                  imageInput: false,
                  toolCalling: false,
                  structuredOutput: false,
                  reasoning: false,
                  temperature: false,
                }) && typeof value === "boolean",
          ),
        ) as Partial<AIProviderCapabilities>,
      }
    : {}),
});

export const sanitizeAIProviderDescriptor = (
  descriptor: AIProviderDescriptor,
): AIProviderDescriptor => ({
  id: descriptor.id,
  label: descriptor.label,
  ...(descriptor.description ? { description: descriptor.description } : {}),
  capabilities: sanitizeCapabilities(descriptor.capabilities),
  models: descriptor.models.map(sanitizeModel),
  defaultModelId: descriptor.defaultModelId,
  ...(descriptor.allowsCustomModelId === true
    ? { allowsCustomModelId: true }
    : {}),
  ...(descriptor.allowsEndpointOverride === true
    ? { allowsEndpointOverride: true }
    : {}),
});

const validateDescriptor = (descriptor: AIProviderDescriptor): void => {
  if (!isBoundedId(descriptor.id))
    throw new AIProviderConfigurationError(
      "AI_PROVIDER_DESCRIPTOR_INVALID",
      "AI provider descriptor has an invalid id",
    );
  if (
    typeof descriptor.label !== "string" ||
    descriptor.label.length === 0 ||
    descriptor.label.length > MAX_ID_LENGTH
  )
    throw new AIProviderConfigurationError(
      "AI_PROVIDER_DESCRIPTOR_INVALID",
      `AI provider ${descriptor.id} has an invalid label`,
    );
  if (!Array.isArray(descriptor.models))
    throw new AIProviderConfigurationError(
      "AI_PROVIDER_DESCRIPTOR_INVALID",
      `AI provider ${descriptor.id} has an invalid model list`,
    );
  const modelIds = new Set<string>();
  for (const model of descriptor.models) {
    if (!isBoundedId(model.id) || modelIds.has(model.id))
      throw new AIProviderConfigurationError(
        "AI_PROVIDER_DESCRIPTOR_INVALID",
        `AI provider ${descriptor.id} has an invalid or duplicate model id`,
      );
    if (
      typeof model.label !== "string" ||
      model.label.length === 0 ||
      model.label.length > MAX_ID_LENGTH
    )
      throw new AIProviderConfigurationError(
        "AI_PROVIDER_DESCRIPTOR_INVALID",
        `AI provider ${descriptor.id} has an invalid model label`,
      );
    modelIds.add(model.id);
  }
  if (
    !isBoundedId(descriptor.defaultModelId) ||
    (!modelIds.has(descriptor.defaultModelId) &&
      descriptor.allowsCustomModelId !== true)
  )
    throw new AIProviderConfigurationError(
      "AI_PROVIDER_DESCRIPTOR_INVALID",
      `AI provider ${descriptor.id} has an invalid default model`,
    );
};

const modelCapabilities = (
  descriptor: AIProviderDescriptor,
  model: AIProviderModel | undefined,
): AIProviderCapabilities => ({
  ...descriptor.capabilities,
  ...model?.capabilities,
});

const normalizeEndpoint = (
  endpoint: unknown,
  descriptor: AIProviderDescriptor,
): string | undefined => {
  if (endpoint === undefined) return undefined;
  if (
    descriptor.allowsEndpointOverride !== true ||
    typeof endpoint !== "string" ||
    endpoint.length === 0 ||
    endpoint.length > MAX_ENDPOINT_LENGTH
  )
    throw new AIProviderConfigurationError(
      "AI_PROVIDER_SETTING_INVALID",
      `AI provider ${descriptor.id} does not allow this endpoint override`,
    );
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new AIProviderConfigurationError(
      "AI_PROVIDER_SETTING_INVALID",
      "AI provider endpoint must be a valid URL",
    );
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  )
    throw new AIProviderConfigurationError(
      "AI_PROVIDER_SETTING_INVALID",
      "AI provider endpoint must use HTTP(S) without credentials or fragments",
    );
  return parsed.toString();
};

export class AIProviderConfigurationError extends AIProviderError {
  public constructor(
    public readonly code:
      | "AI_PROVIDER_DESCRIPTOR_INVALID"
      | "AI_PROVIDER_DUPLICATE"
      | "AI_PROVIDER_NOT_FOUND"
      | "AI_PROVIDER_MODEL_NOT_FOUND"
      | "AI_PROVIDER_SETTING_INVALID"
      | "AI_PROVIDER_CAPABILITY_MISSING",
    message: string,
    public readonly negotiation?: AIProviderNegotiation,
  ) {
    super(code, message, false);
    this.name = "AIProviderConfigurationError";
  }
}

export const isAIProviderSelection = (
  value: unknown,
): value is AIProviderSelection => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, SELECTION_KEYS) ||
    !isBoundedId(value.providerId)
  )
    return false;
  if (value.settings === undefined) return true;
  if (
    !isRecord(value.settings) ||
    !hasOnlyKeys(value.settings, PUBLIC_SETTING_KEYS)
  )
    return false;
  const settings = value.settings;
  return (
    (settings.modelId === undefined || isBoundedId(settings.modelId)) &&
    (settings.endpoint === undefined ||
      (typeof settings.endpoint === "string" &&
        settings.endpoint.length > 0 &&
        settings.endpoint.length <= MAX_ENDPOINT_LENGTH)) &&
    (settings.temperature === undefined ||
      (typeof settings.temperature === "number" &&
        Number.isFinite(settings.temperature))) &&
    (settings.reasoning === undefined ||
      (typeof settings.reasoning === "string" &&
        REASONING_EFFORTS.has(settings.reasoning))) &&
    (settings.maxOutputTokens === undefined ||
      (typeof settings.maxOutputTokens === "number" &&
        Number.isSafeInteger(settings.maxOutputTokens)))
  );
};

export const deriveReadonlyAIProviderRequirements = (
  changeRequest: AIChangeRequest,
  mode: "explain" | "plan" = "explain",
): AIProviderRequirements => {
  const preferred: AIProviderCapability[] = [];
  if (changeRequest.screenshots.length > 0) preferred.push("image-input");
  if (mode === "plan") preferred.push("tool-calling", "structured-output");
  return { required: ["text"], preferred };
};

export const negotiateAIProviderCapabilities = (
  providerId: string,
  modelId: string,
  capabilities: AIProviderCapabilities,
  requirements: AIProviderRequirements,
): AIProviderNegotiation => {
  const required = [...new Set(requirements.required)];
  const preferred = [
    ...new Set(
      requirements.preferred.filter(
        (capability) => !required.includes(capability),
      ),
    ),
  ];
  const missingRequired = required.filter(
    (capability) => !capabilityValue(capabilities, capability),
  );
  const downgraded = preferred.filter(
    (capability) => !capabilityValue(capabilities, capability),
  );
  const status =
    missingRequired.length > 0
      ? "rejected"
      : downgraded.length > 0
        ? "downgraded"
        : "supported";
  return {
    status,
    providerId,
    modelId,
    capabilities: { ...capabilities },
    requirements: { required, preferred },
    missingRequired,
    downgraded,
    notices: [
      ...missingRequired.map((capability) => ({
        capability,
        severity: "error" as const,
        code: "AI_PROVIDER_CAPABILITY_MISSING" as const,
        message: `The selected model does not support required ${capabilityLabel(capability)}.`,
      })),
      ...downgraded.map((capability) => ({
        capability,
        severity: "warning" as const,
        code: "AI_PROVIDER_CAPABILITY_DOWNGRADED" as const,
        message: `The selected model does not support ${capabilityLabel(capability)}; the request will continue without it.`,
      })),
    ],
  };
};

export interface ResolvedAIProvider {
  provider: AIProvider;
  descriptor: AIProviderDescriptor;
  settings: AIResolvedProviderSettings;
  negotiation: AIProviderNegotiation;
}

export class AIProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();
  private readonly descriptors = new Map<string, AIProviderDescriptor>();
  public readonly defaultProviderId: string;

  public constructor(
    providers: readonly AIProvider[],
    defaultProviderId?: string,
  ) {
    if (providers.length === 0)
      throw new AIProviderConfigurationError(
        "AI_PROVIDER_NOT_FOUND",
        "At least one AI provider must be registered",
      );
    for (const provider of providers) {
      const descriptor = sanitizeAIProviderDescriptor(provider.descriptor);
      validateDescriptor(descriptor);
      if (this.providers.has(descriptor.id))
        throw new AIProviderConfigurationError(
          "AI_PROVIDER_DUPLICATE",
          `AI provider ${descriptor.id} is registered more than once`,
        );
      this.providers.set(descriptor.id, provider);
      this.descriptors.set(descriptor.id, descriptor);
    }
    const selectedDefault = defaultProviderId ?? providers[0]!.descriptor.id;
    if (!this.providers.has(selectedDefault))
      throw new AIProviderConfigurationError(
        "AI_PROVIDER_NOT_FOUND",
        `Default AI provider ${selectedDefault} is not registered`,
      );
    this.defaultProviderId = selectedDefault;
  }

  public listDescriptors(): AIProviderDescriptor[] {
    return [...this.descriptors.values()].map(sanitizeAIProviderDescriptor);
  }

  public catalog(): AIProviderCatalog {
    return {
      schemaVersion: DEVTOOLS_AI_PROVIDER_CATALOG_SCHEMA_VERSION,
      defaultProviderId: this.defaultProviderId,
      providers: this.listDescriptors(),
    };
  }

  public resolve(
    selection: AIProviderSelection | undefined,
    requirements: AIProviderRequirements,
  ): ResolvedAIProvider {
    const providerId = selection?.providerId ?? this.defaultProviderId;
    const provider = this.providers.get(providerId);
    const descriptor = this.descriptors.get(providerId);
    if (!provider || !descriptor)
      throw new AIProviderConfigurationError(
        "AI_PROVIDER_NOT_FOUND",
        `AI provider ${providerId} is not registered`,
      );
    const requested = selection?.settings;
    const modelId = requested?.modelId ?? descriptor.defaultModelId;
    const model = descriptor.models.find(
      (candidate) => candidate.id === modelId,
    );
    if (!model && descriptor.allowsCustomModelId !== true)
      throw new AIProviderConfigurationError(
        "AI_PROVIDER_MODEL_NOT_FOUND",
        `Model ${modelId} is not registered for AI provider ${providerId}`,
      );
    const capabilities = modelCapabilities(descriptor, model);
    if (
      requested?.temperature !== undefined &&
      (!capabilities.temperature ||
        requested.temperature < 0 ||
        requested.temperature > 2)
    )
      throw new AIProviderConfigurationError(
        "AI_PROVIDER_SETTING_INVALID",
        `Model ${modelId} does not accept this temperature setting`,
      );
    if (
      requested?.reasoning !== undefined &&
      !capabilities.reasoning &&
      requested.reasoning !== "none"
    )
      throw new AIProviderConfigurationError(
        "AI_PROVIDER_SETTING_INVALID",
        `Model ${modelId} does not support reasoning controls`,
      );
    if (
      requested?.maxOutputTokens !== undefined &&
      (requested.maxOutputTokens < 1 ||
        requested.maxOutputTokens > MAX_OUTPUT_TOKENS)
    )
      throw new AIProviderConfigurationError(
        "AI_PROVIDER_SETTING_INVALID",
        "AI provider max output tokens must be between 1 and 1000000",
      );
    const endpoint = normalizeEndpoint(requested?.endpoint, descriptor);
    const settings: AIResolvedProviderSettings = {
      modelId,
      ...(endpoint ? { endpoint } : {}),
      ...(requested?.temperature !== undefined
        ? { temperature: requested.temperature }
        : {}),
      ...(requested?.reasoning !== undefined
        ? { reasoning: requested.reasoning }
        : {}),
      ...(requested?.maxOutputTokens !== undefined
        ? { maxOutputTokens: requested.maxOutputTokens }
        : {}),
    };
    const negotiation = negotiateAIProviderCapabilities(
      providerId,
      modelId,
      capabilities,
      requirements,
    );
    if (negotiation.status === "rejected")
      throw new AIProviderConfigurationError(
        "AI_PROVIDER_CAPABILITY_MISSING",
        negotiation.notices.map((notice) => notice.message).join(" "),
        negotiation,
      );
    return { provider, descriptor, settings, negotiation };
  }
}

export const isAIProviderNegotiation = (
  value: unknown,
): value is AIProviderNegotiation => {
  if (
    !isRecord(value) ||
    (value.status !== "supported" &&
      value.status !== "downgraded" &&
      value.status !== "rejected") ||
    !isBoundedId(value.providerId) ||
    !isBoundedId(value.modelId) ||
    !isRecord(value.capabilities) ||
    !isRecord(value.requirements) ||
    !Array.isArray(value.missingRequired) ||
    !Array.isArray(value.downgraded) ||
    !Array.isArray(value.notices)
  )
    return false;
  const validCapability = (capability: unknown): boolean =>
    typeof capability === "string" &&
    AI_PROVIDER_CAPABILITIES.includes(
      capability as (typeof AI_PROVIDER_CAPABILITIES)[number],
    );
  const negotiationCapabilities = value.capabilities as Record<string, unknown>;
  return (
    AI_PROVIDER_CAPABILITIES.every((capability) => {
      const key =
        capability === "image-input"
          ? "imageInput"
          : capability === "tool-calling"
            ? "toolCalling"
            : capability === "structured-output"
              ? "structuredOutput"
              : capability;
      return typeof negotiationCapabilities[key] === "boolean";
    }) &&
    Array.isArray(value.requirements.required) &&
    value.requirements.required.every(validCapability) &&
    Array.isArray(value.requirements.preferred) &&
    value.requirements.preferred.every(validCapability) &&
    value.missingRequired.every(validCapability) &&
    value.downgraded.every(validCapability) &&
    value.notices.every(
      (notice) =>
        isRecord(notice) &&
        validCapability(notice.capability) &&
        (notice.severity === "warning" || notice.severity === "error") &&
        (notice.code === "AI_PROVIDER_CAPABILITY_DOWNGRADED" ||
          notice.code === "AI_PROVIDER_CAPABILITY_MISSING") &&
        typeof notice.message === "string",
    )
  );
};
