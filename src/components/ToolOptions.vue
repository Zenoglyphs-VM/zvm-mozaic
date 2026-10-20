<script setup lang="ts">
// The current tool's settings, and only those: a brush has a size, a fill has
// a tolerance, a rectangle can be hollow. What does not apply is not shown.
import {computed} from 'vue'
import {prefs, TOOLS} from '../core/prefs'
import {guide} from '../core/image'
import Icon from './Icon.vue'

const tool = computed(() => TOOLS.find((t) => t.id === prefs.tool)!)
const has = (...tools: string[]) => tools.includes(prefs.tool)
const fill = (v: number, lo: number, hi: number) => ({'--fill': `${((v - lo) / (hi - lo)) * 100}%`})
</script>

<template>
  <div class="grid gap-3 text-[13px]" data-testid="tool-options">
    <p class="text-[12px] text-dim">{{ tool.tip }}</p>

    <label v-if="has('brush', 'eraser', 'line', 'rect', 'ellipse', 'spray')" class="grid gap-1.5">
      <span class="flex justify-between">
        <span class="text-dim">{{ has('rect', 'ellipse') ? 'Outline width' : 'Size' }}</span><span class="mono">{{ prefs.size }} px</span>
      </span>
      <input v-model.number="prefs.size" type="range" min="1" max="32" class="range" :style="fill(prefs.size, 1, 32)" data-testid="size" />
    </label>

    <div v-if="has('brush', 'eraser', 'line')" class="seg self-start">
      <button :class="{on: !prefs.round}" @click="prefs.round = false">Square tip</button>
      <button :class="{on: prefs.round}" @click="prefs.round = true">Round tip</button>
    </div>

    <div v-if="has('rect', 'ellipse')" class="seg self-start">
      <button :class="{on: prefs.filled}" data-testid="filled" @click="prefs.filled = true">Filled</button>
      <button :class="{on: !prefs.filled}" @click="prefs.filled = false">Outline</button>
    </div>

    <label v-if="has('fill', 'gradient')" class="grid gap-1.5">
      <span class="flex justify-between"><span class="text-dim">Tolerance</span><span class="mono">{{ prefs.tolerance }}</span></span>
      <input v-model.number="prefs.tolerance" type="range" min="0" max="128" class="range" :style="fill(prefs.tolerance, 0, 128)" />
    </label>

    <label v-if="has('spray')" class="grid gap-1.5">
      <span class="flex justify-between"><span class="text-dim">Density</span><span class="mono">{{ prefs.density }}</span></span>
      <input v-model.number="prefs.density" type="range" min="2" max="60" class="range" :style="fill(prefs.density, 2, 60)" />
    </label>

    <label v-if="has('brush', 'line', 'rect', 'ellipse', 'fill', 'spray', 'gradient')" class="grid gap-1.5">
      <span class="flex justify-between"><span class="text-dim">Opacity</span><span class="mono">{{ Math.round(prefs.opacity * 100) }}%</span></span>
      <input v-model.number="prefs.opacity" type="range" min="0.05" max="1" step="0.05" class="range" :style="fill(prefs.opacity, 0.05, 1)" />
    </label>

    <div class="grid gap-2 border-t border-line pt-3">
      <label class="flex items-center gap-2 cursor-pointer">
        <input v-model="prefs.showDraft" type="checkbox" class="check" /> Show my draft <span class="kbd ml-auto">V</span>
      </label>
      <label class="flex items-center gap-2 cursor-pointer">
        <input v-model="prefs.grid" type="checkbox" class="check" /> Pixel grid when zoomed in <span class="kbd ml-auto">#</span>
      </label>
      <label class="flex items-center gap-2 cursor-pointer"><input v-model="prefs.fresh" type="checkbox" class="check" /> Ring new paints in pink</label>
    </div>

    <div v-if="guide.picture" class="grid gap-2 border-t border-line pt-3">
      <div class="flex items-center gap-2 min-w-0">
        <Icon name="pin" :size="14" class="text-dim" />
        <span class="truncate">Guide: {{ guide.picture.name }}</span>
        <button class="btn btn-sm btn-quiet ml-auto px-1.5" :title="guide.visible ? 'Hide the guide' : 'Show the guide'" @click="guide.visible = !guide.visible">
          <Icon :name="guide.visible ? 'eye' : 'eyeOff'" :size="14" />
        </button>
        <button class="btn btn-sm btn-quiet px-1.5" title="Remove the guide" @click="guide.picture = null"><Icon name="x" :size="14" /></button>
      </div>
      <label class="grid gap-1.5">
        <span class="flex justify-between"><span class="text-dim">Guide opacity</span><span class="mono">{{ Math.round(guide.opacity * 100) }}%</span></span>
        <input v-model.number="guide.opacity" type="range" min="0.1" max="1" step="0.05" class="range" :style="fill(guide.opacity, 0.1, 1)" />
      </label>
      <div class="grid grid-cols-2 gap-1.5">
        <label class="field !py-1 !px-2 flex items-center gap-1.5">
          <span class="ledger">X</span><input v-model.number="guide.x" type="number" class="w-full bg-transparent mono text-[12.5px] outline-none" />
        </label>
        <label class="field !py-1 !px-2 flex items-center gap-1.5">
          <span class="ledger">Y</span><input v-model.number="guide.y" type="number" class="w-full bg-transparent mono text-[12.5px] outline-none" />
        </label>
      </div>
    </div>
  </div>
</template>
