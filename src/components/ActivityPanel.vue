<script setup lang="ts">
// Who has been painting: every paint in the last day as it lands, and who
// painted most. Click a paint to fly to it.
//
// All of it is read from the contract's Painted events, which the canvas
// loads anyway to know who painted each pixel, so this costs no request of
// its own.
import {computed, ref} from 'vue'
import {board, paints, type Paint} from '../core/board'
import {chain} from '../core/chain'
import {wallet} from '../core/wallet'
import {explorerUrl} from '../core/endpoint'
import {compact, number, same, units} from '../core/format'
import Avatar from './Avatar.vue'
import Who from './Who.vue'
import Icon from './Icon.vue'
import InfoTip from './InfoTip.vue'

const emit = defineEmits<{(e: 'locate', p: Paint): void}>()

const tab = ref<'live' | 'top'>('live')
const recent = computed(() => paints.value.slice(-200).reverse())

const top = computed(() => {
  const by = new Map<string, {painter: string; pixels: number; paints: number}>()
  for (const p of paints.value) {
    const k = p.painter.toLowerCase()
    const row = by.get(k) ?? {painter: p.painter, pixels: 0, paints: 0}
    row.pixels += p.count
    row.paints++
    by.set(k, row)
  }
  return [...by.values()].sort((a, b) => b.pixels - a.pixels).slice(0, 50)
})
const topMax = computed(() => top.value[0]?.pixels ?? 1)
const windowPixels = computed(() => paints.value.reduce((s, p) => s + p.count, 0))

function ago(block: number): string {
  if (chain.head === null) return ''
  const s = Math.max(0, chain.head - block) * chain.interval
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
</script>

<template>
  <!-- Fills the stats panel's height on a desk: the stat tiles and tabs stay,
       and the list takes the rest and scrolls. -->
  <div class="flex flex-col gap-3 text-[13px] min-h-0 lg:flex-1" data-testid="activity">
    <div class="grid grid-cols-3 gap-2">
      <div class="stat card px-2.5 py-2">
        <span class="ledger">Ever painted</span>
        <b class="text-[14px]">{{ board.painted === null ? '-' : compact(Number(board.painted)) }}</b>
      </div>
      <div class="stat card px-2.5 py-2">
        <span class="ledger">Last day</span>
        <b class="text-[14px]">{{ compact(windowPixels) }}</b>
      </div>
      <div class="stat card px-2.5 py-2">
        <span class="ledger flex items-center">Pot</span>
        <b class="text-[14px]">{{ board.balance === null ? '-' : units(board.balance, 18, 2) }}</b>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <div class="seg">
        <button :class="{on: tab === 'live'}" @click="tab = 'live'"><span class="dot live-dot" style="background: var(--znn-ink)" /> Live</button>
        <button :class="{on: tab === 'top'}" @click="tab = 'top'"><Icon name="trophy" :size="12" /> Top painters</button>
      </div>
      <InfoTip>
        Read from the contract's events over the last day. The pot is what painting has paid into the contract, which its owner can withdraw.
      </InfoTip>
    </div>

    <p v-if="board.historyLoading && !paints.length" class="text-dim text-[12.5px]">Reading the last day of paints...</p>
    <p v-else-if="!paints.length" class="text-dim text-[12.5px]">Nobody has painted in the last day. Be first.</p>

    <TransitionGroup v-if="tab === 'live'" tag="ol" name="list" class="grid content-start gap-0.5 max-h-[340px] lg:max-h-none lg:flex-1 lg:min-h-0 overflow-auto -mx-1.5 px-1.5">
      <li v-for="p in recent" :key="p.tx">
        <button class="row w-full" :class="{mine: same(p.painter, wallet.address)}" :title="`Show on the canvas: ${p.x0},${p.y0} to ${p.x1},${p.y1}`" @click="emit('locate', p)">
          <Avatar :seed="p.painter" :size="22" />
          <span class="grid min-w-0 text-left leading-tight">
            <Who class="text-[12.5px]" :address="p.painter" :you="same(p.painter, wallet.address)" />
            <span class="text-dim text-[11.5px]">{{ number(p.count) }} px at {{ p.x0 }},{{ p.y0 }}</span>
          </span>
          <span class="ml-auto text-dim text-[11.5px] mono shrink-0">{{ ago(p.block) }}</span>
          <a v-if="explorerUrl(`/tx/${p.tx}`)" class="text-dim hover:text-fg shrink-0" :href="explorerUrl(`/tx/${p.tx}`)!" target="_blank" rel="noreferrer noopener" title="The transaction" @click.stop>
            <Icon name="external" :size="12" />
          </a>
        </button>
      </li>
    </TransitionGroup>

    <ol v-else class="grid content-start gap-1.5 max-h-[340px] lg:max-h-none lg:flex-1 lg:min-h-0 overflow-auto">
      <li v-for="(r, i) in top" :key="r.painter" class="flex items-center gap-2">
        <span class="mono text-dim w-5 text-right text-[12px]">{{ i + 1 }}</span>
        <Avatar :seed="r.painter" :size="20" />
        <span class="grid grow min-w-0 gap-0.5">
          <span class="flex justify-between gap-2">
            <Who class="text-[12.5px]" :address="r.painter" :you="same(r.painter, wallet.address)" />
            <span class="mono text-[12px]">{{ number(r.pixels) }}</span>
          </span>
          <span class="h-1 rounded-full bg-line overflow-hidden"><span class="block h-full rounded-full" :style="{width: `${(r.pixels / topMax) * 100}%`, background: 'var(--plasma)'}" /></span>
        </span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 6px;
  border-radius: 6px;
  transition: background 150ms var(--ease);
}
.row:hover {
  background: var(--raised);
}
.row.mine {
  box-shadow: inset 2px 0 0 var(--znn-ink);
}
</style>
