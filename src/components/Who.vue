<script setup lang="ts">
// A painter: their ZNS primary name when they have one that points back at
// them (the resolver checks), and their short address otherwise. Monospace
// only for the address, which is the thing that needs its columns to align.
import {computed, watch} from 'vue'
import {endpoint} from '../core/endpoint'
import {short} from '../core/format'
import {cachedName, nameOf} from '@zvm/web/names'

const props = withDefaults(defineProps<{address: string; head?: number; tail?: number; you?: boolean}>(), {head: 6, tail: 4, you: false})

const name = computed(() => cachedName(props.address))
watch(
  () => [props.address, endpoint.chainId] as const,
  ([a, chainId]) => a && nameOf(chainId, a),
  {immediate: true},
)
</script>

<template>
  <span v-if="you" class="truncate">You</span>
  <span v-else-if="name" class="truncate" :title="address">{{ name }}</span>
  <span v-else class="mono truncate" :title="address">{{ short(address, head, tail) }}</span>
</template>
