<script setup lang="ts">
// The tools, and the few actions a painter reaches for mid-stroke. A column
// beside the canvas on a wide screen, a row above it on a phone.
import {TOOLS, prefs, chooseTool, putDown, type RailAction} from '../core/prefs'
import {draftState} from '../core/draft'
import Icon from './Icon.vue'

const emit = defineEmits<{(e: 'action', name: RailAction): void}>()
</script>

<template>
  <nav class="rail panel p-1.5 flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible no-scrollbar" aria-label="Tools">
    <button
      v-for="t in TOOLS"
      :key="t.id"
      class="tool"
      :class="{on: prefs.tool === t.id}"
      :title="`${t.label} (${t.key}). ${t.tip}`"
      :aria-pressed="prefs.tool === t.id"
      :data-tool="t.id"
      @click="chooseTool(t.id)"
      @contextmenu.prevent="putDown(t.id)"
    >
      <Icon :name="t.icon as any" :size="17" />
      <span class="sr-only">{{ t.label }}</span>
    </button>

    <span class="sep" />

    <button class="tool" :disabled="!draftState.canUndo" title="Undo (Ctrl+Z)" @click="emit('action', 'undo')"><Icon name="undo" :size="17" /></button>
    <button class="tool" :disabled="!draftState.canRedo" title="Redo (Ctrl+Y)" @click="emit('action', 'redo')"><Icon name="redo" :size="17" /></button>
    <button class="tool" :class="{on: prefs.mirrorX}" title="Mirror left and right, across the middle of the view (M)" @click="emit('action', 'mirrorX')">
      <Icon name="flipX" :size="17" />
    </button>
    <button class="tool" :class="{on: prefs.mirrorY}" title="Mirror top and bottom (Shift+M)" @click="emit('action', 'mirrorY')"><Icon name="flipY" :size="17" /></button>
    <button class="tool" title="Bring in an image: stamp it, or pin it as a guide to trace. Ctrl+V pastes one." data-testid="import" @click="emit('action', 'import')">
      <Icon name="image" :size="17" />
    </button>

    <span class="sep" />

    <button class="tool" title="Zoom in (+)" @click="emit('action', 'zoomIn')"><Icon name="zoomIn" :size="17" /></button>
    <button class="tool" title="Zoom out (-)" @click="emit('action', 'zoomOut')"><Icon name="zoomOut" :size="17" /></button>
    <button class="tool" title="Whole canvas (0)" @click="emit('action', 'fit')"><Icon name="fit" :size="17" /></button>
    <button class="tool hidden lg:grid" title="Keyboard shortcuts (?)" @click="emit('action', 'keys')"><Icon name="keyboard" :size="17" /></button>
  </nav>
</template>

<style scoped>
/* Relative, so each button's absolutely placed screen-reader label is held
   inside the rail's scroller. Without it the labels were placed against the
   page, escaped the scroller's clip, and pushed a phone's page 17 px wide. */
.tool {
  position: relative;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 7px;
  color: var(--dim);
  transition:
    color 150ms var(--ease),
    background 150ms var(--ease),
    transform 150ms var(--ease);
}
.tool:hover:not(:disabled) {
  color: var(--fg);
  background: var(--raised);
}
.tool:active:not(:disabled) {
  transform: scale(0.94);
}
.tool:disabled {
  opacity: 0.35;
}
.tool.on {
  color: #04140a;
  background: var(--plasma);
  box-shadow: 0 2px 10px -3px color-mix(in srgb, var(--znn) 60%, transparent);
}
.sep {
  flex: none;
  background: var(--line);
  width: 1px;
  height: 26px;
  margin: 6px 3px;
}
@media (min-width: 1024px) {
  .rail {
    max-height: 100%;
    overflow-y: auto;
  }
  .tool {
    width: 36px;
    height: 34px;
  }
  .sep {
    width: 24px;
    height: 1px;
    margin: 2px 6px;
  }
}
</style>
