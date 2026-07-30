import type { AIChangeRequest } from "@elfui/devtools-shared";

export const DEVTOOLS_AI_VISUAL_RESULT_REVIEW_SCHEMA_VERSION = 1 as const;

export const AI_VISUAL_RESULT_REVIEW_STATUSES = [
  "unreviewed",
  "met",
  "partial",
  "unmet",
] as const;

export type AIVisualResultReviewStatus =
  (typeof AI_VISUAL_RESULT_REVIEW_STATUSES)[number];

export type AIVisualResultReviewReferenceKind = "visual-intent" | "annotation";

export interface AIVisualResultReviewItem {
  kind: AIVisualResultReviewReferenceKind;
  referenceId: string;
  status: AIVisualResultReviewStatus;
  reviewedBy: "system" | "user";
  updatedAt: number;
}

export interface AIVisualResultReview {
  schemaVersion: typeof DEVTOOLS_AI_VISUAL_RESULT_REVIEW_SCHEMA_VERSION;
  id: string;
  requestId: string;
  proposalId: string;
  applicationId: string;
  verificationId: string;
  resultScreenshotId: string;
  createdAt: number;
  updatedAt: number;
  items: AIVisualResultReviewItem[];
}

export interface CreateAIVisualResultReviewInput {
  request: AIChangeRequest;
  proposalId: string;
  applicationId: string;
  verificationId: string;
  resultScreenshotId: string;
}

export type AIVisualResultReviewCounts = Record<
  AIVisualResultReviewStatus,
  number
>;

const cloneItem = (
  item: AIVisualResultReviewItem,
): AIVisualResultReviewItem => ({ ...item });

export const cloneAIVisualResultReview = (
  review: AIVisualResultReview,
): AIVisualResultReview => ({
  ...review,
  items: review.items.map(cloneItem),
});

export const createAIVisualResultReview = (
  input: CreateAIVisualResultReviewInput,
  now = Date.now(),
): AIVisualResultReview => {
  const items: AIVisualResultReviewItem[] = [
    ...input.request.intents.map((intent) => ({
      kind: "visual-intent" as const,
      referenceId: intent.id,
      status: "unreviewed" as const,
      reviewedBy: "system" as const,
      updatedAt: now,
    })),
    ...input.request.annotations
      .filter((annotation) => annotation.type !== "redaction")
      .map((annotation) => ({
        kind: "annotation" as const,
        referenceId: annotation.id,
        status: "unreviewed" as const,
        reviewedBy: "system" as const,
        updatedAt: now,
      })),
  ];
  return {
    schemaVersion: DEVTOOLS_AI_VISUAL_RESULT_REVIEW_SCHEMA_VERSION,
    id: `visual-result-review:${input.verificationId}:${input.resultScreenshotId}`,
    requestId: input.request.id,
    proposalId: input.proposalId,
    applicationId: input.applicationId,
    verificationId: input.verificationId,
    resultScreenshotId: input.resultScreenshotId,
    createdAt: now,
    updatedAt: now,
    items,
  };
};

export const updateAIVisualResultReview = (
  review: AIVisualResultReview,
  reference: {
    kind: AIVisualResultReviewReferenceKind;
    referenceId: string;
  },
  status: AIVisualResultReviewStatus,
  now = Date.now(),
): AIVisualResultReview => {
  const index = review.items.findIndex(
    (item) =>
      item.kind === reference.kind &&
      item.referenceId === reference.referenceId,
  );
  if (index < 0)
    throw new Error(
      `Unknown visual result review reference: ${reference.kind}/${reference.referenceId}`,
    );
  const items = review.items.map((item, itemIndex) =>
    itemIndex === index
      ? {
          ...item,
          status,
          reviewedBy: "user" as const,
          updatedAt: now,
        }
      : cloneItem(item),
  );
  return {
    ...review,
    updatedAt: now,
    items,
  };
};

export const countAIVisualResultReviewStatuses = (
  review: AIVisualResultReview,
): AIVisualResultReviewCounts => {
  const counts: AIVisualResultReviewCounts = {
    unreviewed: 0,
    met: 0,
    partial: 0,
    unmet: 0,
  };
  for (const item of review.items) counts[item.status] += 1;
  return counts;
};
