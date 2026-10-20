// The canvas as the chain has it, kept in this tab.
//
// Loading is a snapshot plus a replay. The snapshot is the contract's state,
// read with `chunk()` in ten calls of ten thousand slots; the replay is every
// Painted event after the block number read *before* the snapshot. The
// snapshot may already include some of those events, and replaying them is
// harmless: events apply in chain order and the last write to a pixel wins, so
// the result is the chain's state at the head, whichever block each chunk was
// read at. No archive state is needed, which a pruned node would not have.
//
// After that, every block's events are applied as the block lands (chain.ts
// beats once per momentum), and whoever listens is told what arrived, so the
// page can mark it.
//
// Who painted each pixel is not in the contract's state, only in its events,
// so it is known for pixels painted since the history window began (a day, or
// the deployment, whichever is later) and unknown before.
//
// The pixel arrays are deliberately not reactive: a million entries behind a
// proxy would make every read a trap. `board` is the small reactive summary.

import {reactive, shallowRef, watch} from 'vue'
import {decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Address, type Hex} from 'viem'
import {MOZAIC_ABI} from './abi'
import {endpoint, ready} from './endpoint'
import {onBlock} from './chain'
import {decodePixels, PER_SLOT, type Px} from './codec'

/** About a day of momentums at the measured fifteen seconds each. */
export const HISTORY_BLOCKS = 5760
const LOG_SPAN = 5000
const SLOTS_PER_CALL = 10_000

const PAINTED_TOPIC = keccak256(toBytes('Painted(address,uint256,bytes)'))
/** The router's: who a paint through it is for, logged just before the canvas's Painted. */
const PAINTED_BY_TOPIC = keccak256(toBytes('PaintedBy(address,address,uint256)'))
/** The owner cleared the canvas: from this block on, everything is white. */
const CLEARED_TOPIC = keccak256(toBytes('Cleared(uint256)'))

/** What the logs are read from: the canvas, and its router when it has one. */
const sources = (): Address[] => [endpoint.contract, endpoint.router].filter((a): a is Address => !!a)

export interface Paint {
  tx: Hex
  painter: Address
  count: number
  block: number
  /** The bounding box of what it painted, for locating it on the canvas. */
  x0: number
  y0: number
  x1: number
  y1: number
}

export const board = reactive({
  status: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
  /** 0..1 while the snapshot loads. */
  progress: 0,
  error: null as string | null,
  width: 0,
  height: 0,
  /** Every event up to and including this block has been applied. */
  syncedTo: 0,
  /** The first block of the history window, once it has loaded. */
  historyFrom: null as number | null,
  historyLoading: false,
  painted: null as bigint | null,
  /** The block the canvas was last cleared in, when a clear is in what this page has read. */
  clearedAt: null as number | null,
  /** What the contract holds: every paint's payment not yet withdrawn. */
  balance: null as bigint | null,
})

/** Paints in the history window and since, oldest first. */
export const paints = shallowRef<Paint[]>([])

// --- the pixels -----------------------------------------------------------------

export let W = 0
export let H = 0
let rgba = new Uint8ClampedArray(0)
let image: ImageData | null = null
/** The canvas at one pixel per pixel, which the view scales. */
export const surface = document.createElement('canvas')
const sctx = surface.getContext('2d', {willReadFrequently: false})!

/** Per pixel: 1 + index into `painterList`, or 0 when unknown. */
let painterOf = new Uint32Array(0)
let blockOf = new Uint32Array(0)
const painterList: Address[] = []
const painterIds = new Map<string, number>()

/**
 * A pixel's colour. Blank is white, as the contract has it: a pixel never
 * painted and one painted white are the same zero in storage. The page draws
 * blank as see-through, over the checkerboard, so a blank canvas reads as
 * empty rather than as white paint (the owner's call, 2026-09-29).
 */
export function colorAt(index: number): number {
  const o = index * 4
  return rgba[o + 3] === 0 ? 0xffffff : (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2]
}

/** Who last painted a pixel and in which block, when it was in the window. */
export function whoPainted(index: number): {painter: Address; block: number} | null {
  const id = painterOf[index]
  return id ? {painter: painterList[id - 1], block: blockOf[index]} : null
}

