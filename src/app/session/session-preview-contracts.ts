import type { ArtifactRef } from "../../agent/artifact-contracts.js";

export const SESSION_PREVIEW_PAGE_SIZE = 25;
export const MAX_SESSION_PREVIEW_MESSAGE_LENGTH = 4000;

export interface SessionPreviewInput { sessionId: string; offset: number }
export interface SessionPreviewMessage {
  id: string;
  kind: "user" | "assistant";
  createdAt: string;
  content: string;
  truncated: boolean;
  artifacts: ArtifactRef[];
}
export interface SessionPreview extends SessionPreviewInput {
  title: string;
  messages: SessionPreviewMessage[];
  total: number;
  artifacts: ArtifactRef[];
  artifactCount: number;
}
