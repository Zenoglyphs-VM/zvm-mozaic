<script setup lang="ts">
// A side panel that folds to its header. The header keeps a summary (the
// colours in hand, the tool in hand), so a folded panel still says what it
// holds.
import {useId} from 'vue'
import Icon from './Icon.vue'

defineProps<{open: boolean; title: string}>()
const emit = defineEmits<{(e: 'toggle'): void}>()
const id = useId()
</script>

<template>
  <section class="panel">
    <button
      class="fold-head w-full flex items-center gap-2 px-3.5 py-2.5 text-left"
      :aria-expanded="open"
      :aria-controls="id"
      :data-fold="title"
      @click="emit('toggle')"
    >
      <span class="font-semibold text-[14px] tracking-[-0.01em]">{{ title }}</span>
      <span class="grow min-w-0 flex items-center justify-end gap-2"><slot name="summary" /></span>
      <Icon name="down" :size="15" class="chev text-dim" :class="{on: open}" />
    </button>
    <div v-show="open" :id="id" class="px-3.5 pb-3.5">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.fold-head {
  border-radius: var(--radius);
  transition: background 150ms var(--ease);
}
.fold-head:hover {
  background: color-mix(in srgb, var(--fg) 4%, transparent);
}
.chev {
  transition: transform 200ms var(--ease-out);
}
.chev.on {
  transform: rotate(180deg);
}
</style>
