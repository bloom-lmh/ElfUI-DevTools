export const DEVTOOLS_AI_CONVERSATION_SCHEMA_VERSION = 1 as const;

export type AIConversationMode = "explain" | "plan" | "implement";

export type AIMessageRole = "user" | "assistant" | "system" | "tool";

export type AIMessageStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "cancelled"
  | "failed";

export type AIReferenceKind =
  | "visual-target"
  | "visual-intent"
  | "annotation"
  | "screenshot"
  | "source"
  | "file"
  | "diagnostic"
  | "patch-proposal";

export interface AIReference {
  kind: AIReferenceKind;
  id: string;
  label?: string;
}

export type AIAttachmentKind = "image" | "source" | "context" | "diff";

export interface AIAttachment {
  id: string;
  kind: AIAttachmentKind;
  referenceId: string;
  name?: string;
  mimeType?: string;
  byteLength?: number;
}

export interface AIMessageError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface AIMessage {
  id: string;
  conversationId: string;
  role: AIMessageRole;
  status: AIMessageStatus;
  content: string;
  createdAt: number;
  updatedAt: number;
  attachmentIds: string[];
  references: AIReference[];
  error?: AIMessageError;
}

export interface AIConversation {
  schemaVersion: typeof DEVTOOLS_AI_CONVERSATION_SCHEMA_VERSION;
  id: string;
  mode: AIConversationMode;
  title?: string;
  createdAt: number;
  updatedAt: number;
  messages: AIMessage[];
  attachments: AIAttachment[];
}
