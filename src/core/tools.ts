// What each tool paints, as lists of pixel indices. Pure functions of their
// inputs, so the page's preview and the stroke it commits are the same pixels.

import {distance, mix} from './color'

export interface Pt {
  x: number
  y: number
}

/** A brush's footprint centred on a point: a square, or a disc for round. */
export function stamp(c: Pt, size: number, round: boolean, out: Pt[] = []): Pt[] {
  const r = (size - 1) / 2
  const lo = -Math.floor(r)
  const hi = Math.ceil(r)
  for (let dy = lo; dy <= hi; dy++)
    for (let dx = lo; dx <= hi; dx++) {
      if (round && size > 2) {
        const ex = dx - (size % 2 ? 0 : 0.5)
        const ey = dy - (size % 2 ? 0 : 0.5)
        if (ex * ex + ey * ey > (size / 2) * (size / 2)) continue
      }
      out.push({x: c.x + dx, y: c.y + dy})
    }
  return out
}

/** Bresenham: every pixel a one-pixel line through a and b crosses. */
export function line(a: Pt, b: Pt): Pt[] {
  const out: Pt[] = []
  let {x: x0, y: y0} = a
  const dx = Math.abs(b.x - x0)
  const sx = x0 < b.x ? 1 : -1
  const dy = -Math.abs(b.y - y0)
  const sy = y0 < b.y ? 1 : -1
  let err = dx + dy
  for (;;) {
    out.push({x: x0, y: y0})
    if (x0 === b.x && y0 === b.y) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x0 += sx
    }
    if (e2 <= dx) {
      err += dx
      y0 += sy
    }
  }
  return out
}

/** A line drawn with a brush: the brush stamped along it. */
export function brushLine(a: Pt, b: Pt, size: number, round: boolean): Pt[] {
  if (size <= 1) return line(a, b)
  const out: Pt[] = []
  for (const p of line(a, b)) stamp(p, size, round, out)
  return out
}

export function rect(a: Pt, b: Pt, filled: boolean, thickness: number): Pt[] {
  const x0 = Math.min(a.x, b.x)
  const x1 = Math.max(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  const y1 = Math.max(a.y, b.y)
  const t = Math.max(1, thickness)
  const out: Pt[] = []
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (!filled && x >= x0 + t && x <= x1 - t && y >= y0 + t && y <= y1 - t) continue
      out.push({x, y})
    }
  return out
}

/** The ellipse inscribed in the box a..b, filled or as a ring `thickness` wide. */
export function ellipse(a: Pt, b: Pt, filled: boolean, thickness: number): Pt[] {
  const x0 = Math.min(a.x, b.x)
  const x1 = Math.max(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  const y1 = Math.max(a.y, b.y)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const rx = (x1 - x0) / 2 + 0.5
  const ry = (y1 - y0) / 2 + 0.5
  const t = Math.max(1, thickness)
  const irx = rx - t
  const iry = ry - t
  const out: Pt[] = []
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx
      const dy = y - cy
      if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) > 1) continue
      if (!filled && irx > 0 && iry > 0 && (dx * dx) / (irx * irx) + (dy * dy) / (iry * iry) < 1) continue
      out.push({x, y})
    }
  return out
}

/** Pixels of the colour under `start`, within tolerance, touching it edge to edge. */
export function flood(start: Pt, w: number, h: number, colorAt: (i: number) => number, tolerance: number, limit: number): {pts: Pt[]; capped: boolean} {
  const target = colorAt(start.y * w + start.x)
  const seen = new Uint8Array(w * h)
  const stack = [start.y * w + start.x]
  seen[stack[0]] = 1
  const out: Pt[] = []
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w
    const y = (i - x) / w
    out.push({x, y})
    if (out.length >= limit) return {pts: out, capped: true}
    const next = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]
    for (const n of next) {
      if (n < 0 || seen[n]) continue
      seen[n] = 1
      if (distance(colorAt(n), target) <= tolerance) stack.push(n)
    }
  }
  return {pts: out, capped: false}
}

/** Random dots inside a disc of the brush's size. */
export function spray(c: Pt, size: number, density: number): Pt[] {
  const r = Math.max(2, size * 1.5)
  const out: Pt[] = []
  for (let i = 0; i < density; i++) {
    const a = Math.random() * Math.PI * 2
    const d = Math.sqrt(Math.random()) * r
    out.push({x: Math.round(c.x + Math.cos(a) * d), y: Math.round(c.y + Math.sin(a) * d)})
  }
  return out
}

/** A linear gradient along a..b, clamped at both ends, for each point. */
export function gradientColor(p: Pt, a: Pt, b: Pt, from: number, to: number): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const len2 = vx * vx + vy * vy
  if (!len2) return from
  return mix(from, to, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)
}

/** The points reflected across the mirror axes that are on. */
export function mirrored(pts: Pt[], ax: number | null, ay: number | null): Pt[] {
  if (ax === null && ay === null) return pts
  const out = [...pts]
  for (const p of pts) {
    if (ax !== null) out.push({x: 2 * ax - p.x, y: p.y})
    if (ay !== null) out.push({x: p.x, y: 2 * ay - p.y})
    if (ax !== null && ay !== null) out.push({x: 2 * ax - p.x, y: 2 * ay - p.y})
  }
  return out
}

/** Shift held: snap the end of a line to 0, 45 or 90 degrees from its start. */
export function snap45(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  if (adx > 2 * ady) return {x: b.x, y: a.y}
  if (ady > 2 * adx) return {x: a.x, y: b.y}
  const d = Math.max(adx, ady)
  return {x: a.x + Math.sign(dx) * d, y: a.y + Math.sign(dy) * d}
}

/** Shift held: make a box square, keeping the corner the drag started from. */
export function square(a: Pt, b: Pt): Pt {
  const d = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  return {x: a.x + Math.sign(b.x - a.x || 1) * d, y: a.y + Math.sign(b.y - a.y || 1) * d}
}
