// The router's compact paint format, and how a draft is cut into transactions.
//
// Shared by the page and the scripts: Node runs this file as it is (type
// stripping), so it imports nothing and uses no TypeScript that is not erased.
// contracts/MozaicRouter.sol is the other half; scripts/test-contract.mjs
// checks that what this encodes expands on chain to exactly the pixels given.
//
//   0x01 index(3) count(2) rgb(3)             count pixels from index, one colour
//   0x02 index(3) count(2) rgb(3) * count     count pixels from index, a colour each
//
// Why it matters: on the ZVM a relayer can afford about three full NoM blocks a
// momentum, so what limits painting is bytes. A run of one colour is 9 bytes
// however long; a span is 3 bytes a pixel against the canvas's 6.

export interface Px {
  index: number
  rgb: number
}

export const PER_SLOT = 10
const MAX_COUNT = 0xffff

/** Karst's per-transaction gas cap. */
export const MAX_TX_GAS = 16_777_216n
/** What a batch's modelled gas may reach: estimateGas's 10% margin on top still clears the cap. */
export const BATCH_GAS = 13_500_000n
/** Ops per transaction, so each fits in one NoM block (16 KB) with the transaction around it. */
export const BATCH_BYTES = 12_000

const HEX = Array.from({length: 256}, (_, i) => i.toString(16).padStart(2, '0'))
const h3 = (v: number) => HEX[(v >> 16) & 0xff] + HEX[(v >> 8) & 0xff] + HEX[v & 0xff]
const h2 = (v: number) => HEX[(v >> 8) & 0xff] + HEX[v & 0xff]

/**
 * Encodes pixels, which must be in index order with no index twice, as ops:
 * a stretch of three or more of one colour is a run, anything else a span.
 */
export function encodeOps(sorted: Px[]): string {
  let s = '0x'
  const n = sorted.length
  let i = 0
  while (i < n) {
    // A segment: consecutive indices.
    let j = i
    while (j + 1 < n && sorted[j + 1].index === sorted[j].index + 1) j++
    let k = i
    while (k <= j) {
      let r = k
      while (r + 1 <= j && sorted[r + 1].rgb === sorted[k].rgb && r + 1 - k < MAX_COUNT) r++
      if (r - k + 1 >= 3) {
        s += '01' + h3(sorted[k].index) + h2(r - k + 1) + h3(sorted[k].rgb)
        k = r + 1
        continue
      }
      // A span, until a run of three begins or the segment ends.
      const start = k
      while (k <= j && k - start < MAX_COUNT) {
        if (k > start && k + 2 <= j && sorted[k + 1].rgb === sorted[k].rgb && sorted[k + 2].rgb === sorted[k].rgb) break
        k++
      }
      s += '02' + h3(sorted[start].index) + h2(k - start)
      for (let q = start; q < k; q++) s += h3(sorted[q].rgb)
    }
    i = j + 1
  }
  return s
}

/** The pixels ops expand to, as the router does it. */
export function decodeOps(hex: string): Px[] {
  const out: Px[] = []
  let o = hex.startsWith('0x') ? 2 : 0
  while (o < hex.length) {
    const op = parseInt(hex.slice(o, o + 2), 16)
    const index = parseInt(hex.slice(o + 2, o + 8), 16)
    const count = parseInt(hex.slice(o + 8, o + 12), 16)
    if (op === 1) {
      const rgb = parseInt(hex.slice(o + 12, o + 18), 16)
      for (let k = 0; k < count; k++) out.push({index: index + k, rgb})
      o += 18
    } else if (op === 2) {
      for (let k = 0; k < count; k++) out.push({index: index + k, rgb: parseInt(hex.slice(o + 12 + k * 6, o + 18 + k * 6), 16)})
      o += 12 + count * 6
    } else throw new Error(`unknown op ${op}`)
  }
  return out
}