/** A storage slot holds ten white pixels, so it is zero on chain. */
export function slotBlank(slot: number): boolean {
  for (let k = 0; k < PER_SLOT; k++) if (colorAt(slot * PER_SLOT + k) !== 0xffffff) return false
  return true
}

function allocate(w: number, h: number) {
  W = w
  H = h
  // Transparent throughout: a canvas before any paint is blank.
  rgba = new Uint8ClampedArray(w * h * 4)
  image = new ImageData(rgba, w, h)
  surface.width = w
  surface.height = h
  sctx.putImageData(image, 0, 0)
  painterOf = new Uint32Array(w * h)
  blockOf = new Uint32Array(w * h)
  painterList.length = 0
  painterIds.clear()
}

let dirty: {x0: number; y0: number; x1: number; y1: number} | null = null

/**
 * The owner cleared the canvas in `block`. Live, every pixel goes white at
 * once, as it did on chain. Either way, nobody painted what is there before
 * that block any more, so those painters are forgotten; a paint later than
 * the clear, already applied by the live sync, keeps its painter.
 */
function cleared(block: number, pixels: boolean) {
  if (board.clearedAt === null || block > board.clearedAt) board.clearedAt = block
  if (pixels) {
    rgba.fill(0)
    dirty = {x0: 0, y0: 0, x1: W - 1, y1: H - 1}
  }
  for (let i = 0; i < blockOf.length; i++) {
    if (blockOf[i] <= block) {
      painterOf[i] = 0
      blockOf[i] = 0
    }
  }
}

function set(index: number, rgb: number) {
  const o = index * 4
  rgba[o] = rgb >> 16
  rgba[o + 1] = (rgb >> 8) & 0xff
  rgba[o + 2] = rgb & 0xff
  rgba[o + 3] = rgb === 0xffffff ? 0 : 255
  const x = index % W
  const y = (index - x) / W
  if (!dirty) dirty = {x0: x, y0: y, x1: x, y1: y}
  else {
    if (x < dirty.x0) dirty.x0 = x
    if (x > dirty.x1) dirty.x1 = x
    if (y < dirty.y0) dirty.y0 = y
    if (y > dirty.y1) dirty.y1 = y
  }
}

function flush() {
  if (!dirty || !image) return
  const d = dirty
  dirty = null
  sctx.putImageData(image, 0, 0, d.x0, d.y0, d.x1 - d.x0 + 1, d.y1 - d.y0 + 1)
  changed.forEach((fn) => fn())
}

// --- who wants to know ----------------------------------------------------------

const changed = new Set<() => void>()
const arrivals = new Set<(p: Paint[]) => void>()

/** Called whenever pixels changed, for a redraw. */
export function onChanged(fn: () => void): () => void {
  changed.add(fn)
  return () => changed.delete(fn)
}

/** Called with paints that arrived live, after the page loaded. */
export function onArrived(fn: (p: Paint[]) => void): () => void {
  arrivals.add(fn)
  return () => arrivals.delete(fn)
}

// --- reading the chain ----------------------------------------------------------

let nextId = 1

/**
 * One JSON-RPC call, never batched: the snapshot's answers are up to a
 * megabyte each, and batching ten of them would hold the first back until the
 * last arrived, which is exactly what the progressive load is there to avoid.
 */
async function rpc<T = any>(method: string, params: unknown[], timeoutMs = 60_000): Promise<T> {
  const res = await fetch(endpoint.rpc, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: nextId++, method, params}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${method}: ${res.status} ${res.statusText}`)
  const body = await res.json()
  if (body.error) throw new Error(body.error.message ?? `${method} failed`)
  return body.result as T
}

interface RawLog {
  blockNumber: Hex
  transactionHash: Hex
  topics: Hex[]
  data: Hex
}

/**
 * Painted and PaintedBy logs in [from, to], in one query for both contracts,
 * so a paint and the name it was painted in arrive together and in order.
 * Split when the node refuses a range as too big.
 */
async function logs(address: Address[], from: number, to: number): Promise<RawLog[]> {
  if (from > to) return []
  try {
    return await rpc<RawLog[]>('eth_getLogs', [
      {address, topics: [[PAINTED_TOPIC, PAINTED_BY_TOPIC, CLEARED_TOPIC]], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`},
    ])
  } catch (err) {
    // The devnet node caps a query at 20,000 results. Halve and retry.
    if (to - from < 1) throw err
    const mid = Math.floor((from + to) / 2)
    return [...(await logs(address, from, mid)), ...(await logs(address, mid + 1, to))]
  }
}

