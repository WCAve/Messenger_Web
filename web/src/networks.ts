/** What each network can do, so the interface only offers what works. */
import type { Conversation, Network } from './types';
import { useStore } from './store';

export const NETWORK_LABEL: Record<Network, string> = { signal: 'Signal', whatsapp: 'WhatsApp' };

export interface Caps {
  stickers: boolean; // Signal sticker packs
  timer: boolean; // disappearing messages settable here
  endPoll: boolean;
  groupPhoto: boolean;
  spoilers: boolean;
  receiptDetails: boolean; // per-person "read by" lists
  editWindowMs: number;
}

const CAPS: Record<Network, Caps> = {
  signal: { stickers: true, timer: true, endPoll: true, groupPhoto: true, spoilers: true, receiptDetails: true, editWindowMs: 24 * 3600_000 - 60_000 },
  whatsapp: { stickers: false, timer: false, endPoll: false, groupPhoto: false, spoilers: false, receiptDetails: false, editWindowMs: 15 * 60_000 - 30_000 },
};

export function capsFor(c: Pick<Conversation, 'network'> | undefined | null): Caps {
  return CAPS[c?.network ?? 'signal'];
}

/** Whether you can send in this network right now. */
export function useNetworkReady(network: Network): boolean {
  return useStore((s) => (network === 'whatsapp' ? s.whatsapp.status === 'connected' : s.signal.status === 'connected'));
}
