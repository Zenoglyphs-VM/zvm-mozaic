<script setup lang="ts">
import {TOOLS} from '../core/prefs'
import Modal from './Modal.vue'

defineProps<{open: boolean}>()
const emit = defineEmits<{(e: 'close'): void}>()

const OTHER: [string, string][] = [
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['X', 'Swap main and second colour'],
  ['[ and ]', 'Brush smaller / larger'],
  ['Right button', 'Paint with the second colour'],
  ['Alt+click', 'Pick a colour with any tool'],
  ['Shift', 'Straight line from the last stroke; square shapes; 45 degree lines'],
  ['Space+drag', 'Move the view with any tool'],
  ['+ / - / 0', 'Zoom in / out / whole canvas'],
  ['M / Shift+M', 'Mirror left-right / top-bottom'],
  ['V', 'Show or hide the draft'],
  ['#', 'Pixel grid'],
  ['Ctrl+V', 'Paste an image as a stamp'],
  ['Enter', 'Paint the draft'],
  ['Esc', 'Drop the stamp in hand'],
]
</script>

<template>
  <Modal :open="open" title="Keyboard" :width="520" @close="emit('close')">
    <div class="p-4 grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-[13px]">
      <div v-for="t in TOOLS" :key="t.id" class="flex items-center justify-between gap-3">
        <span>{{ t.label }}</span><span class="kbd">{{ t.key }}</span>
      </div>
      <div v-for="[k, what] in OTHER" :key="k" class="flex items-center justify-between gap-3 sm:col-span-2 border-t border-line pt-1.5">
        <span class="text-dim">{{ what }}</span><span class="kbd whitespace-nowrap">{{ k }}</span>
      </div>
    </div>
  </Modal>
</template>
