/**
 * Slash commands in the message box: type "/" at the start of a message for the list (Composer in
 * Chat.tsx shows it, filtered as you type). "//" at the start sends a message that starts with "/".
 *
 *   text that gets sent   /shrug /tableflip /unflip /lenny /me /mock /spoiler
 *   making things         /gif /sticker /poll /file
 *   this chat             /mute /unmute /pin /unpin /archive /unarchive /unread /timer /search /export /info
 *
 * A command either gives text to send (with the usual formatting markers: *italic*, ||spoiler||) or does
 * something through `CommandContext`, which the composer provides.
 */
import type { Conversation } from './types';

export interface CommandContext {
  conversation: Conversation;
  /** Your name on this chat's network (for /me) */
  myName: () => Promise<string>;
  openGif: (query: string) => void;
  openStickers: () => void;
  openFiles: () => void;
  openPoll: () => void;
  createPoll: (question: string, options: string[]) => Promise<void>;
  setFlags: (f: { pinned?: boolean; archived?: boolean; mutedUntil?: number }) => Promise<void>;
  markUnread: () => Promise<void>;
  setTimer: (seconds: number) => Promise<void>;
  openSearch: (query: string) => void;
  openExport: () => void;
  openInfo: () => void;
}

/**
 * What running a command comes to: text to send (as if typed, so *bold* etc. work), plus `literal` text
 * added after it exactly as it is (faces like ¯\_(ツ)_/¯ have characters that would turn into formatting);
 * or done (an action); or a problem to show.
 */
export type CommandResult = { send: string; literal?: string } | { done: true } | { error: string };

export interface Command {
  name: string;
  args?: string; // shown after the name in the list, e.g. "[text]"
  description: string;
  /** Not offered in chats where it can't work */
  available?: (c: Conversation) => boolean;
  /** Needs something after the name (Enter first completes "/name " instead of running it) */
  needsArgs?: boolean;
  run: (arg: string, ctx: CommandContext) => CommandResult | Promise<CommandResult>;
}

const FOREVER = 8.64e15;

/** "8h", "1w", "30m", "2d", "45s" → milliseconds (null when it isn't a duration). */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)\s*(s|sec|m|min|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase()[0];
  const ms = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000, w: 7 * 86400_000 }[unit as 's' | 'm' | 'h' | 'd' | 'w'];
  return n > 0 ? n * ms : null;
}

/** SpongeBob mocking text: letters randomly upper or lower case, never more than two the same in a row. */
export function mock(text: string, random = Math.random): string {
  let run = 0;
  let upper = random() < 0.5;
  let out = '';
  for (const ch of text) {
    if (ch.toLowerCase() === ch.toUpperCase()) {
      out += ch; // not a letter
      continue;
    }
    let next = random() < 0.5;
    if (next === upper) run++;
    else run = 1;
    if (run > 2) (next = !next), (run = 1);
    upper = next;
    out += next ? ch.toUpperCase() : ch.toLowerCase();
  }
  return out;
}

/**
 * WhatsApp has no spoilers, but it folds long messages behind "Read more": a warning, then blank lines and
 * a long run of invisible characters, then the text, puts the text behind the fold (also in quotes).
 */
export function waSpoiler(text: string): string {
  return `⚠️ Spoiler (tap "Read more")\n\n\n${'​'.repeat(4000)}${text}`;
}

const withText = (face: string) => (arg: string) => ({ send: arg.trim(), literal: face });
const notWa = (c: Conversation) => c.network !== 'whatsapp';

