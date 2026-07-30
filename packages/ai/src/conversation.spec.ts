import { describe, expect, it } from "vitest";

import { AIConversationStore } from "./conversation";

describe("AIConversationStore", () => {
  it("stores provider-neutral messages, attachments, and stable references", () => {
    const store = new AIConversationStore({ now: () => 10 });
    const conversation = store.createConversation({
      mode: "explain",
      title: "Menu transition",
    });
    const attachment = store.addAttachment(conversation.id, {
      kind: "image",
      referenceId: "screenshot:desired",
      name: "Desired state",
      mimeType: "image/png",
      byteLength: 2048,
    });
    const message = store.appendMessage(conversation.id, {
      role: "user",
      content: "Explain the selected menu transition.",
      attachmentIds: [attachment.id],
      references: [
        {
          kind: "visual-target",
          id: "visual-target:menu-item",
          label: "First menu item",
        },
        { kind: "visual-intent", id: "visual-intent:transition" },
      ],
    });

    expect(message).toMatchObject({
      id: "message:10:1",
      conversationId: conversation.id,
      status: "completed",
      attachmentIds: [attachment.id],
    });
    const snapshot = store.getConversation(conversation.id);
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      id: "conversation:10:1",
      mode: "explain",
      messages: [
        {
          references: [
            { id: "visual-target:menu-item" },
            { id: "visual-intent:transition" },
          ],
        },
      ],
      attachments: [{ referenceId: "screenshot:desired" }],
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain("openai");
  });

  it("bounds conversations and messages and removes orphaned attachments", () => {
    let time = 20;
    const store = new AIConversationStore({
      maxConversations: 2,
      maxMessagesPerConversation: 2,
      now: () => time++,
    });
    const first = store.createConversation({ id: "conversation:first" });
    store.createConversation({ id: "conversation:second" });
    store.createConversation({ id: "conversation:third" });
    expect(store.getConversation(first.id)).toBeNull();

    const conversation = store.getConversation("conversation:third");
    expect(conversation).not.toBeNull();
    const firstAttachment = store.addAttachment("conversation:third", {
      id: "attachment:first",
      kind: "context",
      referenceId: "ai-change:first",
    });
    store.appendMessage("conversation:third", {
      id: "message:first",
      role: "user",
      attachmentIds: [firstAttachment.id],
    });
    store.appendMessage("conversation:third", {
      id: "message:second",
      role: "assistant",
    });
    store.appendMessage("conversation:third", {
      id: "message:third",
      role: "user",
    });

    expect(
      store
        .getConversation("conversation:third")
        ?.messages.map((message) => message.id),
    ).toEqual(["message:second", "message:third"]);
    expect(store.getConversation("conversation:third")?.attachments).toEqual(
      [],
    );
  });

  it("supports streaming updates without exposing mutable store state", () => {
    let time = 40;
    const store = new AIConversationStore({ now: () => time++ });
    const conversation = store.createConversation({ mode: "plan" });
    const message = store.appendMessage(conversation.id, {
      role: "assistant",
      status: "streaming",
      content: "Move",
    });
    const updated = store.updateMessage(conversation.id, message.id, {
      appendContent: " the item into the group.",
      status: "completed",
      references: [{ kind: "source", id: "src/Menu.ts" }],
    });
    updated.references[0]!.id = "mutated";

    expect(store.getConversation(conversation.id)?.messages[0]).toMatchObject({
      content: "Move the item into the group.",
      status: "completed",
      references: [{ kind: "source", id: "src/Menu.ts" }],
    });
  });
});
