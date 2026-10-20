<script setup lang="ts">
import {computed, onMounted, ref} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import {endpoint, check} from './core/endpoint'
import {chain, startChainPolling} from './core/chain'
import {restoreWallet, wallet} from './core/wallet'
import {number} from './core/format'
import './core/board'
import MomentumPulse from './components/MomentumPulse.vue'
import LatticeBackground from '@zvm/web/components/LatticeBackground.vue'
import MozaicMark from './components/MozaicMark.vue'
import ConnectButton from './components/ConnectButton.vue'
import NodePicker from './components/NodePicker.vue'
import Toasts from './components/Toasts.vue'
import Icon from './components/Icon.vue'

const theme = ref(document.documentElement.getAttribute('data-theme') ?? 'dark')
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme.value)
  try {
    localStorage.setItem('mozaic.theme', theme.value)
  } catch {
    /* storage can be blocked; the theme still applies for this tab */
  }
}

const route = useRoute()
const router = useRouter()
const bare = computed(() => !!route.meta.bare)

// The canvas keeps its view (x, y, z) in the address bar with replaceState,
// which the router never sees, so the gallery is opened with the query as it
// is in the address bar at the moment of the click, and opens on the same pixels.
const here = () => Object.fromEntries(new URLSearchParams(location.search))
const toGallery = () => router.push({path: '/gallery', query: here()})
const galleryHref = computed(() => `${import.meta.env.BASE_URL}gallery`)

const offline = computed(() => endpoint.health === 'error')
const noCanvas = computed(() => endpoint.health === 'ok' && !!endpoint.contractError)

onMounted(async () => {
  await check()
  startChainPolling()
  await restoreWallet()
})
</script>

<template>
  <router-view v-if="bare" />
  <div v-else class="min-h-screen flex flex-col">
    <LatticeBackground />

    <header class="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-md">
      <div class="px-2 sm:px-4 py-2.5 flex items-center gap-1.5 sm:gap-3">
        <router-link to="/" class="flex items-center gap-2.5 shrink-0 group" title="Mozaic">
          <span class="mark-wrap"><MozaicMark :size="26" /></span>
          <span class="font-semibold tracking-[-0.02em] text-[16.5px] hidden sm:block">Mozaic</span>
        </router-link>

        <nav class="flex items-center gap-1 ml-1">
          <router-link to="/" class="tab !px-2.5 sm:!px-3" active-class="" exact-active-class="tab-on">Canvas</router-link>
          <a :href="galleryHref" class="tab !px-2.5 sm:!px-3" data-testid="nav-gallery" @click.prevent="toGallery">Gallery</a>
        </nav>

        <span class="grow" />

        <router-link to="/about" class="btn btn-sm btn-quiet px-2 info-link" active-class="on" title="About Mozaic, and painting with bots" data-testid="about">
          <Icon name="info" :size="15" />
          <span class="sr-only">About</span>
        </router-link>
        <button class="btn btn-sm btn-quiet px-2" :title="`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`" @click="toggleTheme">
          <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="15" />
          <span class="sr-only">Switch theme</span>
        </button>
        <div class="hidden sm:block"><NodePicker /></div>
        <ConnectButton />
      </div>
      <!-- The chain's beat: one momentum orders one block, and this fills across the gap between them. -->
      <MomentumPulse />
    </header>

    <div
      v-if="offline || noCanvas"
      class="border-b"
      :style="{
        borderColor: `color-mix(in srgb, ${offline ? 'var(--danger)' : 'var(--warn)'} 35%, transparent)`,
        background: `color-mix(in srgb, ${offline ? 'var(--danger)' : 'var(--warn)'} 9%, transparent)`,
      }"
    >
      <div class="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <Icon name="alert" :size="15" :style="{color: offline ? 'var(--danger)' : 'var(--warn)'}" />
        <template v-if="offline">
          <span>{{ endpoint.error }}</span>
          <span v-if="endpoint.hint" class="text-dim">{{ endpoint.hint }}</span>
        </template>
        <span v-else>{{ endpoint.contractError }}</span>
        <span class="sm:hidden"><NodePicker /></span>
        <button class="btn btn-sm ml-auto" @click="check()"><Icon name="refresh" :size="13" /> Try again</button>
      </div>
    </div>

    <main class="w-full px-3 sm:px-4 py-3 flex-1">
      <p v-if="wallet.error" class="card px-4 py-2.5 mb-3 text-[13px]" style="color: var(--danger)">{{ wallet.error }}</p>
      <div class="sm:hidden mb-3 flex justify-end"><NodePicker /></div>
      <router-view v-slot="{Component, route: r}">
        <Transition name="page" mode="out-in">
          <component :is="Component" :key="r.path" />
        </Transition>
      </router-view>
    </main>

    <footer class="border-t border-line bg-bg/80 backdrop-blur-md">
      <div class="px-4 py-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-dim">
        <span class="flex items-center gap-2 text-soft"><MozaicMark :size="14" /> Mozaic</span>
        <span v-if="chain.head !== null" class="mono ml-auto flex items-center gap-1.5">
          <span class="dot live-dot" style="background: var(--znn-ink)" /> block {{ number(chain.head) }}
        </span>
      </div>
    </footer>

  </div>
  <Toasts />
</template>

<style scoped>
/* The About page's way in, lit while it is open, as a tab would be. */
.info-link.on {
  --btn-fg: var(--fg);
  --btn-bg: var(--raised);
}
/* The pink tile settles into place on hover: the mark's one move. */
.mark-wrap :deep(.mark-tile) {
  transform-box: fill-box;
  transform-origin: center;
  transition: transform 420ms var(--ease-out);
}
.group:hover .mark-wrap :deep(.mark-tile) {
  transform: translate(-1.2px, 2px) rotate(-12deg);
}
</style>
