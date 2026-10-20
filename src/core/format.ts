// Every number a person reads comes from the shared formatter, so this app and
// the other ZVM front ends round, group and truncate identically.

export {ago, compact, number, short, units, znn} from '@zvm/web/format'

export const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** 0xRRGGBB as #rrggbb. */
export const hex = (rgb: number) => '#' + (rgb & 0xffffff).toString(16).padStart(6, '0')
