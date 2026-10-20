// The canvas's own wire format: six bytes a pixel, index (3) then colour (3),
// big-endian, index = y * width + x. It is what Painted events carry, and what
// the page sends when a canvas has no router in front of it. The router's
// compact format, and how a draft is cut into transactions, are in ops.ts.

import type {Hex} from 'viem'
import type {Px} from './ops'

export {PER_SLOT, MAX_TX_GAS, type Px} from './ops'

const HEX = Array.from({length: 256}, (_, i) => i.toString(16).padStart(2, '0'))

export function encodePixels(list: Px[]): Hex {
  let s = '0x'
  for (const p of list) {
    s += HEX[p.index >> 16] + HEX[(p.index >> 8) & 0xff] + HEX[p.index & 0xff]
    s += HEX[p.rgb >> 16] + HEX[(p.rgb >> 8) & 0xff] + HEX[p.rgb & 0xff]
  }
  return s as Hex
}

/** A Painted event's pixels, parsed straight from the hex. */
export function decodePixels(hex: string, out: Px[] = []): Px[] {
  const s = hex.startsWith('0x') ? 2 : 0
  for (let o = s; o + 12 <= hex.length; o += 12) {
    out.push({index: parseInt(hex.slice(o, o + 6), 16), rgb: parseInt(hex.slice(o + 6, o + 12), 16)})
  }
  return out
}

/** Without a router the six-byte form is twice the size, so a planned batch is sent in halves. */
export const DIRECT_MAX_PIXELS = 2000
