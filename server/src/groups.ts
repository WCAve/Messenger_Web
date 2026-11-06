/**
 * Group management for both networks behind one set of routes: create, join, rename, description,
 * members and admins, who may do what, the invite link, join requests, leaving, and your own member label.
 *
 * WhatsApp goes through WAHA's group endpoints. Signal goes through signal-cli-rest-api, which has a
 * few gaps: no joining by link, no new invite link, and a "who may edit the group info" value it
 * reports wrongly (it repeats the "send messages" one), so we remember what was set here.
 */
import { invalidateAvatar } from './avatars.js';
import { kvGet, kvSet } from './db.js';
import { HttpError, type Router } from './http.js';
import { type SignalLinkState, type SignalPermission, groupRecipientId, signalApi } from './signal-api.js';
import { getState as getSignalState, refreshDirectory } from './signal.js';
import {
  type ConversationRow,
  addressForKey,
  avatarUrlForKey,
  conversationDto,
  findContact,
  findWaChat,
  getConversation,
  getOrCreateGroup,
  getOrCreateWaChat,
  groupMembers,
  mergeGroupSettings,
  nameForKey,
  self,
} from './store.js';
import { type Json, type WaGroupSetting, waha } from './waha-api.js';
import { bare, dropSelfFromGroup, forgetWaAvatar, getWaState, groupChanged, keyFor, refreshWaGroupNow, resolve } from './whatsapp.js';

type Who = 'all' | 'admins';
export interface GroupSettings {
  editInfo: Who;
  sendMessages: Who;
  addMembers: Who;
  /** WhatsApp: admins approve new members. Signal: people joining through the link need approval. */
  approveMembers: boolean;
}
interface Person {
  key: string;
  name: string;
  number: string | null;
  avatar: string | null;
}
export interface GroupDetails {
  network: 'signal' | 'whatsapp';
  member: boolean;
  admin: boolean;
  canEditInfo: boolean;
  canAddMembers: boolean;
  settings: GroupSettings | null;
  /** WhatsApp: admins only. Signal: everyone, when the link is on. */
  inviteLink: string | null;
  /** Signal only: the link can be switched off. WhatsApp groups always have one. */
  linkEnabled: boolean;
  canResetLink: boolean;
  requests: Person[];
  invited: Person[];
  /** Member labels (WhatsApp): key → label. */
  labels: Record<string, string>;
  myLabel: string | null;
  labelsSupported: boolean;
}

// ---------- the cache the chat list uses (who may send, are you still in it) ----------

export function cachedGroupSettings(conversationId: number): GroupSettings | null {
  const v = kvGet(`gset:${conversationId}`);
  return v ? (JSON.parse(v) as GroupSettings) : null;
}
function cacheSettings(conversationId: number, s: GroupSettings | null) {
  if (s) mergeGroupSettings(conversationId, { ...s });
}

// ---------- helpers ----------

function wahaError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const msg = (e as Error).message ?? String(e);
  if (/not.?admin|forbidden|403|401|not authorized|permission/i.test(msg)) return new HttpError(403, 'Only group admins can do that.');
  return new HttpError(502, msg.replace(/^WhatsApp API .*? failed \(\d+\): /, 'WhatsApp: '));
}
function signalError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const msg = (e as Error).message ?? String(e);
  if (/permission|not allowed|admin|not a member/i.test(msg)) return new HttpError(403, 'Only group admins can do that in this group.');
  return new HttpError(502, msg.replace(/^.*?failed \(\d+\): /, 'Signal: '));
}

function requireWa() {
  if (getWaState().status !== 'connected') throw new HttpError(503, 'WhatsApp is not connected');
}
function requireSignal(): string {
  const st = getSignalState();
  if ((st.status !== 'connected' && st.status !== 'connecting') || !self.number) throw new HttpError(503, 'Signal is not connected');
  return self.number;
}

function groupConv(id: number): ConversationRow {
  const c = getConversation(id);
  if (!c) throw new HttpError(404, 'Chat not found');
  if (c.kind !== 'group') throw new HttpError(400, 'This is not a group');
  return c;
}

