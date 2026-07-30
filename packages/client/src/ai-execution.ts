import {
  DEVTOOLS_AI_EXECUTION_CANCEL_ENDPOINT,
  DEVTOOLS_AI_EXECUTION_ENDPOINT,
  DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
  DEVTOOLS_AI_PROVIDER_CATALOG_ENDPOINT,
  DEVTOOLS_AI_PATCH_PROPOSAL_CATALOG_ENDPOINT,
  DEVTOOLS_AI_PATCH_PROPOSAL_DECISION_ENDPOINT,
  DEVTOOLS_AI_PATCH_ROLLBACK_ENDPOINT,
  DEVTOOLS_AI_SCREENSHOT_UPLOAD_ENDPOINT,
  isAIExecutionEvent,
  isPatchApplicationRollbackResult,
  isPatchProposalCatalog,
  isPatchProposalReview,
  type AIExecutionEvent,
  type AIExecutionStartRequest,
  type AIProviderCatalog,
  type PatchProposalCatalog,
  type PatchApplicationRollbackRequest,
  type PatchApplicationRollbackResult,
  type PatchProposalDecisionRequest,
  type PatchProposalReview,
} from "@elfui/devtools-ai";
import type { AIChangeRequest } from "@elfui/devtools-shared";

import type { CapturedScreenshotAsset } from "./context.js";

const MAX_EVENT_BUFFER_CHARACTERS = 64_000;

export interface AIExecutionClient {
  execute(request: AIExecutionStartRequest): AsyncIterable<AIExecutionEvent>;
  cancel(executionId: string): Promise<void>;
  listProviders?(): Promise<AIProviderCatalog>;
  listPatchProposals?(requestId: string): Promise<PatchProposalCatalog>;
  decidePatchProposal?(
    request: PatchProposalDecisionRequest,
  ): Promise<PatchProposalReview>;
  rollbackPatchApplication?(
    request: PatchApplicationRollbackRequest,
  ): Promise<PatchApplicationRollbackResult>;
  uploadScreenshots?(assets: readonly CapturedScreenshotAsset[]): Promise<void>;
}

export const withoutSourceContent = (
  request: AIChangeRequest,
): AIChangeRequest => ({
  ...request,
  sourceContext: request.sourceContext.map((block) => {
    const sanitized = { ...block };
    delete sanitized.content;
    return sanitized;
  }),
});

const errorForResponse = (action: string, response: Response): Error =>
  new Error(
    `${action} (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`,
  );