export const COMMANDS: Command[] = [
  // ---- text that gets sent
  { name: 'shrug', args: '[text]', description: 'Adds ¯\\_(ツ)_/¯', run: withText('¯\\_(ツ)_/¯') },
  { name: 'tableflip', args: '[text]', description: 'Adds (╯°□°)╯︵ ┻━┻', run: withText('(╯°□°)╯︵ ┻━┻') },
  { name: 'unflip', args: '[text]', description: 'Adds ┬─┬ノ( º _ ºノ)', run: withText('┬─┬ノ( º _ ºノ)') },
  { name: 'lenny', args: '[text]', description: 'Adds ( ͡° ͜ʖ ͡°)', run: withText('( ͡° ͜ʖ ͡°)') },
  {
    name: 'me',
    args: 'does something',
    description: 'Sends “Your name does something” in italics',
    needsArgs: true,
    run: async (arg, ctx) => ({ send: `_${(await ctx.myName()).replace(/[*_~`|]/g, '')} ${arg.trim()}_` }),
  },
  { name: 'mock', args: 'text', description: 'sEnDs It LiKe ThIs', needsArgs: true, run: (arg) => ({ send: mock(arg.trim()) }) },
  {
    name: 'spoiler',
    args: 'text',
    description: 'Hidden until tapped (WhatsApp: behind “Read more”)',
    needsArgs: true,
    run: (arg, ctx) => ({ send: ctx.conversation.network === 'whatsapp' ? waSpoiler(arg.trim()) : `||${arg.trim()}||` }),
  },
  // ---- making things
  { name: 'gif', args: '[search]', description: 'Search for a GIF', run: (arg, ctx) => (ctx.openGif(arg.trim()), { done: true }) },
  { name: 'sticker', description: 'Open the stickers', run: (_a, ctx) => (ctx.openStickers(), { done: true }) },
  {
    name: 'poll',
    args: '[question | option | option …]',
    description: 'Make a poll (without anything after it: the poll window)',
    run: async (arg, ctx) => {
      if (!arg.trim()) return ctx.openPoll(), { done: true };
      const [question, ...options] = arg.split('|').map((s) => s.trim());
      const opts = options.filter(Boolean);
      if (!question || opts.length < 2) return { error: 'Like this: /poll Where shall we eat? | Pizza | Sushi' };
      await ctx.createPoll(question, opts);
      return { done: true };
    },
  },
  { name: 'file', description: 'Attach a file', run: (_a, ctx) => (ctx.openFiles(), { done: true }) },
  // ---- this chat
  {
    name: 'mute',
    args: '[8h | 1w | always]',
    description: 'Mute this chat (without anything after it: always)',
    run: async (arg, ctx) => {
      const a = arg.trim().toLowerCase();
      const ms = !a || a === 'always' || a === 'forever' ? 0 : parseDuration(a);
      if (ms === null) return { error: 'Like this: /mute 8h, /mute 1w or /mute always' };
      await ctx.setFlags({ mutedUntil: ms ? Date.now() + ms : FOREVER });
      return { done: true };
    },
  },
  { name: 'unmute', description: 'Unmute this chat', run: async (_a, ctx) => (await ctx.setFlags({ mutedUntil: 0 }), { done: true }) },
  { name: 'pin', description: 'Pin this chat', run: async (_a, ctx) => (await ctx.setFlags({ pinned: true }), { done: true }) },
  { name: 'unpin', description: 'Unpin this chat', run: async (_a, ctx) => (await ctx.setFlags({ pinned: false }), { done: true }) },
  { name: 'archive', description: 'Archive this chat', run: async (_a, ctx) => (await ctx.setFlags({ archived: true }), { done: true }) },
  { name: 'unarchive', description: 'Move this chat out of the archive', run: async (_a, ctx) => (await ctx.setFlags({ archived: false }), { done: true }) },
  { name: 'unread', description: 'Mark this chat as unread', run: async (_a, ctx) => (await ctx.markUnread(), { done: true }) },
  {
    name: 'timer',
    args: '30s | 5m | 1h | 8h | 1d | 1w | 4w',
    description: 'Disappearing messages',
    available: notWa,
    needsArgs: true,
    run: async (arg, ctx) => {
      const a = arg.trim().toLowerCase();
      if (a === 'off' || a === '0') return { error: 'Signal can’t switch disappearing messages off from here; use your phone' };
      const ms = parseDuration(a);
      if (!ms || ms > 365 * 86400_000) return { error: 'Like this: /timer 1h, /timer 1d or /timer 1w' };
      await ctx.setTimer(Math.round(ms / 1000));
      return { done: true };
    },
  },
  { name: 'search', args: '[word]', description: 'Search this chat', run: (arg, ctx) => (ctx.openSearch(arg.trim()), { done: true }) },
  { name: 'export', description: 'Export this chat', run: (_a, ctx) => (ctx.openExport(), { done: true }) },
  { name: 'info', description: 'Chat info', run: (_a, ctx) => (ctx.openInfo(), { done: true }) },
];

/** "/gif cats" → the command and "cats"; null when the text isn't a command ("//…", or no "/"). */
export function parseCommand(text: string): { name: string; arg: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!m || text.startsWith('//')) return null;
  return { name: m[1].toLowerCase(), arg: m[2] ?? '' };
}

/** The commands for this chat that start with what's typed. */
export function matchCommands(typed: string, c: Conversation): Command[] {
  const t = typed.toLowerCase();
  return COMMANDS.filter((x) => (!x.available || x.available(c)) && x.name.startsWith(t));
}

export function findCommand(name: string, c: Conversation): Command | undefined {
  return COMMANDS.find((x) => x.name === name && (!x.available || x.available(c)));
}
