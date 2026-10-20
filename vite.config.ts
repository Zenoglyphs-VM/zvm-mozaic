import {copyFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, resolve} from 'node:path'
import {defineConfig, loadEnv} from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'

// GitHub Pages serves a project site from /<repo>/, and a user site or custom
// domain from /. BASE_PATH lets the same build serve either; the workflow sets
// it from the repository name.
const base = process.env.BASE_PATH ?? '/zvm-mozaic/'

/**
 * GitHub Pages has no SPA rewrite, so a deep link like /about is a 404.
 * It does serve 404.html for any unmatched path, and a copy of index.html there
 * boots the app with the URL intact, so the router reads the real path and the
 * address bar never shows a redirect.
 */
function pagesFallback() {
  return {
    name: 'pages-404-fallback',
    closeBundle() {
      const dir = resolve(__dirname, 'dist')
      copyFileSync(resolve(dir, 'index.html'), resolve(dir, '404.html'))
    },
  }
}

/**
 * Preloads the Latin cut of the UI face. The browser otherwise finds the font
 * only after it has fetched and parsed 60 kB of CSS and laid out text that
 * needs it, so a first visit painted every heading in the fallback face and
 * then reflowed. Only the Latin subset: the others are fetched by
 * unicode-range if a page ever needs them, and preloading them would not be.
 */
function preloadFont() {
  return {
    name: 'preload-ui-font',
    apply: 'build' as const,
    transformIndexHtml: {
      order: 'post' as const,
      handler(_html: string, ctx: {bundle?: Record<string, {fileName: string}>}) {
        const font = Object.values(ctx.bundle ?? {}).find((f) => /space-grotesk-latin-wght-normal-[\w-]+\.woff2$/.test(f.fileName))
        if (!font) return []
        return [
          {
            tag: 'link',
            attrs: {rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: '', href: base + font.fileName},
            injectTo: 'head' as const,
          },
        ]
      },
    },
  }
}

/**
 * Libraries in their own chunks. They change far less often than the app, and
 * in one entry chunk every deploy renamed all 476 kB of it, so a returning
 * visitor downloaded viem again for a copy change. Split, a deploy that only
 * touches the app costs them the app chunk.
 */
function vendorChunk(id: string) {
  if (!id.includes('node_modules')) return
  if (/[\\/]node_modules[\\/](viem|ox|abitype|@noble|@scure|@adraffy)[\\/]/.test(id)) return 'viem'
  if (/[\\/]node_modules[\\/](vue|vue-router|@vue)[\\/]/.test(id)) return 'vue'
}

// The shared half of the front ends (@zvm/web) is compiled from the zvm-core
// submodule, the same arrangement as the Go modules' `replace ./zvm-core`. vue
// and viem are its peer dependencies, pinned to this app's own copies so there
// is one Vue instance rather than two.
const require = createRequire(import.meta.url)
const peer = (name: string) => dirname(require.resolve(`${name}/package.json`))

// The node and origins this page reads are never built in (see .env.example).
// A build without them would ship a page that talks to nothing, so it stops
// here and says what to set.
function requireEnv(env: Record<string, string>, names: string[]) {
  const missing = names.filter((n) => !env[n])
  if (missing.length) {
    throw new Error(`${missing.join(', ')} not set: copy .env.example to .env, or set them in the environment`)
  }
}

export default defineConfig(({mode}) => {
  requireEnv(loadEnv(mode, process.cwd(), 'VITE_'), ['VITE_ZVM_NODE'])
  return {
    base,
    resolve: {
      alias: {
        '@zvm/web': resolve(__dirname, 'zvm-core/web/src'),
        vue: peer('vue'),
        viem: peer('viem'),
      },
      dedupe: ['vue', 'viem'],
    },
    plugins: [vue(), tailwind(), preloadFont(), pagesFallback()],
    build: {
      target: 'es2022',
      // Fonts inline as base64 past this, which bloats the CSS and delays first
      // paint; they are better as their own cacheable files.
      assetsInlineLimit: 4096,
      rollupOptions: {output: {manualChunks: vendorChunk}},
    },
    server: {port: 47700},
  }
})
