export type SignalStatus = 'starting' | 'unreachable' | 'wrong_mode' | 'unlinked' | 'connecting' | 'connected' | 'disabled';

export type Network = 'signal' | 'whatsapp';

export interface BackupState {
  stage: 'idle' | 'decrypting' | 'importing' | 'media' | 'done' | 'failed';
  file?: BackupFile | null;
  progress?: { done: number; total: number; phase?: 'scan' | 'copy' };
  result?: { chats: number; messages: number; reactions: number; files: number; skipped: number; mediaFound?: number; mediaMissing?: number };
  error?: string;
}
export interface BackupFile {
  name: string;
  size: number;
  at: number;
  app?: string;
}

export interface WaState {
  status: 'disabled' | 'unreachable' | 'starting' | 'scan_qr' | 'connected' | 'failed' | 'stopped';
  me?: string;
  name?: string;
  engine?: string;
  version?: string;
  error?: string;
  importing?: boolean;
  importProgress?: { done: number; total: number; waiting?: boolean };
  lastImport?: { chats: number; messages: number; at: number; error?: string; skipped?: number };
  backup?: BackupState;
}

export interface SignalState {
  status: SignalStatus;
  account?: string;
  apiVersion?: string;
  error?: string;
}

export interface Conversation {
  id: number;
  network: Network;
  kind: 'direct' | 'group';
  title: string;
  number: string | null;
  username: string | null;
  avatar: string | null;
  members?: { key: string; name: string }[];
  lastMessageAt: number | null;
  lastMessage: { text: string; outgoing: boolean; status: string | null; authorName: string | null } | null;
  unread: number;
  markedUnread: boolean; // "Mark as unread"
  blocked: boolean;
  archived: boolean;
  expireTimer: number; // disappearing messages, seconds; 0 = off
  pinnedAt: number | null;
  mutedUntil: number; // ms; 0 = not muted
}

export interface Attachment {
  id: string;
  contentType: string;
  filename?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  voiceNote?: boolean;
  caption?: string | null;
  gif?: boolean;
  pending?: boolean; // WhatsApp history: not on the server yet, fetched when opened (can take a while)
  missing?: boolean; // WhatsApp couldn't provide it any more
}

export interface Member {
  key: string;
  name: string;
  number: string | null;
  username: string | null;
  about: string | null;
  admin: boolean;
  avatar: string | null;
}

export interface MediaItem {
  messageId: number;
  sentAt: number;
  authorName: string;
  attachment: Attachment;
}

export interface ConversationInfo extends Conversation {
  description: string | null;
  about: string | null;
  members?: Member[];
  memberCount: number;
  media: MediaItem[];
  files: MediaItem[];
  links: { messageId: number; sentAt: number; authorName: string; url: string }[];
}

export interface StickerItem {
  id: number;
  emoji: string | null;
  url: string;
}

export interface StickerPack {
  packId: string;
  title: string;
  author: string;
  installed: boolean;
  cover: StickerItem;
  stickers: StickerItem[];
}

export interface Recipient {
  key: string;
  name: string;
  avatar: string | null;
  deliveredAt: number | null;
  readAt: number | null;
}

export interface Message {
  id: number;
  rev: number; // snapshot revision; higher wins
  sticker: { packId: string; stickerId: number; emoji: string | null; url: string } | null;

  conversationId: number;
  sentAt: number;
  author: string;
  authorName: string;
  outgoing: boolean;
  kind: 'message' | 'sticker' | 'system' | 'poll';
  body: string | null;
  attachments: Attachment[];
  quote: { sentAt: number; author: string; authorName: string; text: string; unlinked?: boolean } | null;
  reactions: { emoji: string; author: string; authorName: string }[];
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | null;
  error: string | null;
  read: boolean;
  edited: boolean;
  deleted: boolean;
  forwarded?: number; // WhatsApp: 1 = forwarded, 2 = forwarded many times
  /** Ranges in UTF-16 offsets over body (which already has "@Name" for each mention). */
  styles?: StyleRange[];
  mentions?: { start: number; length: number; key: string; name: string }[];
  preview: LinkPreview | null;
  poll: Poll | null;
  expiresIn?: number; // seconds
  expiresAt?: number; // ms; unset until the countdown starts (received messages: once read)
}

export interface Poll {
  question: string;
  multiple: boolean;
  closed: boolean;
  options: { text: string; voters: { key: string; name: string }[] }[];
  mine: number[]; // indexes you voted for
  totalVoters: number;
}

export type TextStyle = 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
export interface StyleRange {
  start: number;
  length: number;
  style: TextStyle;
}

export interface LinkPreview {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: Attachment | null;
}

export interface SearchResult {
  id: number;
  conversationId: number;
  conversationTitle: string;
  group: boolean;
  sentAt: number;
  authorName: string;
  outgoing: boolean;
  snippet: string;
}

export interface WaContact {
  jid: string;
  name: string;
  number: string | null;
}

export interface DirectoryContact {
  key: string;
  uuid: string | null;
  number: string | null;
  name: string;
  username: string | null;
}

export type ServerEvent =
  | { type: 'state'; state: SignalState }
  | { type: 'wastate'; state: WaState }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'message'; message: Message }
  | { type: 'typing'; conversationId: number; author: string; authorName: string; started: boolean; recording?: boolean }
  | { type: 'receipt'; messageId: number }
  | { type: 'remove'; conversationId: number; messageId: number };
