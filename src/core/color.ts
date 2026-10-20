// Colour as the canvas stores it, 0xRRGGBB, and the conversions the picker
// needs. Every colour is paintable: the contract stores 24 bits a pixel, so
// there is no palette to snap to.

export interface Hsv {
  h: number // 0..360
  s: number // 0..1
  v: number // 0..1
}

export const rgbOf = (c: number) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff] as const
export const pack = (r: number, g: number, b: number) => ((clamp(r) << 16) | (clamp(g) << 8) | clamp(b)) >>> 0
const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))

export function toHex(c: number): string {
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0')
}

/** "#ff0080", "ff0080" or "f08"; null when it is none of them. */
export function parseHex(input: string): number | null {
  let s = input.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.replace(/./g, (c) => c + c)
  return /^[0-9a-f]{6}$/i.test(s) ? parseInt(s, 16) : null
}

export function toHsv(c: number): Hsv {
  const [r, g, b] = rgbOf(c).map((x) => x / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return {h, s: max ? d / max : 0, v: max}
}

export function fromHsv({h, s, v}: Hsv): number {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return pack((r + m) * 255, (g + m) * 255, (b + m) * 255)
}

/** `top` over `under` at `alpha` (0..1), which is what a brush's opacity paints. */
export function blend(top: number, under: number, alpha: number): number {
  if (alpha >= 1) return top
  const [r1, g1, b1] = rgbOf(top)
  const [r2, g2, b2] = rgbOf(under)
  return pack(r2 + (r1 - r2) * alpha, g2 + (g1 - g2) * alpha, b2 + (b1 - b2) * alpha)
}

/** The colour `t` of the way from `a` to `b`. */
export const mix = (a: number, b: number, t: number) => blend(b, a, Math.max(0, Math.min(1, t)))

/** Largest per-channel difference, 0..255: the fill tool's tolerance measure. */
export function distance(a: number, b: number): number {
  const [r1, g1, b1] = rgbOf(a)
  const [r2, g2, b2] = rgbOf(b)
  return Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2))
}

/** Readable ink on a swatch of this colour. */
export const inkOn = (c: number) => {
  const [r, g, b] = rgbOf(c)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? '#0a1416' : '#ffffff'
}

/**
 * The swatches under the picker. Satoshi's Place offered sixteen fixed colours
 * and nothing else; here they are a starting point, and every one of the 16.7
 * million is a click on the field above them away. Three hue rings at
 * different lightness, the greys, and the Zenon brand colours.
 */
export const SWATCHES: number[] = (() => {
  const out: number[] = []
  for (const [s, v] of [
    [1, 1],
    [0.55, 1],
    [1, 0.55],
  ]) {
    for (let h = 0; h < 360; h += 30) out.push(fromHsv({h, s, v}))
  }
  out.push(0x000000, 0x333333, 0x666666, 0x999999, 0xcccccc, 0xffffff)
  out.push(0x00d557, 0x0061eb, 0xf91690, 0xf7931a, 0x6b3e26, 0xf5d0b0)
  return out
})()
