<script setup lang="ts">
// Any of the 16.7 million colours the contract stores. A saturation and value
// field over a hue bar, a hex field for typing one in, R G B for exact work,
// the swatches for a quick start, and the colours used lately.
//
// The field and the bar take arrow keys when focused, so the whole picker
// works from a keyboard.
import {computed, ref, watch} from 'vue'
import {prefs, swapColors} from '../core/prefs'
import {fromHsv, inkOn, parseHex, rgbOf, pack, SWATCHES, toHex, toHsv, type Hsv} from '../core/color'
import Icon from './Icon.vue'

const hsv = ref<Hsv>(toHsv(prefs.primary))
// Hue is lost at grey and black; keep the one the person chose rather than
// snapping the bar to red whenever saturation touches zero.
watch(
  () => prefs.primary,
  (c) => {
    if (fromHsv(hsv.value) === c) return
    const next = toHsv(c)
    if (next.s === 0 || next.v === 0) next.h = hsv.value.h
    hsv.value = next
    hexDraft.value = toHex(c)
  },
)

function setHsv(next: Partial<Hsv>) {
  hsv.value = {...hsv.value, ...next}
  prefs.primary = fromHsv(hsv.value)
  hexDraft.value = toHex(prefs.primary)
}

const field = ref<HTMLDivElement | null>(null)
const bar = ref<HTMLDivElement | null>(null)

function dragIn(el: HTMLElement | null, e: PointerEvent, fn: (fx: number, fy: number) => void) {
  if (!el) return
  const move = (ev: PointerEvent) => {
    const r = el.getBoundingClientRect()
    fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)))
  }
  move(e)
  el.setPointerCapture(e.pointerId)
  el.onpointermove = move
  el.onpointerup = () => (el.onpointermove = el.onpointerup = null)
}

const onField = (e: PointerEvent) => dragIn(field.value, e, (fx, fy) => setHsv({s: fx, v: 1 - fy}))
const onBar = (e: PointerEvent) => dragIn(bar.value, e, (fx) => setHsv({h: Math.min(359.9, fx * 360)}))

function fieldKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 0.1 : 0.02
  const {s, v} = hsv.value
  const moves: Record<string, Partial<Hsv>> = {
    ArrowLeft: {s: Math.max(0, s - step)},
    ArrowRight: {s: Math.min(1, s + step)},
    ArrowUp: {v: Math.min(1, v + step)},
    ArrowDown: {v: Math.max(0, v - step)},
  }
  if (!moves[e.key]) return
  e.preventDefault()
  setHsv(moves[e.key])
}

function barKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 15 : 2
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  setHsv({h: (hsv.value.h + (e.key === 'ArrowLeft' ? -step : step) + 360) % 360})
}

const hexDraft = ref(toHex(prefs.primary))
function commitHex() {
  const c = parseHex(hexDraft.value)
  if (c === null) hexDraft.value = toHex(prefs.primary)
  else prefs.primary = c
}

const rgb = computed(() => rgbOf(prefs.primary))
function setChannel(k: 0 | 1 | 2, v: string) {
  const n = Math.max(0, Math.min(255, Math.round(Number(v) || 0)))
  const c = [...rgb.value]
  c[k] = n
  prefs.primary = pack(c[0], c[1], c[2])
}

const hueColor = computed(() => toHex(fromHsv({h: hsv.value.h, s: 1, v: 1})))
</script>

