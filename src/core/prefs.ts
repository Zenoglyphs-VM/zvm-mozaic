// The painter's settings: tool, colours, brush. Kept in this browser, so a
// reload comes back to the same brush.

import {reactive, watch} from 'vue'

export type Tool = 'brush' | 'eraser' | 'line' | 'rect' | 'ellipse' | 'fill' | 'gradient' | 'spray' | 'picker' | 'pan'

export interface Prefs {
  tool: Tool
  primary: number
  secondary: number
  recent: number[]
  size: number
  round: boolean
  /** 0.05..1: how much of the colour a stroke lays over what is under it. */
  opacity: number
  filled: boolean
  /** 0..255: how different a neighbour may be and still fill. */
  tolerance: number
  /** Dots per spray dab. */
  density: number
  mirrorX: boolean
  mirrorY: boolean
  grid: boolean
  showDraft: boolean
  /** Show the pixels others painted in the last few minutes. */
  fresh: boolean
  /** Seconds between looks at the chain; 0 is paused. */
  refresh: number
  /** Sign every batch in the wallet rather than through a paint session. */
  signEach: boolean
  /** Which side panels are unfolded. Colour and tool settings start folded. */
  open: {color: boolean; tool: boolean}
  /** The drawing tool held last: where putting the move tool or picker down returns to. */
  drawTool: Tool
}

const KEY = 'mozaic.prefs'

const DEFAULTS: Prefs = {
  tool: 'pan',
  primary: 0x00d557,
  secondary: 0xffffff,
  recent: [],
  size: 1,
  round: false,
  opacity: 1,
  filled: true,
  tolerance: 0,
  density: 12,
  mirrorX: false,
  mirrorY: false,
  grid: true,
  showDraft: true,
  fresh: true,
  refresh: 15,
  signEach: false,
  open: {color: false, tool: false},
  drawTool: 'brush',
}

/**
 * The move tool and the colour picker are ones a painter picks up for a
 * moment, so choosing either again, or right-clicking it or the canvas while
 * it is on, puts it down and returns to the drawing tool held before.
 */
const PASSING: Tool[] = ['pan', 'picker']

/**
 * Every visit starts with the move tool, the owner's call (2026-09-29): a
 * first click on the canvas looks around rather than paints. The drawing tool
 * is remembered across visits, so putting the hand down returns to it.
 */
function read(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const drawTool = saved.drawTool ?? (saved.tool && !PASSING.includes(saved.tool) ? saved.tool : 'brush')
    return {...DEFAULTS, ...saved, tool: 'pan', drawTool}
  } catch {
    return {...DEFAULTS}
  }
}

export const prefs = reactive<Prefs>(read())

/** Where the mirror axes cross, in canvas pixels: set when mirroring is turned on. */
export const axis = reactive({x: 500, y: 500})

let timer: number | undefined
watch(
  prefs,
  () => {
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(prefs))
      } catch {
        /* blocked storage: the settings hold for this tab */
      }
    }, 300)
  },
  {deep: true},
)

/** A colour was used to paint: it goes to the front of the recent row. */
export function used(color: number) {
  prefs.recent = [color, ...prefs.recent.filter((c) => c !== color)].slice(0, 14)
}

watch(
  () => prefs.tool,
  (next) => {
    if (!PASSING.includes(next)) prefs.drawTool = next
  },
)

/** Chooses a tool; choosing the move tool or the picker when it is already on puts it down. */
export function chooseTool(t: Tool) {
  prefs.tool = prefs.tool === t && PASSING.includes(t) ? prefs.drawTool : t
}

/** Puts down the move tool or the picker, back to the tool held before. */
export function putDown(t: Tool) {
  if (prefs.tool === t && PASSING.includes(t)) prefs.tool = prefs.drawTool
}

export function swapColors() {
  ;[prefs.primary, prefs.secondary] = [prefs.secondary, prefs.primary]
}

/**
 * How often the page looks at the chain. The default is one momentum: a new
 * block cannot land faster than that, so polling more often only spends the
 * node's time learning that nothing changed. Each look is one eth_blockNumber;
 * a block that moved costs one eth_getLogs and one block read on top.
 */
export const REFRESH_CHOICES = [
  {s: 15, label: '15 s'},
  {s: 30, label: '30 s'},
  {s: 60, label: '1 min'},
  {s: 0, label: 'Paused'},
]

export type RailAction = 'undo' | 'redo' | 'import' | 'mirrorX' | 'mirrorY' | 'fit' | 'zoomIn' | 'zoomOut' | 'keys'

export const TOOLS: {id: Tool; label: string; key: string; icon: string; tip: string}[] = [
  {id: 'pan', label: 'Move', key: 'H', icon: 'hand', tip: 'Drag the canvas; every visit starts with it. Right-click the canvas or this button, or click it again, to go back to your drawing tool.'},
  {id: 'brush', label: 'Brush', key: 'B', icon: 'brush', tip: 'Paint with the brush. Shift draws a straight line from the last point.'},
  {id: 'eraser', label: 'Eraser', key: 'E', icon: 'eraser', tip: 'Take pixels out of your draft. It cannot unpaint the chain.'},
  {id: 'line', label: 'Line', key: 'L', icon: 'line', tip: 'Drag a line. Shift snaps to 45 degrees.'},
  {id: 'rect', label: 'Rectangle', key: 'R', icon: 'square', tip: 'Drag a rectangle. Shift makes it square.'},
  {id: 'ellipse', label: 'Ellipse', key: 'O', icon: 'circle', tip: 'Drag an ellipse. Shift makes it a circle.'},
  {id: 'fill', label: 'Fill', key: 'G', icon: 'bucket', tip: 'Fill the area of one colour you click. On an empty canvas that is all of it.'},
  {id: 'gradient', label: 'Gradient', key: 'U', icon: 'blend', tip: 'Drag across an area to fill it from the main colour to the second.'},
  {id: 'spray', label: 'Spray', key: 'S', icon: 'spray', tip: 'Scatter pixels inside the brush.'},
  {id: 'picker', label: 'Pick colour', key: 'I', icon: 'pipette', tip: 'Take a colour from the canvas. Alt-click does this with any tool. Click it again, or right-click it, to go back.'},
]
