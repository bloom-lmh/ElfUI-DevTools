import {
  DEVTOOLS_AI_CONVERSATION_SCHEMA_VERSION,
  type AIAttachment,
  type AIConversation,
  type AIConversationMode,
  type AIMessage,
  type AIMessageError,
  type AIMessageRole,
  type AIMessageStatus,
  type AIReference,
} from "./model.js";

export interface AIConversationStoreOptions {
  maxConversations?: number;
  maxMessagesPerConversation?: number;
  now?: () => number;
}

export interface CreateAIConversationInput {
  id?: string;
  mode?: AIConversationMode;
  title?: string;
}

export interface AddAIAttachmentInput extends Omit<AIAttachment, "id"> {
  id?: string;
}

export interface AppendAIMessageInput {
  id?: string;
  role: AIMessageRole;
  status?: AIMessageStatus;
  content?: string;
  attachmentIds?: string[];
  references?: AIReference[];
  error?: AIMessageError;
}

export interface UpdateAIMessageInput {
  status?: AIMessageStatus;
  content?: string;
  appendContent?: string;
  references?: AIReference[];
  error?: AIMessageError | null;
}

const positiveLimit = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

const cloneReference = (reference: AIReference): AIReference => ({
  ...reference,
});

const cloneAttachment = (attachment: AIAttachment): AIAttachment => ({
  ...attachment,
});

const cloneMessage = (message: AIMessage): AIMessage => ({
  ...message,
  attachmentIds: [...message.attachmentIds],
  references: message.references.map(cloneReference),
  ...(message.error ? { error: { ...message.error } } : {}),
});

const cloneConversation = (conversation: AIConversation): AIConversation => ({
  ...conversation,
  messages: conversation.messages.map(cloneMessage),
  attachments: conversation.attachments.map(cloneAttachment),
});

export class AIConversationStore {
  private readonly conversations = new Map<string, AIConversation>();
  private readonly maxConversations: number;
  private readonly maxMessagesPerConversation: number;
  private readonly now: () => number;
  private nextConversationId = 1;
  private nextMessageId = 1;
  private nextAttachmentId = 1;

  public constructor(options: AIConversationStoreOptions = {}) {
    this.maxConversations = positiveLimit(options.maxConversations, 20);
    this.maxMessagesPerConversation = positiveLimit(
      options.maxMessagesPerConversation,
      100,
    );
    this.now = options.now ?? Date.now;
  }

  public createConversation(
    input: CreateAIConversationInput = {},
  ): AIConversation {
    const timestamp = this.now();
    const id =
      input.id ?? `conversation:${timestamp}:${this.nextConversationId++}`;
    if (this.conversations.has(id))
      throw new Error(`Conversation already exists: ${id}`);
    const conversation: AIConversation = {
      schemaVersion: DEVTOOLS_AI_CONVERSATION_SCHEMA_VERSION,
      id,
      mode: input.mode ?? "explain",
      ...(input.title ? { title: input.title } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
      attachments: [],
    };
    this.conversations.set(id, conversation);
    while (this.conversations.size > this.maxConversations) {
      const oldest = this.conversations.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.conversations.delete(oldest);
    }
    return cloneConversation(conversation);
  }

  public addAttachment(
    conversationId: string,
    input: AddAIAttachmentInput,
  ): AIAttachment {
    const conversation = this.requireConversation(conversationId);
    const attachment: AIAttachment = {
      ...input,
      id: input.id ?? `attachment:${this.now()}:${this.nextAttachmentId++}`,
    };
    if (conversation.attachments.some((item) => item.id === attachment.id))
      throw new Error(`Attachment already exists: ${attachment.id}`);
    conversation.attachments.push(attachment);
    conversation.updatedAt = this.now();
    return cloneAttachment(attachment);
  }

  public appendMessage(
    conversationId: string,
    input: AppendAIMessageInput,
  ): AIMessage {
    const conversation = this.requireConversation(conversationId);
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    const availableAttachments = new Set(
      conversation.attachments.map((attachment) => attachment.id),
    );
    const missing = attachmentIds.find((id) => !availableAttachments.has(id));
    if (missing) throw new Error(`Unknown attachment: ${missing}`);
    const timestamp = this.now();
    const message: AIMessage = {
      id: input.id ?? `message:${timestamp}:${this.nextMessageId++}`,
      conversationId,
      role: input.role,
      status: input.status ?? "completed",
      content: input.content ?? "",
      createdAt: timestamp,
      updatedAt: timestamp,
      attachmentIds,
      references: (input.references ?? []).map(cloneReference),
      ...(input.error ? { error: { ...input.error } } : {}),
    };
    if (conversation.messages.some((item) => item.id === message.id))
      throw new Error(`Message already exists: ${message.id}`);
    conversation.messages.push(message);
    const overflow =
      conversation.messages.length - this.maxMessagesPerConversation;
    if (overflow > 0) {
      conversation.messages.splice(0, overflow);
      this.removeOrphanedAttachments(conversation);
    }
    conversation.updatedAt = timestamp;
    return cloneMessage(message);
  }

  public updateMessage(
    conversationId: string,
    messageId: string,
    input: UpdateAIMessageInput,
  ): AIMessage {
    const conversation = this.requireConversation(conversationId);
    const message = conversation.messages.find((item) => item.id === messageId);
    if (!message) throw new Error(`Unknown message: ${messageId}`);
    if (input.status) message.status = input.status;
    if (input.content !== undefined) message.content = input.content;
    if (input.appendContent) message.content += input.appendContent;
    if (input.references)
      message.references = input.references.map(cloneReference);
    if (input.error === null) delete message.error;
    else if (input.error) message.error = { ...input.error };
    const timestamp = this.now();
    message.updatedAt = timestamp;
    conversation.updatedAt = timestamp;
    return cloneMessage(message);
  }

  public getConversation(id: string): AIConversation | null {
    const conversation = this.conversations.get(id);
    return conversation ? cloneConversation(conversation) : null;
  }

  public getConversations(): AIConversation[] {
    return Array.from(this.conversations.values(), cloneConversation);
  }

  public removeConversation(id: string): boolean {
    return this.conversations.delete(id);
  }

  public clear(): void {
    this.conversations.clear();
  }

  private requireConversation(id: string): AIConversation {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new Error(`Unknown conversation: ${id}`);
    return conversation;
  }

  private removeOrphanedAttachments(conversation: AIConversation): void {
    const retained = new Set(
      conversation.messages.flatMap((message) => message.attachmentIds),
    );
    conversation.attachments = conversation.attachments.filter((attachment) =>
      retained.has(attachment.id),
    );
  }
}
