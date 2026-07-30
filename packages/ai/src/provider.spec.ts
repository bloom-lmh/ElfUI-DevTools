import type { AIChangeRequest } from "@elfui/devtools-shared";
import { describe, expect, it } from "vitest";

import {
  AIProviderRegistry,
  deriveReadonlyAIProviderRequirements,
  isAIProviderSelection,
  negotiateAIProviderCapabilities,
} from "./provider-registry";
import type { AIProviderConfigurationError } from "./provider-registry";
import type {
  AIProvider,
  AIProviderCapabilities,
  AIProviderDescriptor,
} from "./provider";

const capabilities = (
  overrides: Partial<AIProviderCapabilities> = {},
): AIProviderCapabilities => ({
  text: true,
  imageInput: false,
  toolCalling: false,
  structuredOutput: false,
  reasoning: false,
  temperature: false,
  ...overrides,
});

const provider = (
  id: string,
  overrides: Partial<AIProviderDescriptor> = {},
): AIProvider => ({
  descriptor: {
    id,
    label: id,
    capabilities: capabilities(),
    models: [{ id: `${id}-default`, label: "Default" }],
    defaultModelId: `${id}-default`,
    ...overrides,
  },
  async *stream() {
    yield { type: "completed" };
  },
});

describe("AI provider registry", () => {
  it("selects providers and models without changing the change request", () => {
    const first = provider("first");
    const second = provider("second", {
      capabilities: capabilities({
        imageInput: true,
        reasoning: true,
        temperature: true,
      }),
      models: [
        { id: "second-fast", label: "Fast" },
        {
          id: "second-vision",
          label: "Vision",
          capabilities: { imageInput: true },
        },
      ],
      defaultModelId: "second-fast",
    });
    const registry = new AIProviderRegistry([first, second], "first");
    const changeRequest = {
      screenshots: [{ id: "screenshot:desired" }],
    } as AIChangeRequest;
    const requirements = deriveReadonlyAIProviderRequirements(changeRequest);
    const before = JSON.stringify(changeRequest);

    const defaultResolution = registry.resolve(undefined, requirements);
    const selectedResolution = registry.resolve(
      {
        providerId: "second",
        settings: {
          modelId: "second-vision",
          temperature: 0.4,
          reasoning: "medium",
          maxOutputTokens: 2_048,
        },
      },
      requirements,
    );

    expect(defaultResolution.negotiation.status).toBe("downgraded");
    expect(defaultResolution.negotiation.downgraded).toEqual(["image-input"]);
    expect(selectedResolution.negotiation.status).toBe("supported");
    expect(selectedResolution.settings).toEqual({
      modelId: "second-vision",
      temperature: 0.4,
      reasoning: "medium",
      maxOutputTokens: 2_048,
    });
    expect(JSON.stringify(changeRequest)).toBe(before);
  });

  it("rejects missing required capabilities with an explicit notice", () => {
    const registry = new AIProviderRegistry([
      provider("no-text", {
        capabilities: capabilities({ text: false }),
      }),
    ]);

    expect(() =>
      registry.resolve(undefined, {
        required: ["text", "tool-calling"],
        preferred: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AIProviderConfigurationError>>({
        code: "AI_PROVIDER_CAPABILITY_MISSING",
        negotiation: expect.objectContaining({
          status: "rejected",
          missingRequired: ["text", "tool-calling"],
        }),
      }),
    );
  });

  it("validates public settings and rejects secret-bearing fields", () => {
    expect(
      isAIProviderSelection({
        providerId: "openai-compatible",
        settings: {
          modelId: "model-a",
          temperature: 0.2,
          reasoning: "low",
          maxOutputTokens: 1_024,
          endpoint: "https://example.test/v1/responses",
        },
      }),
    ).toBe(true);
    expect(
      isAIProviderSelection({
        providerId: "openai-compatible",
        settings: { apiKey: "secret-value" },
      }),
    ).toBe(false);
    expect(
      isAIProviderSelection({
        providerId: "openai-compatible",
        apiKey: "secret-value",
      }),
    ).toBe(false);
  });

  it("only permits bounded settings supported by the selected provider", () => {
    const registry = new AIProviderRegistry([
      provider("configurable", {
        capabilities: capabilities({
          reasoning: true,
          temperature: true,
        }),
        allowsEndpointOverride: true,
      }),
    ]);
    expect(
      registry.resolve(
        {
          providerId: "configurable",
          settings: {
            endpoint: "https://example.test/v1/responses",
            temperature: 2,
            reasoning: "high",
            maxOutputTokens: 1_000_000,
          },
        },
        { required: ["text"], preferred: [] },
      ).settings.endpoint,
    ).toBe("https://example.test/v1/responses");

    for (const settings of [
      { temperature: 2.1 },
      { maxOutputTokens: 0 },
      { endpoint: "https://user:password@example.test/v1" },
      { endpoint: "file:///tmp/provider" },
    ])
      expect(() =>
        registry.resolve(
          { providerId: "configurable", settings },
          { required: ["text"], preferred: [] },
        ),
      ).toThrowError(
        expect.objectContaining({ code: "AI_PROVIDER_SETTING_INVALID" }),
      );
  });

  it("returns sanitized descriptor copies without provider secrets", () => {
    const unsafe = provider("safe-public");
    Object.assign(unsafe.descriptor, {
      apiKey: "secret-value",
      models: [
        {
          id: "safe-public-default",
          label: "Default",
          apiKey: "model-secret",
        },
      ],
    });
    const registry = new AIProviderRegistry([unsafe]);
    const descriptors = registry.listDescriptors();

    expect(JSON.stringify(descriptors)).not.toContain("secret");
    descriptors[0]!.label = "mutated";
    expect(registry.listDescriptors()[0]!.label).toBe("safe-public");
  });
});

describe("AI provider capability negotiation", () => {
  it("derives plan-mode agent capabilities without trusting client declarations", () => {
    const changeRequest = {
      screenshots: [{ id: "screenshot:desired" }],
    } as AIChangeRequest;

    expect(
      deriveReadonlyAIProviderRequirements(changeRequest, "explain"),
    ).toEqual({
      required: ["text"],
      preferred: ["image-input"],
    });
    expect(deriveReadonlyAIProviderRequirements(changeRequest, "plan")).toEqual(
      {
        required: ["text"],
        preferred: ["image-input", "tool-calling", "structured-output"],
      },
    );
  });

  it("deduplicates requirements and separates downgrade from rejection", () => {
    const result = negotiateAIProviderCapabilities(
      "provider",
      "model",
      capabilities(),
      {
        required: ["text", "text"],
        preferred: ["text", "image-input", "image-input"],
      },
    );

    expect(result.status).toBe("downgraded");
    expect(result.requirements).toEqual({
      required: ["text"],
      preferred: ["image-input"],
    });
    expect(result.notices).toEqual([
      expect.objectContaining({
        capability: "image-input",
        severity: "warning",
        code: "AI_PROVIDER_CAPABILITY_DOWNGRADED",
      }),
    ]);
  });
});