const asBool = (r: unknown, ...keys: string[]): boolean | undefined => {
  if (typeof r === 'boolean') return r;
  for (const k of keys) {
    const v = (r as Json)?.[k];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
};

/** A member key ("wa:316…@c.us") or a plain WhatsApp id → the id WAHA takes. */
function waId(x: string): string {
  const id = x.startsWith('wa:') ? x.slice(3) : x;
  if (!/@(c\.us|lid|s\.whatsapp\.net)$/.test(id)) throw new HttpError(400, `Not a WhatsApp member: ${x}`);
  return bare(id);
}
/** A member key or a number/uuid → what signal-cli takes. */
function signalId(x: string): string {
  if (x === 'self') throw new HttpError(400, "You can't do that to yourself");
  if (/^\+\d{6,}$/.test(x)) return x;
  // A Signal id: the number when we know it (groups list people by number where they can).
  if (/^[0-9a-f-]{36}$/i.test(x)) return findContact(x, null)?.number ?? x;
  const a = addressForKey(x);
  if (!a) throw new HttpError(400, `Unknown member: ${x}`);
  return a;
}
function signalPerson(x: unknown): Person {
  const o = typeof x === 'string' ? { uuid: /^[0-9a-f-]{36}$/i.test(x) ? x : null, number: x.startsWith('+') ? x : null } : ((x ?? {}) as { uuid?: string; number?: string });
  const c = findContact(o.uuid, o.number);
  const key = c?.key ?? o.uuid ?? o.number ?? 'unknown';
  return { key, name: nameForKey(key), number: c?.number ?? o.number ?? null, avatar: avatarUrlForKey(key) };
}

const isMember = (c: ConversationRow) => groupMembers(c).some((m) => m.key === 'self');
const isAdmin = (c: ConversationRow) => groupMembers(c).some((m) => m.key === 'self' && m.admin);

// ---------- WhatsApp ----------

const WA_LINK = 'https://chat.whatsapp.com/';
function waLinkOf(r: unknown): string | null {
  const v = typeof r === 'string' ? r : (r as Json)?.link ?? (r as Json)?.url ?? (r as Json)?.inviteCode ?? (r as Json)?.code;
  if (typeof v !== 'string' || !v) return null;
  return v.startsWith('http') ? v : WA_LINK + v;
}
/** "https://chat.whatsapp.com/AbC…" or just the code. */
export function waInviteCode(link: string): string | null {
  const m = /^(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]{10,})/i.exec(link.trim()) ?? /^([A-Za-z0-9_-]{16,})$/.exec(link.trim());
  return m ? m[1] : null;
}

async function waDetails(c: ConversationRow): Promise<GroupDetails> {
  const g = c.wa_id!;
  const member = isMember(c);
  const admin = isAdmin(c);
  const settingNames: WaGroupSetting[] = ['info-admin-only', 'messages-admin-only', 'member-add-mode', 'membership-approval'];
  const [meta, info, msgs, add, appr, link, reqs, tags] = await Promise.all([
    waha.group(g).catch(() => null),
    ...settingNames.map((s) => (member ? waha.groupSetting(g, s).catch(() => null) : Promise.resolve(null))),
    admin ? waha.inviteCode(g).catch(() => null) : Promise.resolve(null),
    admin ? waha.joinRequests(g).catch(() => null) : Promise.resolve(null),
    member ? waha.groupTags(g).catch(() => null) : Promise.resolve(null),
  ]);
  const md: Json = (meta as Json)?.groupMetadata ?? meta ?? {};
  const infoAdmins = asBool(info, 'adminsOnly') ?? asBool(md, 'restrict');
  const msgAdmins = asBool(msgs, 'adminsOnly') ?? asBool(md, 'announce');
  let membersAdd = asBool(add, 'membersCanAddNewMember', 'allMembersCanAdd');
  if (membersAdd === undefined && typeof md.memberAddMode === 'string') membersAdd = md.memberAddMode === 'all_member_add';
  if (membersAdd === undefined && typeof (add as Json)?.mode === 'string') membersAdd = (add as Json).mode === 'all_member_add';
  const approval = asBool(appr, 'newMembersApprovalRequired', 'approvalRequired') ?? asBool(md, 'membershipApprovalMode');
  const settings: GroupSettings | null =
    infoAdmins === undefined && msgAdmins === undefined
      ? cachedGroupSettings(c.id)
      : { editInfo: infoAdmins ? 'admins' : 'all', sendMessages: msgAdmins ? 'admins' : 'all', addMembers: membersAdd === false ? 'admins' : membersAdd ? 'all' : 'admins', approveMembers: !!approval };
  cacheSettings(c.id, settings);

  const requests: Person[] = [];
  for (const r of Array.isArray(reqs) ? reqs : []) {
    const jid = await resolve(r?.id ?? r?.requester ?? r?.jid ?? r);
    if (!jid) continue;
    const key = keyFor(jid);
    requests.push({ key, name: nameForKey(key), number: jid.endsWith('@c.us') ? '+' + jid.split('@')[0] : null, avatar: avatarUrlForKey(key) });
  }
  const labels: Record<string, string> = {};
  let myLabel: string | null = null;
  for (const t of Array.isArray(tags) ? tags : []) {
    const tag = t?.tag ?? t?.label;
    const jid = await resolve(t?.id ?? t?.participant ?? t?.participantId);
    if (typeof tag !== 'string' || !tag || !jid) continue;
    const key = keyFor(jid);
    labels[key] = tag;
    if (key === 'self') myLabel = tag;
  }
  storeLabels(c.id, labels);
  return {
    network: 'whatsapp',
    member,
    admin,
    canEditInfo: member && (admin || settings?.editInfo === 'all'),
    canAddMembers: member && (admin || settings?.addMembers === 'all'),
    settings: member ? settings : null,
    inviteLink: waLinkOf(link),
    linkEnabled: true,
    canResetLink: admin,
    requests,
    invited: [],
    labels,
    myLabel,
    labelsSupported: member && tags !== null,
  };
}