// Measured through the router on a fork of chain 69 (scripts/test-router.mjs
// prints it): 4,000 pixels over 400 slots cost 11.80M gas on blank rows and
// 4.96M repainted, which solves to about 697 a pixel, 22,300 a slot written for
// the first time and 5,200 one already written. The model rounds each up, so it
// errs over, never under: a batch cut to it must fit the transaction cap.
const GAS_BASE = 90_000n
const GAS_PIXEL = 750n
const GAS_FRESH_SLOT = 23_000n
const GAS_WRITTEN_SLOT = 6_000n
/** Each byte of ops as calldata, at Prague's floor: 12 KB of photo cost 0.43M more than 9 bytes of solid run. */
const GAS_OPS_BYTE = 40n
const slotGas = (blank: boolean) => (blank ? GAS_FRESH_SLOT : GAS_WRITTEN_SLOT)

/**
 * Gas for a batch through the router. `blank` says whether a slot holds ten
 * white pixels, which is to say zero; `opsBytes` is the encoded size, worked
 * out here when not given.
 */
export function gasFor(batch: Px[], blank: (slot: number) => boolean, opsBytes = (encodeOps(batch).length - 2) / 2): bigint {
  let gas = GAS_BASE + BigInt(batch.length) * GAS_PIXEL + BigInt(opsBytes) * GAS_OPS_BYTE
  let last = -1
  for (const p of batch) {
    const slot = Math.floor(p.index / PER_SLOT)
    if (slot === last) continue
    last = slot
    gas += slotGas(blank(slot))
  }
  return gas
}

export interface Batch {
  px: Px[]
  ops: string
  gas: bigint
}

/**
 * Cuts pixels, in index order, into transactions: as many as fit under the gas
 * budget and one NoM block's bytes. A solid fill is gas-bound, about 4,300
 * fresh pixels a transaction in 9 bytes; a photo is byte-bound, about 4,000
 * pixels in 12 KB.
 */
export function plan(sorted: Px[], blank: (slot: number) => boolean): Batch[] {
  const out: Batch[] = []
  let cur: Px[] = []
  let gas = GAS_BASE
  let bytes = 0
  let last = -1
  let prev = -2
  let same = 0
  let prevRgb = -1
  const flush = () => {
    if (cur.length) split(cur, blank, out)
    cur = []
    gas = GAS_BASE
    bytes = 0
    last = -1
    prev = -2
    same = 0
    prevRgb = -1
  }
  // Bytes are counted as the encoder will spend them, from above: 3 a pixel
  // and a new op's 6-byte header where the indices break, except that from the
  // third pixel of one colour on, a run has already paid for the rest.
  const cost = (p: Px) => {
    const next = p.index === prev + 1
    const run = next && p.rgb === prevRgb ? same + 1 : 1
    return {bytes: run >= 3 ? 0 : 3 + (next ? 0 : 6), run}
  }
  for (const p of sorted) {
    const slot = Math.floor(p.index / PER_SLOT)
    const add = () => GAS_PIXEL + (slot === last ? 0n : slotGas(blank(slot)))
    const more = cost(p).bytes
    if (gas + add() + BigInt(bytes + more) * GAS_OPS_BYTE > BATCH_GAS || bytes + more > BATCH_BYTES) flush()
    const c = cost(p)
    gas += add()
    bytes += c.bytes
    same = c.run
    last = slot
    prev = p.index
    prevRgb = p.rgb
    cur.push(p)
  }
  flush()
  return out
}

function split(px: Px[], blank: (slot: number) => boolean, out: Batch[]) {
  const ops = encodeOps(px)
  if ((ops.length - 2) / 2 <= BATCH_BYTES || px.length === 1) {
    out.push({px, ops, gas: gasFor(px, blank, (ops.length - 2) / 2)})
    return
  }
  const mid = Math.floor(px.length / 2)
  split(px.slice(0, mid), blank, out)
  split(px.slice(mid), blank, out)
}
