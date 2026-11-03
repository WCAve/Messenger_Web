export type SignalStatus = 'starting' | 'unreachable' | 'wrong_mode' | 'unlinked' | 'connecting' | 'connected';

export interface SignalState {
  status: SignalStatus;
  account?: string;
  apiVersion?: string;
  error?: string;
}

export interface Conversation {
  id: number;
  kind: 'direct' | 'group';
  title: string;
  number: string | null;
  username: string | null;
  avatar: string | null;
  members?: { key: string; name: string }[];
  lastMessageAt: number | null;
  lastMessage: { text: string; outgoing: boolean; status: string | null; authorName: string | null } | null;
  unread: number;
  archived: boolean;
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

  conversationId: number;
  sentAt: number;
  author: string;
  authorName: string;
  outgoing: boolean;
  kind: 'message' | 'sticker' | 'system';
  body: string | null;
  attachments: Attachment[];
  quote: { sentAt: number; author: string; authorName: string; text: string } | null;
  reactions: { emoji: string; author: string; authorName: string }[];
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | null;
  error: string | null;
  read: boolean;
  edited: boolean;
  deleted: boolean;
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
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'message'; message: Message }
  | { type: 'typing'; conversationId: number; author: string; authorName: string; started: boolean }
  | { type: 'receipt'; messageId: number };