// ---------- Signal ----------

async function signalDetails(c: ConversationRow): Promise<GroupDetails> {
  const account = requireSignal();
  const g = await signalApi.group(account, groupRecipientId(c.group_id!)).catch((e) => {
    throw signalError(e);
  });
  const member = g.member !== false && isMember(c);
  const admin = isAdmin(c);
  const p = g.permissions ?? {};
  const edit = (kvGet(`sgedit:${c.id}`) as SignalPermission | undefined) ?? p.edit_group;
  const linkState = (g.invite_link ? (kvGet(`sglink:${c.id}`) as SignalLinkState | undefined) ?? 'enabled' : 'disabled') as SignalLinkState;
  const who = (x: SignalPermission | undefined): Who => (x === 'only-admins' ? 'admins' : 'all');
  const settings: GroupSettings = { editInfo: who(edit), sendMessages: who(p.send_messages), addMembers: who(p.add_members), approveMembers: linkState === 'enabled-with-approval' };
  cacheSettings(c.id, settings);
  return {
    network: 'signal',
    member,
    admin,
    canEditInfo: member && (admin || settings.editInfo === 'all'),
    canAddMembers: member && (admin || settings.addMembers === 'all'),
    settings: member ? settings : null,
    inviteLink: g.invite_link || null,
    linkEnabled: !!g.invite_link,
    canResetLink: false,
    requests: (g.pending_requests ?? []).map(signalPerson),
    invited: (g.pending_invites ?? []).map(signalPerson),
    labels: {},
    myLabel: null,
    labelsSupported: false,
  };
}

// ---------- member labels (WhatsApp) ----------

/** Labels last seen per group, so the members list and message names show them without a WAHA call. */
export function groupLabels(conversationId: number): Record<string, string> {
  const v = kvGet(`glabels:${conversationId}`);
  return v ? JSON.parse(v) : {};
}
function storeLabels(conversationId: number, labels: Record<string, string>) {
  kvSet(`glabels:${conversationId}`, JSON.stringify(labels));
}

// ---------- actions ----------

export async function groupDetails(conversationId: number): Promise<GroupDetails> {
  const c = groupConv(conversationId);
  if (c.network === 'whatsapp') {
    requireWa();
    return waDetails(c);
  }
  return signalDetails(c);
}

async function afterChange(c: ConversationRow) {
  if (c.network === 'whatsapp') await refreshWaGroupNow(c);
  else {
    await refreshDirectory().catch(() => {});
    groupChanged(c.id);
  }
}

