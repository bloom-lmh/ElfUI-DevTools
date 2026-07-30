import type { AIVisualResultReview } from "./visual-result-review.js";

export const DEVTOOLS_AI_VISUAL_ROUND_DECISION_SCHEMA_VERSION = 1 as const;

export const AI_VISUAL_ROUND_DECISION_ACTIONS = [
  "accept",
  "partial-accept",
  "revert",
  "regenerate",
] as const;

export type AIVisualRoundDecisionAction =
  (typeof AI_VISUAL_ROUND_DECISION_ACTIONS)[number];

export interface AIVisualRoundDecisionReference {
  kind: "visual-intent" | "annotation";
  id: string;
  status: "met" | "partial" | "unmet";
}

export interface AIVisualRoundDecision {
  schemaVersion: typeof DEVTOOLS_AI_VISUAL_ROUND_DECISION_SCHEMA_VERSION;
  id: string;
  action: AIVisualRoundDecisionAction;
  reviewId: string;
  requestId: string;
  proposalId: string;
  applicationId: string;
  verificationId: string;
  resultScreenshotId: string;
  acceptedReferences: AIVisualRoundDecisionReference[];
  unresolvedReferences: AIVisualRoundDecisionReference[];
  createdAt: number;
}

const cloneReference = (
  reference: AIVisualRoundDecisionReference,
): AIVisualRoundDecisionReference => ({ ...reference });

export const cloneAIVisualRoundDecision = (
  decision: AIVisualRoundDecision,
): AIVisualRoundDecision => ({
  ...decision,
  acceptedReferences: decision.acceptedReferences.map(cloneReference),
  unresolvedReferences: decision.unresolvedReferences.map(cloneReference),
});

export const createAIVisualRoundDecision = (
  review: AIVisualResultReview,
  action: AIVisualRoundDecisionAction,
  now = Date.now(),
): AIVisualRoundDecision => {
  const unreviewed = review.items.filter(
    (item) => item.status === "unreviewed",
  );
  const acceptedReferences = review.items.flatMap((item) =>
    item.status === "met"
      ? [
          {
            kind: item.kind,
            id: item.referenceId,
            status: item.status,
          } satisfies AIVisualRoundDecisionReference,
        ]
      : [],
  );
  const unresolvedReferences = review.items.flatMap((item) =>
    item.status === "partial" || item.status === "unmet"
      ? [
          {
            kind: item.kind,
            id: item.referenceId,
            status: item.status,
          } satisfies AIVisualRoundDecisionReference,
        ]
      : [],
  );

  if (
    action === "accept" &&
    (unreviewed.length > 0 || unresolvedReferences.length > 0)
  )
    throw new Error(
      "A visual round can only be accepted after every review item is marked met",
    );
  if (
    action === "partial-accept" &&
    (unreviewed.length > 0 ||
      acceptedReferences.length === 0 ||
      unresolvedReferences.length === 0)
  )
    throw new Error(
      "Partial acceptance requires reviewed met and unresolved visual items",
    );

  const decisionUnresolved =
    action === "regenerate"
      ? review.items.map(
          (item) =>
            ({
              kind: item.kind,
              id: item.referenceId,
              status: "unmet",
            }) satisfies AIVisualRoundDecisionReference,
        )
      : unresolvedReferences;
  return {
    schemaVersion: DEVTOOLS_AI_VISUAL_ROUND_DECISION_SCHEMA_VERSION,
    id: `visual-round-decision:${review.verificationId}:${action}:${now}`,
    action,
    reviewId: review.id,
    requestId: review.requestId,
    proposalId: review.proposalId,
    applicationId: review.applicationId,
    verificationId: review.verificationId,
    resultScreenshotId: review.resultScreenshotId,
    acceptedReferences:
      action === "revert" || action === "regenerate" ? [] : acceptedReferences,
    unresolvedReferences: decisionUnresolved,
    createdAt: now,
  };
};
