import { describe, expect, it } from "vitest";

import type { AIVisualResultReview } from "./visual-result-review";
import {
  cloneAIVisualRoundDecision,
  createAIVisualRoundDecision,
} from "./visual-round-decision";

const review = (
  statuses: Array<"unreviewed" | "met" | "partial" | "unmet">,
): AIVisualResultReview => ({
  schemaVersion: 1,
  id: "review:test",
  requestId: "request:test",
  proposalId: "proposal:test",
  applicationId: "application:test",
  verificationId: "verification:test",
  resultScreenshotId: "screenshot:result",
  createdAt: 1,
  updatedAt: 1,
  items: statuses.map((status, index) => ({
    kind: index % 2 === 0 ? "visual-intent" : "annotation",
    referenceId: `reference:${index}`,
    status,
    reviewedBy: status === "unreviewed" ? "system" : "user",
    updatedAt: 1,
  })),
});

describe("AI visual round decisions", () => {
  it("accepts a round only after every visual item is explicitly met", () => {
    expect(() =>
      createAIVisualRoundDecision(review(["met", "unmet"]), "accept"),
    ).toThrow("every review item is marked met");
    const decision = createAIVisualRoundDecision(
      review(["met", "met"]),
      "accept",
      10,
    );
    expect(decision).toMatchObject({
      id: "visual-round-decision:verification:test:accept:10",
      action: "accept",
      acceptedReferences: [
        { kind: "visual-intent", id: "reference:0", status: "met" },
        { kind: "annotation", id: "reference:1", status: "met" },
      ],
      unresolvedReferences: [],
    });
  });

  it("requires a fully reviewed mix of met and unresolved items for partial acceptance", () => {
    expect(() =>
      createAIVisualRoundDecision(
        review(["met", "unreviewed"]),
        "partial-accept",
      ),
    ).toThrow("reviewed met and unresolved");
    const decision = createAIVisualRoundDecision(
      review(["met", "partial", "unmet"]),
      "partial-accept",
      20,
    );
    expect(decision.acceptedReferences).toEqual([
      { kind: "visual-intent", id: "reference:0", status: "met" },
    ]);
    expect(decision.unresolvedReferences).toEqual([
      { kind: "annotation", id: "reference:1", status: "partial" },
      { kind: "visual-intent", id: "reference:2", status: "unmet" },
    ]);
  });

  it("records revert and regeneration without treating the reverted result as accepted", () => {
    const reverted = createAIVisualRoundDecision(
      review(["met", "unreviewed"]),
      "revert",
      30,
    );
    const regenerate = createAIVisualRoundDecision(
      review(["met", "partial"]),
      "regenerate",
      40,
    );
    expect(reverted.acceptedReferences).toEqual([]);
    expect(regenerate.unresolvedReferences).toEqual([
      { kind: "visual-intent", id: "reference:0", status: "unmet" },
      { kind: "annotation", id: "reference:1", status: "unmet" },
    ]);
    const cloned = cloneAIVisualRoundDecision(regenerate);
    cloned.unresolvedReferences[0]!.id = "mutated";
    expect(regenerate.unresolvedReferences[0]?.id).toBe("reference:0");
  });
});
