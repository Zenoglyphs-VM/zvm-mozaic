<script setup lang="ts">
// What the draft will cost and the one button that pays for it.
//
// Two costs, stated apart because they go to different places: the paint
// itself (0.0001 ZNN a pixel, held by the contract) and the network fee (gas,
// paid to the chain). On this devnet the fee is usually the larger, because the
// relayer asks a 100 gwei tip and a pixel written for the first time costs
// about 2,900 gas.
//
// A draft of more than one transaction is painted through a paint session
// (core/paint.ts): one wallet prompt, however large the draft.
import {computed, onUnmounted, ref, shallowRef, watch} from 'vue'
import {clearDraft, draftState, pruneDraft} from '../core/draft'
import {quote, returnLeftover, stop, submission, submitDraft, type Quote} from '../core/paint'
import {endpoint} from '../core/endpoint'
import {askToConnect, switchToChain, wallet, wrongChain} from '../core/wallet'
import {onBlock, refreshNow} from '../core/chain'
import {prefs} from '../core/prefs'
import {publicClient} from '@zvm/web/evm'
import {chainName} from '../core/chains'
import {number, units} from '../core/format'
import {reason} from '../core/tx'
import {toast} from '../core/toast'
import Icon from './Icon.vue'
import StepRail from './StepRail.vue'
import InfoTip from './InfoTip.vue'

// A full draft is a million pixels, so the quote is worked out a moment after
// the drawing stops rather than on every pixel of a stroke.
const q = shallowRef<Quote>(quote())
let qTimer: number | undefined
watch(
  () => [draftState.version, endpoint.canvas],
  () => {
    clearTimeout(qTimer)
    qTimer = window.setTimeout(() => (q.value = quote()), draftState.size > 100_000 ? 400 : 60)
  },
)
const total = computed(() => q.value.paint + q.value.fee)
const session = computed(() => q.value.txs > 1 && !prefs.signEach)
/** What the wallet has to hold: a session is funded at the fee ceiling, and gets the rest back. */
const needed = computed(() => (session.value ? q.value.fund : total.value))

const balance = ref<bigint | null>(null)
async function readBalance() {
  if (!wallet.address || endpoint.chainId === null) return (balance.value = null)
  try {
    balance.value = await publicClient(endpoint.chainId).getBalance({address: wallet.address})
  } catch {
    /* shown as unknown */
  }
}
watch(() => [wallet.address, endpoint.chainId], readBalance, {immediate: true})
onUnmounted(onBlock(() => wallet.address && readBalance()))

const short = computed(() => balance.value !== null && q.value.pixels > 0 && balance.value < needed.value)

async function paint() {
  try {
    await submitDraft({signEach: prefs.signEach})
  } catch (err) {
    submission.error = reason(err)
  }
  readBalance()
}

const returning = ref(false)
async function giveBack() {
  returning.value = true
  try {
    const v = await returnLeftover()
    toast(`${units(v, 18, 4)} ZNN returned to your wallet.`, 'good')
    readBalance()
  } catch (err) {
    toast(reason(err), 'bad')
  } finally {
    returning.value = false
  }
}

