<script setup lang="ts">
// The chain's heartbeat, drawn as a hairline under the header.
//
// This is the one thing on the page that moves without being asked to, and it
// is here because it answers the question every new user of this chain has:
// why did my purchase not confirm instantly? One momentum orders one block, about
// every fifteen seconds, so the line fills across the expected gap and snaps
// back green when a block actually lands. Blue while NoM is still ordering,
// green once the ZVM has executed, which is the colour rule the whole app uses.
//
// The width is written straight to the element inside a rAF rather than held in
// reactive state: a sixty-times-a-second re-render for a two pixel line would
// re-run every binding on the page.
import {onMounted, onUnmounted, ref} from 'vue'
import {chain} from '../core/chain'

const bar = ref<HTMLElement | null>(null)
const flash = ref<HTMLElement | null>(null)

let frame = 0
let lastHead: number | null = null

function tick() {
  frame = requestAnimationFrame(tick)
  const el = bar.value
  if (!el) return
  if (chain.head === null) {
    el.style.transform = 'scaleX(0)'
    return
  }
  if (chain.head !== lastHead) {
    lastHead = chain.head
    const f = flash.value
    if (f) {
      f.style.transition = 'none'
      f.style.opacity = '1'
      // Next frame, so the browser paints the reset before the fade starts.
      requestAnimationFrame(() => {
        f.style.transition = 'opacity 900ms var(--ease)'
        f.style.opacity = '0'
      })
    }
  }
  const elapsed = (Date.now() - chain.landedAt) / 1000
  const share = Math.min(1, elapsed / Math.max(4, chain.interval))
  el.style.transform = `scaleX(${share.toFixed(4)})`
}

onMounted(() => {
  frame = requestAnimationFrame(tick)
})
onUnmounted(() => cancelAnimationFrame(frame))
</script>

<template>
  <div class="pulse" role="presentation">
    <span ref="bar" class="pulse__fill" />
    <span ref="flash" class="pulse__flash" />
  </div>
</template>

<style scoped>
.pulse {
  position: relative;
  height: 2px;
  width: 100%;
  overflow: hidden;
  background: color-mix(in srgb, var(--line) 70%, transparent);
}

/* Blue: NoM is still deciding the order this block will carry. */
.pulse__fill {
  position: absolute;
  inset: 0;
  transform-origin: left center;
  transform: scaleX(0);
  background: linear-gradient(90deg, color-mix(in srgb, var(--nom) 40%, transparent), var(--nom-ink));
  will-change: transform;
}

/* Green: a block landed, so what was ordered has now been executed. */
.pulse__flash {
  position: absolute;
  inset: 0;
  opacity: 0;
  background: var(--plasma);
  pointer-events: none;
}
</style>
