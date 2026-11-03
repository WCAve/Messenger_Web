/** Opening a chat at a particular message (search results, quotes outside the loaded history). */
import { api } from './api';
import { getState, replaceMessages, setState } from './store';

const PAGE = 50;

export async function jumpToMessage(conversationId: number, sentAt: number) {
  const list = getState().messages[conversationId];
  if (!list?.some((m) => m.sentAt === sentAt)) {
    const r = await api.messagesAround(conversationId, sentAt, 60);
    replaceMessages(conversationId, r.messages, { hasMore: r.hasOlder, hasNewer: r.hasNewer });
  }
  setState({ activeId: conversationId, focus: { conversationId, sentAt, nonce: Date.now() } });
}

/** Back to the newest messages after looking at an older stretch. */
export async function loadLatest(conversationId: number) {
  const list = await api.messages(conversationId, undefined, PAGE);
  replaceMessages(conversationId, list, { hasMore: list.length === PAGE, hasNewer: false });
}
