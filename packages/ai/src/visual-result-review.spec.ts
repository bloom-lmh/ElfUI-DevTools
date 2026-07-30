import { describe, expect, it } from "vitest";

import type { AIChangeRequest } from "@elfui/devtools-shared";

import {
  countAIVisualResultReviewStatuses,
  createAIVisualResultReview,
  updateAIVisualResultReview,
} from "./visual-result-review.js";

const request: AIChangeRequest = {
  schemaVersion: 1,
  id: "request:review",
  conversationId: "conversation:review",
  project: { framework: "elfui" },
  page: {
    url: "http://localhost/",
    route: "/",
    title: "Review fixture",
    viewport: { width: 1280, height: 720 },
    devicePixelRatio: 1,
    scroll: { x: 0, y: 0 },
  },
  targets: [],
  intents: [
    {
      id: "intent:style",
      type: "style",
      targetId: "target:card",
      before: { opacity: "0" },
      desired: { opacity: "1" },
    },
  ],
  annotations: [
    {
      id: "annotation:comment",
      type: "comment",
      targetIds: ["target:card"],
      text: "Keep the title visible",
      createdAt: 9,
    },
    {
      id: "annotation:redaction",
      type: "redaction",
      targetIds: [],
      geometry: { x: 0, y: 0, width: 20, height: 20 },
      createdAt: 9,
    },
  ],
  screenshots: [],
  sourceContext: [],
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
      userMessageCharacters: 0,
    },
    approvedSourceIds: [],
    pendingSourceApprovals: [],
    redactions: [],
    omissions: [],
    userMessageTruncated: false,
  },
};

const createReview = () =>
  createAIVisualResultReview(
    {
      request,
      proposalId: "proposal:review",
      applicationId: "application:review",
      verificationId: "verification:review",
      resultScreenshotId: "screenshot:result",
    },
    20,
  );

describe("AI visual result review", () => {
  it("creates an unreviewed item for each intent and non-redaction annotation", () => {
    const review = createReview();

    expect(review).toMatchObject({
      requestId: request.id,
      proposalId: "proposal:review",
      resultScreenshotId: "screenshot:result",
      createdAt: 20,
      updatedAt: 20,
    });
    expect(review.items).toEqual([
      {
        kind: "visual-intent",
        referenceId: "intent:style",
        status: "unreviewed",
        reviewedBy: "system",
        updatedAt: 20,
      },
      {
        kind: "annotation",
        referenceId: "annotation:comment",
        status: "unreviewed",
        reviewedBy: "system",
        updatedAt: 20,
      },
    ]);
    expect(countAIVisualResultReviewStatuses(review)).toEqual({
      unreviewed: 2,
      met: 0,
      partial: 0,
      unmet: 0,
    });
  });

  it("updates one stable reference immutably", () => {
    const review = createReview();
    const updated = updateAIVisualResultReview(
      review,
      { kind: "visual-intent", referenceId: "intent:style" },
      "unmet",
      30,
    );

    expect(review.items[0]?.status).toBe("unreviewed");
    expect(updated.items[0]).toMatchObject({
      status: "unmet",
      reviewedBy: "user",
      updatedAt: 30,
    });
    expect(countAIVisualResultReviewStatuses(updated)).toEqual({
      unreviewed: 1,
      met: 0,
      partial: 0,
      unmet: 1,
    });
  });

  it("rejects references outside the captured request", () => {
    expect(() =>
      updateAIVisualResultReview(
        createReview(),
        { kind: "annotation", referenceId: "annotation:foreign" },
        "partial",
      ),
    ).toThrow("Unknown visual result review reference");
  });
});