async function logsChunked(address: Address[], from: number, to: number): Promise<RawLog[]> {
  const out: RawLog[] = []
  for (let a = from; a <= to; a += LOG_SPAN) out.push(...(await logs(address, a, Math.min(to, a + LOG_SPAN - 1))))
  return out
}

/**
 * Applies Painted logs in chain order; `pixels` false records who and when
 * only. A paint through the router is credited to the artist its PaintedBy
 * named, which for a paint session is the wallet that funded the session:
 * the canvas itself only ever sees the router.
 */
function apply(raw: RawLog[], pixels: boolean): Paint[] {
  const out: Paint[] = []
  const buf: Px[] = []
  const artistOf = new Map<string, Address>()
  for (const l of raw) {
    if (l.topics[0] === PAINTED_BY_TOPIC) {
      artistOf.set(l.transactionHash, `0x${l.topics[1].slice(26)}` as Address)
      continue
    }
    if (l.topics[0] === CLEARED_TOPIC) {
      cleared(parseInt(l.blockNumber, 16), pixels)
      continue
    }
    const sender = `0x${l.topics[1].slice(26)}` as Address
    const painter = artistOf.get(l.transactionHash) ?? sender
    const data = l.data.slice(2)
    // (uint256 count, bytes pixels): the bytes' length is the third word.
    const len = parseInt(data.slice(128, 192), 16)
    buf.length = 0
    decodePixels(data.slice(192, 192 + len * 2), buf)
    let id = painterIds.get(painter.toLowerCase())
    if (!id) {
      painterList.push(painter)
      id = painterList.length
      painterIds.set(painter.toLowerCase(), id)
    }
    const block = parseInt(l.blockNumber, 16)
    let x0 = W, y0 = H, x1 = 0, y1 = 0
    for (const p of buf) {
      if (p.index >= W * H) continue
      if (pixels) set(p.index, p.rgb)
      // The history window loads after the live sync has started, so a
      // pixel may already carry a newer painter than the event being read.
      if (blockOf[p.index] <= block) {
        painterOf[p.index] = id
        blockOf[p.index] = block
      }
      const x = p.index % W
      const y = (p.index - x) / W
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    out.push({tx: l.transactionHash, painter, count: buf.length, block, x0, y0, x1, y1})
  }
  return out
}

function applyChunk(result: Hex) {
  const hex = decodeFunctionResult({abi: MOZAIC_ABI, functionName: 'chunk', data: result}) as Hex
  // 36 bytes an entry: slot (4), then the slot's 32-byte value, in which pixel
  // k is bits 24k..24k+23 counted from the right, stored XOR 0xFFFFFF.
  for (let o = 2; o + 72 <= hex.length; o += 72) {
    const slot = parseInt(hex.slice(o, o + 8), 16)
    const value = hex.slice(o + 8, o + 72)
    for (let k = 0; k < PER_SLOT; k++) {
      const end = 64 - k * 6
      set(slot * PER_SLOT + k, parseInt(value.slice(end - 6, end), 16) ^ 0xffffff)
    }
  }
}

let generation = 0

/** Loads the canvas from scratch: shape, snapshot, then the history window. */
export async function load() {
  const gen = ++generation
  const canvas = endpoint.canvas
  const address = endpoint.contract
  if (!canvas || !address) return
  board.status = 'loading'
  board.progress = 0
  board.error = null
  board.historyFrom = null
  board.clearedAt = null
  paints.value = []
  board.width = canvas.width
  board.height = canvas.height
  allocate(canvas.width, canvas.height)
  changed.forEach((fn) => fn())

  try {
    const head = parseInt(await rpc<Hex>('eth_blockNumber', []), 16)
    const slots = (canvas.width * canvas.height) / PER_SLOT
    const starts: number[] = []
    for (let s = 0; s < slots; s += SLOTS_PER_CALL) starts.push(s)
    let done = 0
    // Three at a time: the rows fill in as they arrive rather than all at the end.
    const queue = [...starts]
    await Promise.all(
      Array.from({length: 3}, async () => {
        for (let start = queue.shift(); start !== undefined; start = queue.shift()) {
          const data = encodeFunctionData({abi: MOZAIC_ABI, functionName: 'chunk', args: [BigInt(start), BigInt(SLOTS_PER_CALL)]})
          const result = await rpc<Hex>('eth_call', [{to: address, data}, 'latest'])
          if (gen !== generation) return
          applyChunk(result)
          flush()
          board.progress = ++done / starts.length
        }
      }),
    )
    if (gen !== generation) return
    board.syncedTo = head
    board.status = 'ready'
    void refreshTotals(true)
    // Anything painted while the snapshot loaded.
    void sync()
    void loadHistory(gen, head)
  } catch (err: any) {
    if (gen !== generation) return
    board.status = 'error'
    board.error = err?.message ?? String(err)
  }
}

async function loadHistory(gen: number, head: number) {
  board.historyLoading = true
  try {
    const from = Math.max(endpoint.deployBlock ?? 0, head - HISTORY_BLOCKS, 0)
    const raw = await logsChunked(sources(), from, head)
    if (gen !== generation) return
    // Only who and when: the pixels themselves are already in the snapshot,
    // and repainting them here could undo something the live sync applied.
    const older = apply(raw, false)
    paints.value = [...older, ...paints.value.filter((p) => p.block > head)]
    board.historyFrom = from
  } catch {
    /* the activity list says it could not be read; the canvas is unaffected */
  } finally {
    if (gen === generation) board.historyLoading = false
  }
}

let syncing: Promise<void> | null = null
let again = false

let knownHead: number | null = null

/**
 * Applies every Painted event between what was applied and the head. The
 * head comes from chain.ts's beat, so a sync is one eth_getLogs; only a sync
 * with no beat behind it (just after the snapshot) asks for the head itself.
 */
export function sync(head?: number): Promise<void> {
  if (head !== undefined) knownHead = head
  if (syncing) {
    again = true
    return syncing
  }
  syncing = (async () => {
    do {
      again = false
      const gen = generation
      const address = endpoint.contract
      if (board.status !== 'ready' || !address) return
      try {
        const head = knownHead ?? parseInt(await rpc<Hex>('eth_blockNumber', []), 16)
        knownHead = null
        if (head <= board.syncedTo) continue
        const raw = await logsChunked(sources(), board.syncedTo + 1, head)
        if (gen !== generation) return
        const arrived = apply(raw, true)
        flush()
        board.syncedTo = head
        if (arrived.length) {
          paints.value = [...paints.value, ...arrived]
          arrivals.forEach((fn) => fn(arrived))
        }
      } catch {
        /* the next block tries again from the same place */
      }
    } while (again)
  })().finally(() => {
    syncing = null
  })
  return syncing
}

let totalsAt = 0

/** The contract's counters: decoration, so read at most once a minute. */
async function refreshTotals(force = false) {
  const address = endpoint.contract
  if (!address) return
  if (!force && Date.now() - totalsAt < 60_000) return
  totalsAt = Date.now()
  try {
    const [painted, balance] = await Promise.all([
      rpc<Hex>('eth_call', [{to: address, data: encodeFunctionData({abi: MOZAIC_ABI, functionName: 'painted'})}, 'latest']),
      rpc<Hex>('eth_getBalance', [address, 'latest']),
    ])
    board.painted = BigInt(painted)
    board.balance = BigInt(balance)
  } catch {
    /* totals are decoration; the next block reads them again */
  }
}

onBlock((head) => {
  void sync(head)
  void refreshTotals()
})

// A different node or canvas is a different picture.
watch(
  () => [ready.value, endpoint.rpc, endpoint.contract, endpoint.canvas] as const,
  ([ok]) => {
    if (ok) void load()
    else {
      generation++
      board.status = 'idle'
    }
  },
)

/** The canvas, or a part of it, as a PNG. */
export function exportPng(x = 0, y = 0, w = W, h = H): Promise<Blob | null> {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')!.drawImage(surface, x, y, w, h, 0, 0, w, h)
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'))
}