type Action =
  | { action: 'rename'; name: string }
  | { action: 'describe'; description: string }
  | { action: 'settings'; settings: Partial<GroupSettings> }
  | { action: 'add' | 'remove' | 'promote' | 'demote' | 'approve' | 'reject'; members: string[] }
  | { action: 'link'; op: 'reset' | 'enable' | 'disable' }
  | { action: 'leave' }
  | { action: 'label'; label: string | null };

export async function groupAction(conversationId: number, a: Action): Promise<void> {
  const c = groupConv(conversationId);
  const wa = c.network === 'whatsapp';
  if (wa) requireWa();
  const account = wa ? '' : requireSignal();
  const g = wa ? c.wa_id! : groupRecipientId(c.group_id!);
  const members = 'members' in a ? (Array.isArray(a.members) ? a.members.filter((x) => typeof x === 'string' && x) : []) : [];
  if ('members' in a && !members.length) throw new HttpError(400, 'Choose who');
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      throw wa ? wahaError(e) : signalError(e);
    }
  };

  switch (a.action) {
    case 'rename': {
      const name = String(a.name ?? '').trim();
      if (!name) throw new HttpError(400, 'Give the group a name');
      if (name.length > (wa ? 100 : 32)) throw new HttpError(400, `Group names can be at most ${wa ? 100 : 32} characters on ${wa ? 'WhatsApp' : 'Signal'}`);
      await run(() => (wa ? waha.setGroupSubject(g, name) : signalApi.updateGroup(account, g, { name })));
      if (wa) getOrCreateWaChat(g, name);
      else getOrCreateGroup(c.group_id!, name);
      break;
    }
    case 'describe': {
      const description = String(a.description ?? '').trim();
      if (description.length > (wa ? 2048 : 480)) throw new HttpError(400, 'That description is too long');
      await run(() => (wa ? waha.setGroupDescription(g, description) : signalApi.updateGroup(account, g, { description })));
      break;
    }
    case 'settings': {
      const s = a.settings ?? {};
      if (wa) {
        await run(async () => {
          if (s.editInfo) await waha.setGroupSetting(g, 'info-admin-only', { adminsOnly: s.editInfo === 'admins' });
          if (s.sendMessages) await waha.setGroupSetting(g, 'messages-admin-only', { adminsOnly: s.sendMessages === 'admins' });
          if (s.addMembers) await waha.setGroupSetting(g, 'member-add-mode', { membersCanAddNewMember: s.addMembers === 'all' });
          if (typeof s.approveMembers === 'boolean') await waha.setGroupSetting(g, 'membership-approval', { newMembersApprovalRequired: s.approveMembers });
        });
      } else {
        const perm = (w?: Who): SignalPermission | undefined => (w ? (w === 'admins' ? 'only-admins' : 'every-member') : undefined);
        const permissions = Object.fromEntries(
          Object.entries({ edit_group: perm(s.editInfo), send_messages: perm(s.sendMessages), add_members: perm(s.addMembers) }).filter(([, v]) => v),
        );
        let link: SignalLinkState | undefined;
        if (typeof s.approveMembers === 'boolean') {
          const current = await signalApi.group(account, g).catch(() => null);
          if (current?.invite_link) link = s.approveMembers ? 'enabled-with-approval' : 'enabled';
          else kvSet(`sglink_want:${c.id}`, s.approveMembers ? 'enabled-with-approval' : 'enabled');
        }
        await run(() => signalApi.updateGroup(account, g, { ...(Object.keys(permissions).length ? { permissions } : {}), ...(link ? { group_link: link } : {}) }));
        if (s.editInfo) kvSet(`sgedit:${c.id}`, perm(s.editInfo)!);
        if (link) kvSet(`sglink:${c.id}`, link);
      }
      mergeGroupSettings(c.id, { ...s });
      break;
    }
    case 'add':
      await run(() => (wa ? waha.groupMembers(g, 'add', members.map(waId)) : signalApi.groupMembers(account, g, true, members.map(signalId))));
      break;
    case 'remove':
      await run(() => (wa ? waha.groupMembers(g, 'remove', members.map(waId)) : signalApi.groupMembers(account, g, false, members.map(signalId))));
      break;
    case 'promote':
    case 'demote':
      await run(() =>
        wa ? waha.groupAdmins(g, a.action as 'promote' | 'demote', members.map(waId)) : signalApi.groupAdmins(account, g, a.action === 'promote', members.map(signalId)),
      );
      break;
    case 'approve':
    case 'reject':
      // Signal: adding someone who asked to join lets them in; removing them turns them down.
      await run(() =>
        wa ? waha.answerJoinRequests(g, a.action as 'approve' | 'reject', members.map(waId)) : signalApi.groupMembers(account, g, a.action === 'approve', members.map(signalId)),
      );
      break;
    case 'link': {
      if (wa) {
        if (a.op !== 'reset') throw new HttpError(400, 'WhatsApp groups always have an invite link; you can only reset it');
        await run(() => waha.revokeInviteCode(g));
      } else {
        if (a.op === 'reset') throw new HttpError(400, "Signal's API can't make a new invite link; switch the link off and reset it on your phone");
        const want = a.op === 'enable' ? ((kvGet(`sglink_want:${c.id}`) as SignalLinkState | undefined) ?? 'enabled') : 'disabled';
        await run(() => signalApi.updateGroup(account, g, { group_link: want }));
        kvSet(`sglink:${c.id}`, want);
      }
      break;
    }
    case 'leave':
      await run(() => (wa ? waha.leaveGroup(g) : signalApi.quitGroup(account, g)));
      if (wa) {
        dropSelfFromGroup(c);
        groupChanged(c.id);
        return; // WhatsApp Web no longer reports the members of a group you left
      }
      dropSelfFromSignalGroup(c);
      groupChanged(c.id);
      return;
    case 'label': {
      if (!wa) throw new HttpError(400, "Signal doesn't have member labels");
      const label = a.label == null ? null : String(a.label).trim() || null;
      if (label && (label.length < 2 || label.length > 30)) throw new HttpError(400, 'A label is 2 to 30 characters');
      await run(() => waha.setMyGroupTag(g, label));
      const labels = groupLabels(c.id);
      if (label) labels.self = label;
      else delete labels.self;
      storeLabels(c.id, labels);
      break;
    }
    default:
      throw new HttpError(400, 'Unknown group action');
  }
  await afterChange(c);
}

