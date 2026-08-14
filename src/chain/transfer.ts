// The send flow's UI-facing facade. The overlay (components/SendOverlay.tsx)
// talks to this, never to the pallet/signing modules directly:
//
//   loadSendRecipients — who an owned item can be sent to
//   sendItem           — move the item (re-export of start.ts, which also
//                        forces an immediate re-poll on success)
//   subscribeCanSend   — whether this session can sign a transfer at all, so
//                        the UI hides the send action instead of dead-ending
//
// Recipients are a stand-in: how players address one another is an open
// question (dependency #2/#3), so for now a send targets one of the
// well-known DEV accounts (we transfer between dev accounts anyway). The
// destination is a purse in that account's subtree, so the item shows up on
// the recipient's shelf.

import { devRecipients } from './derive'
import { currentIdentity, getIdentitySource } from './identity'
import { getSigner } from './signing'

export { sendItem } from './start'
export type { SendParams, SendStatus, SendResult } from './start'

/** One send target: a display name and the dev root its receiving purse
 *  derives under (fed straight to sendItem's `recipientRoot`). */
export interface SendRecipient {
  name: string
  rootPath: string
}

/** The accounts an owned item can be sent to — the well-known dev accounts,
 *  minus the current player (you can't send an item to the purse subtree it
 *  already lives in). */
export function loadSendRecipients(): SendRecipient[] {
  const me = currentIdentity()
  const myAddress = me?.kind === 'account' ? me.address : null
  return devRecipients()
    .filter((r) => r.address !== myAddress)
    .map((r) => ({ name: r.name, rootPath: r.rootPath }))
}

/** Fires immediately with whether this session can sign a transfer, then
 *  again whenever the identity changes. Same capability as claiming (the
 *  signer seam), so a session that can't sign reports false and the UI keeps
 *  the send action hidden. Returns an unsubscribe function. */
export function subscribeCanSend(cb: (canSend: boolean) => void): () => void {
  return getIdentitySource().subscribe((identity) => {
    getSigner(identity).then((signer) => cb(signer !== null)).catch(() => cb(false))
  })
}