export const createAIExecutionClient = (
  accessToken: string,
  fetchImplementation: typeof fetch = globalThis.fetch,
  origin = globalThis.location?.origin ?? "http://localhost",
): AIExecutionClient => {
  const headers = {
    "content-type": "application/json",
    "x-elfui-devtools-token": accessToken,
  };
  return {
    async uploadScreenshots(assets) {
      for (const captured of assets) {
        const { dataUrl, ...asset } = captured;
        const response = await fetchImplementation(
          new URL(DEVTOOLS_AI_SCREENSHOT_UPLOAD_ENDPOINT, origin),
          {
            method: "POST",
            headers,
            cache: "no-store",
            body: JSON.stringify({
              schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
              asset,
              dataUrl,
            }),
          },
        );
        if (!response.ok)
          throw errorForResponse("Failed to upload AI screenshot", response);
      }
    },
    async listProviders() {
      const response = await fetchImplementation(
        new URL(DEVTOOLS_AI_PROVIDER_CATALOG_ENDPOINT, origin),
        {
          method: "GET",
          headers: { "x-elfui-devtools-token": accessToken },
          cache: "no-store",
        },
      );
      if (!response.ok)
        throw errorForResponse("Failed to list AI providers", response);
      const catalog = (await response.json()) as AIProviderCatalog;
      if (
        catalog.schemaVersion !== 1 ||
        typeof catalog.defaultProviderId !== "string" ||
        !Array.isArray(catalog.providers)
      )
        throw new Error("AI provider catalog response was invalid");
      return catalog;
    },
    async listPatchProposals(requestId) {
      const endpoint = new URL(
        DEVTOOLS_AI_PATCH_PROPOSAL_CATALOG_ENDPOINT,
        origin,
      );
      endpoint.searchParams.set("requestId", requestId);
      const response = await fetchImplementation(endpoint, {
        method: "GET",
        headers: { "x-elfui-devtools-token": accessToken },
        cache: "no-store",
      });
      if (!response.ok)
        throw errorForResponse("Failed to list patch proposals", response);
      const catalog = (await response.json()) as unknown;
      if (!isPatchProposalCatalog(catalog))
        throw new Error("Patch proposal catalog response was invalid");
      return catalog;
    },
    async decidePatchProposal(request) {
      const response = await fetchImplementation(
        new URL(DEVTOOLS_AI_PATCH_PROPOSAL_DECISION_ENDPOINT, origin),
        {
          method: "POST",
          headers,
          cache: "no-store",
          body: JSON.stringify(request),
        },
      );
      if (!response.ok)
        throw errorForResponse("Failed to decide patch proposal", response);
      const review = (await response.json()) as unknown;
      if (!isPatchProposalReview(review))
        throw new Error("Patch proposal decision response was invalid");
      return review;
    },
    async rollbackPatchApplication(request) {
      const response = await fetchImplementation(
        new URL(DEVTOOLS_AI_PATCH_ROLLBACK_ENDPOINT, origin),
        {
          method: "POST",
          headers,
          cache: "no-store",
          body: JSON.stringify(request),
        },
      );
      if (!response.ok)
        throw errorForResponse(
          "Failed to roll back patch application",
          response,
        );
      const rollback = (await response.json()) as unknown;
      if (!isPatchApplicationRollbackResult(rollback))
        throw new Error("Patch application rollback response was invalid");
      return rollback;
    },
    async *execute(request) {
      const response = await fetchImplementation(
        new URL(DEVTOOLS_AI_EXECUTION_ENDPOINT, origin),
        {
          method: "POST",
          headers,
          body: JSON.stringify(request),
        },
      );
      if (!response.ok)
        throw errorForResponse("Failed to start AI execution", response);
      if (!response.body)
        throw new Error("AI execution response did not include a stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastSequence = 0;
      let terminal = false;
      const parseLine = (line: string): AIExecutionEvent | null => {
        if (!line.trim()) return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          throw new Error("AI execution stream returned invalid JSON");
        }
        if (
          !isAIExecutionEvent(parsed) ||
          parsed.executionId !== request.executionId
        )
          throw new Error("AI execution stream returned an invalid event");
        if (parsed.sequence !== lastSequence + 1)
          throw new Error("AI execution stream sequence is not contiguous");
        lastSequence = parsed.sequence;
        if (
          parsed.type === "completed" ||
          parsed.type === "cancelled" ||
          parsed.type === "failed"
        )
          terminal = true;
        return parsed;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          if (buffer.length > MAX_EVENT_BUFFER_CHARACTERS)
            throw new Error("AI execution event exceeded the buffer limit");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const event = parseLine(line);
            if (event) yield event;
          }
          if (done) break;
        }
        const finalEvent = parseLine(buffer);
        if (finalEvent) yield finalEvent;
        if (!terminal)
          throw new Error("AI execution stream ended without a terminal event");
      } finally {
        reader.releaseLock();
      }
    },
    async cancel(executionId) {
      const response = await fetchImplementation(
        new URL(DEVTOOLS_AI_EXECUTION_CANCEL_ENDPOINT, origin),
        {
          method: "POST",
          headers,
          body: JSON.stringify({ executionId }),
        },
      );
      if (!response.ok)
        throw errorForResponse("Failed to cancel AI execution", response);
    },
  };
};