function dropSelfFromSignalGroup(c: ConversationRow) {
  const ids: string[] = c.group_members ? JSON.parse(c.group_members) : [];
  getOrCreateGroup(
    c.group_id!,
    undefined,
    ids.filter((id) => !self.is(id, id)),
  );
}

export async function createGroup(body: { network?: string; name?: string; members?: string[]; avatar?: string; description?: string }): Promise<ConversationRow> {
  const name = String(body.name ?? '').trim();
  const members = (Array.isArray(body.members) ? body.members : []).filter((x) => typeof x === 'string' && x);
  if (!name) throw new HttpError(400, 'Give the group a name');
  if (!members.length) throw new HttpError(400, 'Add at least one person');
  if (body.network === 'whatsapp') {
    requireWa();
    if (name.length > 100) throw new HttpError(400, 'Group names can be at most 100 characters on WhatsApp');
    let r: Json;
    try {
      r = await waha.createGroup(name, members.map(waId));
    } catch (e) {
      throw wahaError(e);
    }
    const jid = bare(r?.gid ?? r?.id ?? r?.groupMetadata?.id ?? r?.JID);
    if (!jid.endsWith('@g.us')) throw new HttpError(502, 'WhatsApp made the group but did not say which one; it will show up in a moment');
    const conv = getOrCreateWaChat(jid, name);
    if (body.description) await waha.setGroupDescription(jid, body.description).catch(() => {});
    if (body.avatar) await waha.setGroupPicture(jid, { mimetype: 'image/jpeg', filename: 'group.jpg', data: body.avatar }).then(() => forgetWaAvatar(jid)).catch(() => {});
    await refreshWaGroupNow(conv);
    return getConversation(conv.id)!;
  }
  const account = requireSignal();
  if (name.length > 32) throw new HttpError(400, 'Group names can be at most 32 characters on Signal');
  let r: { id: string };
  try {
    r = await signalApi.createGroup(account, {
      name,
      members: members.map(signalId),
      ...(body.description ? { description: body.description } : {}),
      group_link: 'disabled',
      permissions: { add_members: 'every-member', edit_group: 'every-member', send_messages: 'every-member' },
    });
  } catch (e) {
    throw signalError(e);
  }
  const internalId = Buffer.from(r.id.replace(/^group\./, ''), 'base64').toString('utf8');
  const conv = getOrCreateGroup(internalId, name, [account, ...members.map(signalId)], { description: body.description || null, admins: [account] });
  if (body.avatar) await signalApi.updateGroup(account, r.id, { base64_avatar: body.avatar }).catch(() => {});
  await refreshDirectory().catch(() => {});
  return getConversation(conv.id)!;
}