const dripping = ref(false)
async function faucet() {
  if (!endpoint.apiBase || !wallet.address) return
  dripping.value = true
  try {
    const res = await fetch(`${endpoint.apiBase}/api/faucet`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({address: wallet.address}),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(text.trim() || `the faucet answered ${res.status}`)
    toast('Devnet ZNN is on its way. It lands within a momentum or two.', 'good')
    setTimeout(refreshNow, 20_000)
  } catch (err: any) {
    toast(`Faucet: ${err?.message ?? err}`, 'bad')
  } finally {
    dripping.value = false
  }
}

const znn = (wei: bigint, frac = 4) => units(wei, 18, frac)
const progress = computed(() => (submission.pixels ? submission.pixelsDone / submission.pixels : 0))
</script>

<template>
  <div class="grid gap-3 text-[13px]" data-testid="paint-panel">
    <div class="flex items-center gap-1.5">
      <h2 class="font-semibold text-[15px] tracking-[-0.01em]">Your draft</h2>
      <InfoTip>
        Everything you draw lands in a draft first, which costs nothing and stays in this browser. Painting sends the pixels that differ from
        the canvas, 4,000 to a transaction; the whole canvas is 250.
      </InfoTip>
      <span class="grow" />
      <button class="btn btn-sm btn-quiet px-1.5" :disabled="!draftState.size" title="Drop draft pixels the canvas already has" @click="pruneDraft">
        <Icon name="broom" :size="14" />
      </button>
      <button class="btn btn-sm btn-quiet px-1.5" :disabled="!draftState.size" title="Clear the draft (undo brings it back)" data-testid="clear-draft" @click="clearDraft">
        <Icon name="trash" :size="14" />
      </button>
    </div>

    <!-- ZNN left in a session from an earlier visit: offered back first. -->
    <div v-if="submission.leftover && !submission.running" class="card px-3 py-2.5 grid gap-2" style="border-color: color-mix(in srgb, var(--warn) 40%, var(--line))">
      <span>A paint session from earlier still holds <b class="mono">{{ znn(submission.leftover.balance) }} ZNN</b>.</span>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-sm" :disabled="returning || !wallet.address" @click="giveBack">
          <Icon :name="returning ? 'refresh' : 'wallet'" :size="13" :class="returning ? 'spin' : ''" /> Return it to my wallet
        </button>
        <span v-if="!wallet.address" class="text-dim text-[12px] self-center">Connect the wallet to send it to.</span>
      </div>
    </div>

    <dl class="grid grid-cols-2 gap-2">
      <div class="stat card px-3 py-2">
        <dt class="ledger">Pixels to paint</dt>
        <dd><b data-testid="draft-count">{{ number(q.pixels) }}</b></dd>
      </div>
      <div class="stat card px-3 py-2">
        <dt class="ledger">Transactions</dt>
        <dd><b>{{ number(q.txs) }}</b></dd>
      </div>
    </dl>

    <div class="grid gap-1 mono text-[12.5px]">
      <div class="flex justify-between"><span class="text-dim font-sans">Paint, {{ endpoint.canvas ? znn(endpoint.canvas.price) : '-' }} a pixel</span><span>{{ znn(q.paint) }} ZNN</span></div>
      <div class="flex justify-between"><span class="text-dim font-sans">Network fee, about</span><span>{{ znn(q.fee) }} ZNN</span></div>
      <div class="flex justify-between border-t border-line pt-1 font-semibold"><span class="font-sans">Total</span><span>{{ znn(total) }} ZNN</span></div>
      <div v-if="draftState.size > q.pixels" class="text-dim font-sans text-[12px]">
        {{ number(draftState.size - q.pixels) }} draft pixels already match the canvas and are free.
      </div>
      <div v-if="draftState.pending" class="font-sans text-[12px] flex items-center gap-1.5" style="color: var(--nom-ink)">
        <span class="dot live-dot" style="background: var(--nom-ink)" /> {{ number(draftState.pending) }} pixels ordered, waiting for their block
      </div>
    </div>

    <p v-if="session && q.pixels && !submission.running" class="text-[12px] text-dim">
      {{ q.txs }} transactions, one wallet prompt: your wallet moves up to
      <span class="mono text-fg">{{ znn(q.fund, 3) }} ZNN</span> into a paint session, this page signs the batches, and what is not spent comes
      straight back.
    </p>

    <button v-if="!wallet.address" class="btn btn-plasma w-full py-2.5" :disabled="!endpoint.canvas" @click="askToConnect">
      <Icon name="wallet" :size="15" /> Connect wallet
    </button>
    <button v-else-if="wrongChain" class="btn w-full py-2.5" style="color: var(--warn)" @click="switchToChain">
      <Icon name="alert" :size="15" /> Switch to {{ chainName(endpoint.chainId) }}
    </button>
    <!-- These two may wrap. A button never does by default, and at an image's
         size ("Paint 1,000,000 pixels for 243.118 ZNN") the label ran past the
         column, which clips rather than scroll sideways, so it was cut off. -->
    <button
      v-else-if="submission.running && submission.mode === 'session'"
      class="btn w-full py-2.5 whitespace-normal text-center leading-snug"
      :disabled="submission.stopping"
      data-testid="stop"
      @click="stop"
    >
      <Icon :name="submission.stopping ? 'refresh' : 'x'" :size="15" :class="submission.stopping ? 'spin' : ''" />
      <span class="min-w-0">{{ submission.stopping ? 'Stopping after what is in flight' : 'Stop painting' }}</span>
    </button>
    <button
      v-else
      class="btn btn-plasma w-full py-2.5 whitespace-normal text-center leading-snug"
      :disabled="!q.pixels || submission.running || short"
      data-testid="paint"
      @click="paint"
    >
      <Icon :name="submission.running ? 'refresh' : 'brush'" :size="15" :class="submission.running ? 'spin' : ''" />
      <span class="min-w-0">
        <template v-if="submission.running">Painting</template>
        <template v-else-if="!q.pixels">Draw something to paint</template>
        <template v-else>Paint {{ number(q.pixels) }} pixel{{ q.pixels === 1 ? '' : 's' }} <span class="whitespace-nowrap">for {{ znn(total, 3) }} ZNN</span></template>
      </span>
    </button>

    <!-- A session's progress: pixels executed, batches in flight. -->
    <div v-if="submission.mode === 'session' && submission.batches" class="grid gap-1.5" data-testid="progress">
      <div class="h-1.5 rounded-full bg-line overflow-hidden">
        <div class="h-full rounded-full transition-[width] duration-500" :style="{width: `${progress * 100}%`, background: 'var(--plasma)'}" />
      </div>
      <!-- Wraps: at a full canvas both halves together are wider than the column. -->
      <div class="flex flex-wrap justify-between gap-x-3 text-[12px] mono">
        <span>{{ number(submission.pixelsDone) }} / {{ number(submission.pixels) }} px</span>
        <span class="text-dim">{{ submission.executed }} / {{ submission.batches }} batches<template v-if="submission.sent > submission.executed + submission.failed">, {{ submission.sent - submission.executed - submission.failed }} in flight</template></span>
      </div>
    </div>

    <div v-if="wallet.address && balance !== null" class="flex items-center justify-between text-[12px]">
      <span class="text-dim">Wallet: <span class="mono" :style="short ? 'color: var(--danger)' : ''">{{ znn(balance) }} ZNN</span></span>
      <button v-if="endpoint.apiBase" class="link" :disabled="dripping" @click="faucet">{{ dripping ? 'Asking the faucet' : 'Get devnet ZNN' }}</button>
    </div>
    <p v-if="short" class="text-[12px]" style="color: var(--danger)">
      This draft needs {{ znn(needed, 3) }} ZNN in the wallet{{ session ? ', most of which comes back' : '' }}. The faucet gives 5 ZNN at a time.
    </p>
    <p v-if="submission.error" class="text-[12.5px] break-words" style="color: var(--danger)">{{ submission.error }}</p>

    <StepRail v-if="submission.steps.length" :steps="submission.steps" />

    <label v-if="q.txs > 1 || prefs.signEach" class="flex items-center gap-2 text-[12px] text-dim cursor-pointer">
      <input v-model="prefs.signEach" type="checkbox" class="check" :disabled="submission.running" /> Sign every transaction in my wallet instead
    </label>
  </div>
</template>
