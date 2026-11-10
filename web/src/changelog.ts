/**
 * What's new, newest first, shown in a popup after an update (WhatsNew.tsx) and under ⋮ → What's new.
 * Every change people will notice gets a line here, in plain words, in the same commit as the change.
 * `id` must be unique and only ever grow (a date, with -2, -3 … for a second entry that day): the
 * popup shows every entry newer than the last one this browser has seen.
 */
export interface ChangelogEntry {
  id: string;
  date: string; // shown as is
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: '2026-11-10',
    date: '10 November 2026',
    items: [
      'Ctrl+F (⌘F on a Mac) searches the open chat, or the chat list when no chat is open. Esc clears, then closes; Ctrl+F again in the search box is the browser’s own find.',
      'Deleted messages can be seen again: click “This message was deleted” → Show, for what others delete on Signal and WhatsApp (from now on). Disappearing messages now say “This message disappeared” and can be opened the same way. What you delete yourself is gone.',
      'WhatsApp no longer makes chats you’ve already read unread again: old messages it hands over a second time stay read (on your phone too). “Mark as unread” works as before.',
      'Step through a chat’s photos and videos in the viewer: ← → keys, the ‹ › buttons, or swipe on a phone. Shows “3 of 12”; closing takes the chat to the photo you ended on.',
      'WhatsApp messages that came in while the app or WhatsApp was restarting are now fetched by themselves once WhatsApp is back.',
      'Check WhatsApp for missed messages: the ↻ button next to the chat filters (also in the ⋮ menu). Read or unread, as on your phone.',
    ],
  },
  {
    id: '2026-11-09',
    date: '9 November 2026',
    items: [
      'Two + buttons at the top of the chat list: one for a new Signal chat or group, one for WhatsApp.',
      'What’s new: this window, after every update. See it again any time under ⋮ → What’s new.',
      'Filter the chat list: All, Signal or WhatsApp, with the unread count for each. Your choice is remembered.',
      'Mark all as read, in the ⋮ menu: every chat on both networks at once.',
      'Edit history: click “edited” on a message to see its earlier versions (kept from now on, on both networks).',
      'Replies to a sticker or photo show it (a small picture and “Sticker” or “Photo”) instead of just “Attachment”. Also for replies you already had.',
      'Safer sign-in: the limit on wrong passwords can no longer be dodged.',
      'Steadier server: one slow browser tab or one unexpected error no longer affects everyone.',
    ],
  },
  {
    id: '2026-11-06',
    date: '6 November 2026',
    items: [
      'Groups on Signal and WhatsApp: make new groups, add and remove people, admins, who may send or edit, invite links, join requests, leaving.',
      'WhatsApp member labels next to names, on messages too. Older labels come in with the Android backup (“Import member labels only”).',
      'Settings is now a short list with a page per topic.',
      'The unread count shows inside the tab icon, like WhatsApp. Muted chats don’t count.',
      'Videos and photos sent in HD no longer show up twice.',
      'Mentions show the person’s name instead of a long number.',
    ],
  },
  {
    id: '2026-11-05-2',
    date: '5 November 2026',
    items: [
      'One sticker picker for every chat, and a sticker manager to make your own packs from WhatsApp stickers.',
      'Notifications show the chat’s picture.',
      'WhatsApp: online and last seen, your WhatsApp profile, adding contacts, archive sync with your phone.',
      'Replies to old WhatsApp messages work (as a quote when WhatsApp no longer has the original).',
      'Go to date: jump to any day in a chat.',
    ],
  },
  {
    id: '2026-11-05',
    date: '5 November 2026',
    items: [
      'WhatsApp next to Signal, in one list.',
      'Full WhatsApp history from an Android backup, with photos from the phone’s media folder.',
      '“Recording audio…”, mark as unread, call lines, number check, pinned chats from your phone, view-once, forwarding, blocking.',
      'Emoji styles to choose from, and your most-used emoji first.',
    ],
  },
  {
    id: '2026-11-03',
    date: '3 November 2026',
    items: [
      'The first version: Signal in the browser, with stickers, GIFs, reactions, editing, disappearing messages, polls, formatting, link previews, mentions and search.',
    ],
  },
];

const SEEN_KEY = 'sw-changelog-seen';

/** Entries this browser hasn't seen. A browser that has never seen any starts at the newest (no history dump). */
export function unseenChanges(): ChangelogEntry[] {
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(SEEN_KEY);
  } catch {
    return [];
  }
  if (!seen) {
    markChangesSeen();
    return [];
  }
  return CHANGELOG.filter((e) => e.id > seen!);
}

export function markChangesSeen() {
  try {
    if (CHANGELOG[0]) localStorage.setItem(SEEN_KEY, CHANGELOG[0].id);
  } catch {
    /* private window: shown again next time, that's fine */
  }
}