export async function waJoinInfo(link: string) {
  requireWa();
  const code = waInviteCode(link);
  if (!code) throw new HttpError(400, "That isn't a WhatsApp group link");
  let r: Json;
  try {
    r = await waha.joinInfo(code);
  } catch (e) {
    throw new HttpError(400, /not.?found|404|gone|invalid/i.test((e as Error).message) ? 'This invite link has been reset or the group no longer exists' : wahaError(e).message);
  }
  const md = r?.groupMetadata ?? r ?? {};
  const id = bare(md.id ?? r?.id);
  return {
    name: md.subject ?? md.name ?? 'WhatsApp group',
    description: md.desc ?? md.description ?? null,
    size: Number(md.size ?? md.participants?.length) || null,
    approval: !!(md.membershipApprovalMode ?? r?.membershipApprovalMode),
    already: id.endsWith('@g.us') && isKnownMember(id),
  };
}
function isKnownMember(jid: string) {
  const c = findWaChat(jid);
  return !!c && isMember(c);
}

export async function waJoin(link: string): Promise<ConversationRow | null> {
  requireWa();
  const code = waInviteCode(link);
  if (!code) throw new HttpError(400, "That isn't a WhatsApp group link");
  let r: Json;
  try {
    r = await waha.joinGroup(code);
  } catch (e) {
    throw wahaError(e);
  }
  const jid = bare(r?.id ?? r?.gid ?? r);
  if (!jid.endsWith('@g.us')) return null; // approval needed: the group appears once an admin lets you in
  const conv = getOrCreateWaChat(jid);
  await refreshWaGroupNow(conv);
  return getConversation(conv.id)!;
}

export function groupRoutes(r: Router) {
  r.add('GET', '/api/conversations/:id/group', (ctx) => groupDetails(Number(ctx.params.id)));
  r.add('POST', '/api/conversations/:id/group', async (ctx) => {
    const id = Number(ctx.params.id);
    await groupAction(id, ctx.body ?? {});
    const c = getConversation(id)!;
    // Leaving: the details can't be fetched any more (WhatsApp), so send what we know.
    const details = await groupDetails(id).catch(() => null);
    return { conversation: conversationDto(c), details };
  });
  r.add('POST', '/api/groups', async (ctx) => conversationDto(await createGroup(ctx.body ?? {})));
  r.add('GET', '/api/groups/join-info', (ctx) => waJoinInfo(ctx.query.get('link') ?? ''));
  r.add('POST', '/api/groups/join', async (ctx) => {
    const c = await waJoin(String(ctx.body?.link ?? ''));
    return { conversation: c ? conversationDto(c) : null };
  });
  // Group pictures, both networks (the older Signal-only route stays for the info panel).
  r.add('POST', '/api/conversations/:id/group/picture', async (ctx) => {
    const c = groupConv(Number(ctx.params.id));
    const data = ctx.body?.avatar;
    if (data !== null && (typeof data !== 'string' || !data)) throw new HttpError(400, 'Choose a picture');
    if (c.network === 'whatsapp') {
      requireWa();
      try {
        if (data) await waha.setGroupPicture(c.wa_id!, { mimetype: 'image/jpeg', filename: 'group.jpg', data });
        else await waha.deleteGroupPicture(c.wa_id!);
      } catch (e) {
        throw wahaError(e);
      }
      forgetWaAvatar(c.wa_id!);
      await refreshWaGroupNow(c);
    } else {
      if (!data) throw new HttpError(400, "Signal's API can't remove a group picture; choose a new one, or remove it on your phone");
      const account = requireSignal();
      const gid = groupRecipientId(c.group_id!);
      try {
        await signalApi.updateGroup(account, gid, { base64_avatar: data });
      } catch (e) {
        throw signalError(e);
      }
      invalidateAvatar('group', gid);
      groupChanged(c.id);
    }
    return conversationDto(getConversation(c.id)!);
  });
}
