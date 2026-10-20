<script setup lang="ts">
import {computed} from 'vue'
import {endpoint} from '../core/endpoint'
import {units} from '../core/format'
import Icon from '../components/Icon.vue'

const contract = computed(() => endpoint.contract ?? '0x...')
const price = computed(() => (endpoint.canvas ? units(endpoint.canvas.price, 18, 6) : '0.0001'))
const repo = 'scripts/mozaic.mjs'
</script>

<template>
  <div class="max-w-[860px] mx-auto grid gap-4 pb-8">
    <section class="shelf grid gap-3">
      <h1 class="text-[26px] font-semibold tracking-[-0.02em]">A million pixels, anyone's to paint</h1>
      <p class="text-soft">
        Mozaic is a 1000 x 1000 canvas held by one contract on the ZVM. Any pixel, any of 16.7 million colours, {{ price }} ZNN each. A
        pixel painted later covers one painted earlier. Nobody owns a pixel, and there is no cooldown.
      </p>
      <ul class="grid gap-1.5 text-[14px]">
        <li class="flex gap-2"><Icon name="brush" :size="16" class="mt-0.5 text-dim" /> Draw into a free draft with ten tools, then pay once for what differs from the canvas.</li>
        <li class="flex gap-2"><Icon name="coins" :size="16" class="mt-0.5 text-dim" /> Paint money stays in the contract. Its owner can withdraw it at any time; nothing else can move it.</li>
        <li class="flex gap-2"><Icon name="bolt" :size="16" class="mt-0.5 text-dim" /> Network fees are separate and, on this devnet, usually larger: about 0.0003 ZNN a fresh pixel, 0.0001 a repaint.</li>
        <li class="flex gap-2"><Icon name="server" :size="16" class="mt-0.5 text-dim" /> This page has no server. It reads the chain from whichever node you choose.</li>
      </ul>
    </section>

    <section class="shelf grid gap-3">
      <h2 class="text-[19px] font-semibold tracking-[-0.01em]">Bots and scripts</h2>
      <p class="text-soft text-[14px]">Bots are welcome, and the contract makes them easy: one call paints up to 4,000 pixels.</p>

      <div class="grid gap-1">
        <span class="ledger">The contract</span>
        <code class="card px-3 py-2 mono text-[12.5px] break-all">{{ contract }}</code>
      </div>

      <div class="grid gap-1">
        <span class="ledger">Paint: six bytes a pixel</span>
        <pre class="card px-3 py-2 mono text-[12.5px] overflow-x-auto">paint(bytes pixels)   payable, value = count x price()

pixel = index (3 bytes) || red || green || blue
index = y * 1000 + x</pre>
      </div>

      <div class="grid gap-1">
        <span class="ledger">Read</span>
        <pre class="card px-3 py-2 mono text-[12.5px] overflow-x-auto">pixel(x, y)          -> 0xRRGGBB
chunk(start, count)  -> the painted slots among 10 pixels x count
price(), painted(), owner(), WIDTH(), HEIGHT()
event Painted(address indexed painter, uint256 count, bytes pixels)</pre>
      </div>

      <div class="grid gap-1">
        <span class="ledger">The command line, in the repository</span>
        <pre class="card px-3 py-2 mono text-[12.5px] overflow-x-auto">npm run mozaic -- key                     # a new bot key
MOZAIC_KEY_FILE=secrets/bot.key npm run mozaic -- faucet
npm run mozaic -- rect 10 10 50 20 '#00d557'
npm run mozaic -- image logo.png 400 300 --width 64
npm run mozaic -- keep logo.png 400 300 --width 64   # repaint what others change
npm run mozaic -- snapshot canvas.png
npm run mozaic -- watch                   # every paint, as JSON lines</pre>
        <p class="text-[12.5px] text-dim">
          {{ repo }} skips pixels that already have the colour, splits big paints into transactions, and takes
          <span class="mono">--max-znn</span> so a bot left running cannot overspend.
        </p>
      </div>
    </section>
  </div>
</template>
