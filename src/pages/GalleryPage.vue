<script setup lang="ts">
// The canvas alone: no header, no tools, no panels, for a screen left up to
// watch the canvas move. It looks at the chain every ten seconds, whatever the
// refresh setting says (chain.ts setBeat), so a paint shows within a momentum
// of its block landing. Dragging and the wheel still move the view.
//
// The only controls are a way out and full screen, shown while the pointer
// moves and faded out a moment after it stops.
import {onBeforeUnmount, onMounted, ref} from 'vue'
import {useRouter} from 'vue-router'
import Board from '../components/Board.vue'
import Icon from '../components/Icon.vue'
import {setBeat} from '../core/chain'

const router = useRouter()
const shown = ref(true)
const full = ref(false)
let idle: number | undefined

function wake() {
  shown.value = true
  clearTimeout(idle)
  idle = window.setTimeout(() => (shown.value = false), 2500)
}

// Back to the canvas at the view the gallery was left at: Board keeps x, y
// and z in the address bar as the view moves.
function leave() {
  const q = Object.fromEntries(new URLSearchParams(location.search))
  router.push({path: '/', query: q})
}

async function toggleFull() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch {
    /* a browser that refuses full screen leaves the page as it is */
  }
}

const onFull = () => (full.value = !!document.fullscreenElement)

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && !document.fullscreenElement) leave()
  if (e.key === 'f' || e.key === 'F') toggleFull()
  wake()
}

onMounted(() => {
  setBeat(10)
  wake()
  window.addEventListener('pointermove', wake, {passive: true})
  window.addEventListener('keydown', onKey)
  document.addEventListener('fullscreenchange', onFull)
})
onBeforeUnmount(() => {
  setBeat(null)
  clearTimeout(idle)
  window.removeEventListener('pointermove', wake)
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('fullscreenchange', onFull)
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
})
</script>

<template>
  <div class="gallery fixed inset-0" :class="{calm: !shown}" data-testid="gallery-view">
    <!-- Sized by a wrapper, not by classes on Board: its root is `relative`,
         which beat a passed `absolute inset-0` and left it zero pixels tall,
         a blank page. -->
    <div class="absolute inset-0">
      <Board bare class="w-full h-full !rounded-none !border-0" />
    </div>
    <Transition name="fade">
      <div v-if="shown" class="absolute top-3 right-3 flex gap-2">
        <button class="btn btn-sm glass" :title="full ? 'Leave full screen (F)' : 'Full screen (F)'" @click="toggleFull">
          <Icon :name="full ? 'x' : 'expand'" :size="14" /> {{ full ? 'Exit full screen' : 'Full screen' }}
        </button>
        <button class="btn btn-sm glass" title="Back to the canvas (Esc)" data-testid="leave-gallery" @click="leave">
          <Icon name="left" :size="14" /> Canvas
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.gallery {
  background: var(--sunk);
  z-index: 60;
}
/* The pointer goes too when the controls do, so nothing is left over the art. */
.gallery.calm {
  cursor: none;
}
.gallery.calm :deep(canvas) {
  cursor: none !important;
}
</style>
