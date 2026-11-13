import type { PendingRequest } from './requests';
import type { FileAttachment, MessageAttachment } from './files';

export type QuestionReply = { questionItemId: string; question: string; answer: string };
export type ResponseAnnotation = { text: string; annotation: string; source?: { messageId: string; startOffset: number; endOffset: number; contentOffsets?: { startOffset: number; endOffset: number } } };
export type Message = { id: string; kind: 'user' | 'assistant' | 'reasoning' | 'tool'; text: string; phase: string | null; questions?: { title: string; options?: string[] | null }[]; questionReplies?: QuestionReply[]; attachments?: MessageAttachment[]; responseAnnotations?: ResponseAnnotation[]; requestAnnotations?: ResponseAnnotation[] };
export type Turn = { id: string; status: string; messages: Message[] };
export type Project = { id: string; name: string; path: string };
export type Thread = { id: string; title: string; projectId: string | null; cwd: string; status: string; updatedAt: number; pinned?: boolean; isUnread?: boolean | null; waitingForUser?: boolean; waitingForThread?: boolean; waitingTargets?: ThreadReference[] };
export type HistoryPage = { id: string; title: string; cwd: string; status: string; turns: Turn[]; nextCursor: string | null; hasMore: boolean };
export type EditableTurn = { turnId: string; messageId: string; prompt: string; blockedReason?: string };
export type LiveView = { available: boolean; revision?: string; turns?: Turn[]; complete?: boolean; status?: string; model?: string | null; thinking?: string | null; title?: string | null; waiting?: boolean; activeTurnId?: string | null; requests?: PendingRequest[]; editableTurn?: EditableTurn | null };
export type Receipt = { requestId: string; chatId: string; status: 'sending' | 'accepted' | 'unknown'; error: string | null; result?: { threadId?: string; interruptedTurnId?: string | null; goalPauseError?: string } | null };
export type Connection = { url: string; key: string; serverId: string; desktopLocale?: string | null };
export type Skill = { name: string; path: string; description?: string; shortDescription?: string };
export type ThreadReference = { id: string; title: string };
export type TurnOptions = { model?: string; thinking?: string; skills?: Pick<Skill, 'name' | 'path'>[]; attachments?: FileAttachment[]; threadRefs?: ThreadReference[] };
export type ModelChoice = { model: string; displayName: string; supportedReasoningEfforts: { reasoningEffort: string; description: string }[]; defaultReasoningEffort: string; isDefault: boolean };
