// The chain's heartbeat, and the one place this page polls the node.
//
// One NoM momentum orders exactly one ZVM block, about every fifteen seconds
// on the devnets, so the chain has a beat rather than a stream. The page looks
// once per `prefs.refresh` seconds (a momentum by default, never faster) with
// a single eth_blockNumber. Only when the head moved does it read that block,
// and only then do listeners run, each told the new head so none of them has
// to ask for it again. A hidden tab does not look at all, and one coming back
// looks at once.
//
// Everything that refreshes (the canvas, the totals, a wallet balance) hangs
// off onBlock, so a tab left open costs the node about four small requests a
// minute plus one log read per block that actually carried something.

import {reactive, watch} from 'vue'
import {endpoint, reachable} from './endpoint'
import {publicClient} from '@zvm/web/evm'
import {prefs} from './prefs'

export interface ChainState {
  chainId: number | null
  head: number | null
  /** Unix seconds of the head block. */
  timestamp: number | null
  baseFee: bigint | null
  /** Measured seconds between blocks, not the nominal ten. */
  interval: number
  /** Wall clock (ms) when the head last changed, for the pulse. */
  landedAt: number
  error: string | null
}

export const chain = reactive<ChainState>({
  chainId: null,
  head: null,
  timestamp: null,
  baseFee: null,
  interval: 15,
  landedAt: Date.now(),
  error: null,
})

const onBlockListeners = new Set<(head: number) => void>()

export function onBlock(fn: (head: number) => void): () => void {
  onBlockListeners.add(fn)
  return () => onBlockListeners.delete(fn)
}

let timer: number | undefined
let lastSeen = 0
let started = false

const hidden = () => typeof document !== 'undefined' && document.hidden

async function poll() {
  if (!reachable.value || endpoint.chainId === null || hidden()) return
  try {
    const client = publicClient(endpoint.chainId)
    const number = Number(await client.getBlockNumber({cacheTime: 0}))
    chain.chainId = endpoint.chainId
    chain.error = null
    if (number === lastSeen) return
    const block = await client.getBlock({blockNumber: BigInt(number)})
    chain.baseFee = block.baseFeePerGas ?? null
    // Blocks carry NoM's timestamps, and several may have landed since the
    // last look, so the gap is averaged over however many there were.
    if (chain.timestamp && lastSeen && number > lastSeen) {
      const gap = (Number(block.timestamp) - chain.timestamp) / (number - lastSeen)
      if (gap > 0 && gap < 120) chain.interval = chain.interval * 0.7 + gap * 0.3
    }
    lastSeen = number
    chain.head = number
    chain.timestamp = Number(block.timestamp)
    chain.landedAt = Date.now()
    onBlockListeners.forEach((fn) => fn(number))
  } catch (err: any) {
    chain.error = err?.shortMessage ?? err?.message ?? String(err)
  }
}

/**
 * The gallery view looks on its own beat, whatever the setting: it is a
 * screen left up to watch the canvas move, and the owner set ten seconds
 * there (2026-09-29, first three). Everywhere else the setting holds, and
 * never below one momentum.
 */
let override: number | null = null

export function setBeat(seconds: number | null) {
  override = seconds
  refreshNow()
}

function arm() {
  clearTimeout(timer)
  const every = override ?? (prefs.refresh ? Math.max(15, prefs.refresh) : 0)
  if (!every) return
  timer = window.setTimeout(async () => {
    await poll()
    arm()
  }, every * 1000)
}

/** Looks now, then on the configured beat. */
export function refreshNow() {
  void poll().then(arm)
}

export function startChainPolling() {
  if (started) return
  started = true
  refreshNow()
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshNow()
  })
}

watch(() => prefs.refresh, refreshNow)

// A new node is a new chain until proven otherwise.
watch(
  () => endpoint.rpc,
  () => {
    lastSeen = 0
    chain.head = null
    chain.timestamp = null
    chain.baseFee = null
    chain.error = null
    refreshNow()
  },
)
