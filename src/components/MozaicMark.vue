<script setup lang="ts">
// Mozaic's mark: three tiles laid in the plasma gradient and a fourth just
// landing, tilted and off the grid, in the pink the whole app uses for "just
// arrived". It is the canvas's one event in miniature. Kept in sync with
// public/favicon.svg.
import {useId} from 'vue'

withDefaults(defineProps<{size?: number}>(), {size: 24})
const id = useId()
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true" class="shrink-0 overflow-visible">
    <defs>
      <!-- userSpaceOnUse: a bounding-box gradient paints nothing on a shape with no height, and pinning it to the grid keeps the three tiles one gradient. -->
      <linearGradient :id="`mz-${id}`" gradientUnits="userSpaceOnUse" x1="0" y1="2" x2="0" y2="22">
        <stop offset="0%" stop-color="hsl(120 86% 63%)" />
        <stop offset="100%" stop-color="hsl(145 100% 38%)" />
      </linearGradient>
    </defs>
    <path d="M2 12.6h8.4V21H2Z M12.6 12.6H21V21h-8.4Z M2 2h8.4v8.4H2Z" :fill="`url(#mz-${id})`" />
    <path class="mark-tile" d="M14.2 0.6l8.6 1.8-1.8 8.6-8.6-1.8Z" fill="#f91690" />
  </svg>
</template>
