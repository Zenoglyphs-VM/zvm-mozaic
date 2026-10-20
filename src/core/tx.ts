// A step of a submitted paint, and the words a person reads while it runs.
//
// The states are the chain's own: a transaction is signed, then ordered by a
// momentum, then executed by the ZVM. Blue while it is ordered and green once
// it has executed, which is the colour rule the whole app uses.

import {reactive} from 'vue'
import type {Hash} from 'viem'

export type StepState = 'queued' | 'signing' | 'ordered' | 'done' | 'failed'

export interface Step {
  label: string
  state: StepState
  hash?: Hash
  detail?: string
  signature?: boolean
}

export const STEP_WORD: Record<StepState, string> = {
  queued: 'Next',
  signing: 'Waiting for your wallet',
  ordered: 'Ordered by NoM',
  done: 'Executed',
  failed: 'Failed',
}

export const reason = (err: any): string => {
  const s = err?.shortMessage ?? err?.details ?? err?.message ?? String(err)
  // Wallets all phrase a rejection differently, and none of them phrase it well.
  if (/user rejected|denied transaction|user denied|rejected the request/i.test(s)) return 'You dismissed the request in your wallet.'
  return s
}

// --- what this browser has sent --------------------------------------------

export interface Sent {
  hash: Hash
  label: string
  chainId: number
  at: number
  state: 'ordered' | 'done' | 'failed'
}

const ACTIVITY_KEY = 'mozaic.activity'
const ACTIVITY_MAX = 25

export const activity = reactive<{items: Sent[]}>({items: readActivity()})

function readActivity(): Sent[] {
  try {
    return JSON.parse(localStorage.getItem(ACTIVITY_KEY) ?? '[]')
  } catch {
    return []
  }
}

export function record(entry: Sent) {
  const rest = activity.items.filter((a) => a.hash !== entry.hash)
  activity.items = [entry, ...rest].slice(0, ACTIVITY_MAX)
  try {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity.items))
  } catch {
    /* storage can be blocked; the list still holds for this tab */
  }
}

export function clearActivity() {
  activity.items = []
  try {
    localStorage.removeItem(ACTIVITY_KEY)
  } catch {
    /* nothing to clear */
  }
}