<template>
  <div class="grid gap-3" data-testid="color-picker">
    <div class="flex items-center gap-3">
      <!-- Main over second, as in every paint program: click the small one, or X, to swap. -->
      <div class="relative w-[54px] h-[46px] shrink-0">
        <button
          class="swatch-big absolute right-0 bottom-0 w-8 h-8"
          :style="{background: toHex(prefs.secondary)}"
          title="Second colour (right button). Click or press X to swap."
          @click="swapColors"
        />
        <span class="swatch-big absolute left-0 top-0 w-8 h-8" :style="{background: toHex(prefs.primary)}" title="Main colour" />
        <button class="absolute -right-1 -top-1 text-dim hover:text-fg" title="Swap colours (X)" @click="swapColors"><Icon name="swap" :size="12" /></button>
      </div>
      <label class="grow min-w-0">
        <span class="sr-only">Hex colour</span>
        <input
          v-model="hexDraft"
          class="input !py-1.5 uppercase"
          spellcheck="false"
          maxlength="7"
          data-testid="hex"
          @keydown.enter="commitHex"
          @blur="commitHex"
        />
      </label>
    </div>

    <div
      ref="field"
      class="sv relative h-[132px] rounded-md cursor-crosshair touch-none"
      :style="{background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})`}"
      tabindex="0"
      role="slider"
      aria-label="Saturation and brightness"
      :aria-valuetext="toHex(prefs.primary)"
      @pointerdown="onField"
      @keydown="fieldKey"
    >
      <span class="knob" :style="{left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: toHex(prefs.primary)}" />
    </div>

    <div
      ref="bar"
      class="hue relative h-3.5 rounded-full cursor-pointer touch-none"
      tabindex="0"
      role="slider"
      aria-label="Hue"
      :aria-valuenow="Math.round(hsv.h)"
      aria-valuemin="0"
      aria-valuemax="360"
      @pointerdown="onBar"
      @keydown="barKey"
    >
      <span class="knob top-1/2" :style="{left: `${(hsv.h / 360) * 100}%`, background: hueColor}" />
    </div>

    <div class="grid grid-cols-3 gap-1.5">
      <label v-for="(ch, k) in (['R', 'G', 'B'] as const)" :key="ch" class="flex items-center gap-1.5 field !py-1 !px-2">
        <span class="ledger">{{ ch }}</span>
        <input
          class="w-full bg-transparent mono text-[12.5px] outline-none"
          type="number"
          min="0"
          max="255"
          :value="rgb[k]"
          @change="setChannel(k as 0 | 1 | 2, ($event.target as HTMLInputElement).value)"
        />
      </label>
    </div>

    <div class="grid grid-cols-12 gap-1">
      <button
        v-for="c in SWATCHES"
        :key="c"
        class="swatch"
        :class="{on: c === prefs.primary}"
        :style="{background: toHex(c), '--ink': inkOn(c)}"
        :title="toHex(c)"
        @click="prefs.primary = c"
        @contextmenu.prevent="prefs.secondary = c"
      />
    </div>

    <div v-if="prefs.recent.length" class="grid gap-1">
      <span class="ledger">Recent</span>
      <div class="flex flex-wrap gap-1">
        <button
          v-for="c in prefs.recent"
          :key="c"
          class="swatch w-[18px]"
          :class="{on: c === prefs.primary}"
          :style="{background: toHex(c), '--ink': inkOn(c)}"
          :title="toHex(c)"
          @click="prefs.primary = c"
          @contextmenu.prevent="prefs.secondary = c"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.swatch-big {
  border-radius: 7px;
  border: 2px solid var(--raised);
  box-shadow: 0 0 0 1px var(--line-strong), 0 2px 6px rgb(0 0 0 / 0.3);
}
.sv {
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.15);
}
.hue {
  background: linear-gradient(90deg, #f00, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00);
}
.knob {
  position: absolute;
  width: 16px;
  height: 16px;
  border-radius: 99px;
  border: 2.5px solid #fff;
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.35), 0 2px 5px rgb(0 0 0 / 0.4);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.swatch {
  aspect-ratio: 1;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgb(128 128 128 / 0.35);
  transition: transform 120ms var(--ease);
}
.swatch:hover {
  transform: scale(1.18);
  z-index: 1;
}
.swatch.on {
  box-shadow: inset 0 0 0 2px var(--ink), 0 0 0 1px var(--line-strong);
}
input[type='number']::-webkit-inner-spin-button {
  appearance: none;
}
</style>
