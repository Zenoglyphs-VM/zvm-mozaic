// Drives the real page against a running ZVM node in headless Chrome, and
// paints for real.
//
//   node scripts/verify.mjs [rpc] [app]
//     rpc  default $ZVM_RPC
//     app  default http://localhost:47700/zvm-mozaic/
//
// A stand-in EIP-6963 wallet signs with a throwaway key the node's faucet
// funds, exactly as MetaMask would. Nothing under the wallet is mocked. The
// run draws a filled rectangle, recolours it with the fill tool, checks that
// undo and redo walk that back and forth, draws a brush line, pays for the
// draft through the Paint button, and then reads the pixels back from the
// chain with scripts/lib.mjs, the page's codec checked against the scripts'.
// It also renders the light theme and a 400 px phone and fails if either
// scrolls sideways.
//
// Set MOZAIC_SHOTS to a directory to keep screenshots.

import {existsSync, mkdirSync} from 'node:fs'
import {join} from 'node:path'
import puppeteer from 'puppeteer-core'
import {createWalletClient, formatEther, http, parseAbiItem} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'
import {connect, readPixels, W} from './lib.mjs'

const rpc = process.argv[2] ?? process.env.ZVM_RPC
if (!rpc) throw new Error("pass the node's JSON-RPC, or set ZVM_RPC")
const app = process.argv[3] ?? 'http://localhost:47700/zvm-mozaic/'
process.env.MOZAIC_RPC = rpc
const shots = process.env.MOZAIC_SHOTS
if (shots) mkdirSync(shots, {recursive: true})

const started = Date.now()
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chromePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p))
if (!chromePath) throw new Error('no Chrome found')

const t = await connect()
log(`chain ${t.chainId}, Mozaic ${t.contract}`)

// --- a funded throwaway wallet -------------------------------------------------

const account = privateKeyToAccount(generatePrivateKey())
log(`painter ${account.address}`)
// Two drips, 10 ZNN: the session paints 15,000 pixels, about 1.5 ZNN of paint
// and a session funded for fees at their ceiling on top.
for (let drip = 1; drip <= 2; drip++) {
  for (let i = 0; ; i++) {
    const res = await fetch(`${t.apiBase}/api/faucet`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({address: account.address})})
    if (res.ok) break
    if (i === 9) throw new Error(`faucet: ${await res.text()}`)
    await sleep(6000)
  }
  for (let end = Date.now() + 240_000; (await t.client.getBalance({address: account.address})) < BigInt(drip) * 5n * 10n ** 18n; ) {
    if (Date.now() > end) throw new Error('the faucet never paid')
    await sleep(3000)
  }
}
log('funded')

const signer = createWalletClient({account, chain: t.chain, transport: http(rpc)})
let prompts = 0
async function standIn(method, params) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [account.address]
    case 'eth_chainId':
      return `0x${t.chainId.toString(16)}`
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain':
      return null
    case 'eth_sendTransaction': {
      prompts++
      const [tx] = params
      return signer.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
        maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined,
      })
    }
    default:
      return t.client.request({method, params})
  }
}

// --- where to draw -----------------------------------------------------------------

// Somewhere unlikely to be busy, different each run, so a rerun is not
// "already that colour" and free.
const X0 = 120 + Math.floor(Math.random() * 700)
const Y0 = 120 + Math.floor(Math.random() * 700)
const Z = 12
const C1 = 0xff00aa
const C2 = 0x2266ff
const hexOf = (c) => '#' + c.toString(16).padStart(6, '0')

const browser = await puppeteer.launch({executablePath: chromePath, headless: 'new', args: ['--no-sandbox']})
const problems = []
try {
  const page = await browser.newPage()
  await page.setViewport({width: 1440, height: 900, deviceScaleFactor: 1})
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`))
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
  await page.exposeFunction('__evm', standIn)
  await page.evaluateOnNewDocument(() => {
    // A clean browser once, not on every navigation: the session run reloads,
    // and must keep the connected wallet.
    if (!sessionStorage.getItem('verify')) {
      localStorage.clear()
      indexedDB.deleteDatabase('mozaic')
      sessionStorage.setItem('verify', '1')
    }
    const provider = {request: ({method, params}) => window.__evm(method, params ?? []), on() {}, removeListener() {}}
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {detail: Object.freeze({info: {uuid: 'mozaic-verify', name: 'Test wallet', icon: '', rdns: 'test.mozaic'}, provider})}),
      )
    window.addEventListener('eip6963:requestProvider', announce)
  })
  const url = `${app}?rpc=${encodeURIComponent(rpc)}&contract=${t.contract}&x=${X0 + 5}&y=${Y0 + 5}&z=${Z}`
  await page.goto(url, {waitUntil: 'networkidle2', timeout: 90_000})
  await page.waitForFunction(() => document.querySelector('[data-testid="board"]') && !document.body.innerText.includes('Reading the canvas'), {timeout: 90_000})
  log('canvas loaded')
  // The right-hand column starts folded to a bar; the draft, the colour and the stats are in it.
  const unfold = async () => {
    await page.click('[data-testid="side-open"]')
    await page.waitForFunction(() => !document.querySelector('[data-testid="side"]').classList.contains('folded'))
    await sleep(500)
  }
  await unfold()

  const box = await page.$eval('[data-testid="board"]', (el) => {
    const r = el.getBoundingClientRect()
    return {left: r.left, top: r.top, w: r.width, h: r.height}
  })
  // The view centres pixel (X0+5, Y0+5): the middle of pixel p is at the
  // board's centre plus (p - that) * Z, which is what Board's centerOn sets.
  const at = (x, y) => [box.left + box.w / 2 + (x - (X0 + 5)) * Z, box.top + box.h / 2 + (y - (Y0 + 5)) * Z]
  const drag = async (a, b) => {
    await page.mouse.move(...at(...a))
    await page.mouse.down()
    await page.mouse.move(...at(...b), {steps: 12})
    await page.mouse.up()
    await sleep(150)
  }
  const click = async (p) => {
    await page.mouse.click(...at(...p))
    await sleep(150)
  }
  const setColor = async (c) => {
    await page.$eval('[data-testid="hex"]', (el, v) => {
      el.value = v
      el.dispatchEvent(new Event('input', {bubbles: true}))
      el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
    }, hexOf(c))
    await sleep(100)
  }
  const count = () => page.$eval('[data-testid="draft-count"]', (el) => Number(el.textContent.replace(/[^\d]/g, '')))
  const key = async (k, mods = []) => {
    for (const m of mods) await page.keyboard.down(m)
    await page.keyboard.press(k)
    for (const m of mods.reverse()) await page.keyboard.up(m)
    await sleep(150)
  }
  await page.mouse.move(box.left + 5, box.top + 5)

  // A filled 8 x 6 rectangle, then the fill tool recolours all of it.
  await setColor(C1)
  await key('r')
  await page.$$eval('[data-testid="filled"]', (b) => b[0]?.click())
  await drag([X0, Y0], [X0 + 7, Y0 + 5])
  let n = await count()
  if (n !== 48) throw new Error(`the rectangle drafted ${n} pixels, not 48`)
  await setColor(C2)
  await key('g')
  await click([X0 + 3, Y0 + 3])
  if ((n = await count()) !== 48) throw new Error(`after the fill the draft has ${n} pixels, not 48`)
  const under = () => page.$eval('[data-testid="hud"]', (el) => el.textContent)
  await page.mouse.move(...at(X0 + 3, Y0 + 3))
  await sleep(200)
  if (!(await under()).includes(hexOf(C2))) throw new Error(`the status line under the pointer does not show the fill's colour: ${await under()}`)

  // Undo takes the fill back to the rectangle's colour; redo restores it.
  await key('z', ['Control'])
  await key('y', ['Control'])
  if ((n = await count()) !== 48) throw new Error(`undo and redo left ${n} pixels, not 48`)
  log('rectangle, fill, undo and redo drafted')

  // A ten-pixel brush line under it, in the first colour.
  await setColor(C1)
  await key('b')
  await drag([X0, Y0 + 9], [X0 + 9, Y0 + 9])
  if ((n = await count()) !== 58) throw new Error(`with the brush line the draft has ${n} pixels, not 58`)
  log('brush line drafted: 58 pixels to paint')
  if (shots) await page.screenshot({path: join(shots, '1-draft.png')})

  // Connect and pay.
  await page.click('[data-testid="connect"]')
  await page.waitForFunction(() => [...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent.includes('Test wallet')), {timeout: 20_000})
  await page.evaluate(() => [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.includes('Test wallet')).click())
  await page.waitForFunction(() => !document.querySelector('[data-testid="connect"]').textContent.includes('Connect'), {timeout: 20_000})
  await page.waitForFunction(() => !document.querySelector('[data-testid="paint"]')?.disabled, {timeout: 30_000})
  const label = await page.$eval('[data-testid="paint"]', (b) => b.textContent.trim())
  log(`pressing "${label}"`)
  await page.click('[data-testid="paint"]')

  for (let end = Date.now() + 300_000; ; ) {
    const s = await page.evaluate(() => ({
      steps: [...document.querySelectorAll('li[data-state]')].map((li) => li.dataset.state),
      pending: document.querySelector('[data-testid="paint-panel"]').textContent.includes('waiting for their block'),
    }))
    if (s.steps.includes('failed')) throw new Error(`a paint failed: ${await page.$eval('[data-testid="paint-panel"]', (el) => el.textContent)}`)
    if (s.steps.length && s.steps.every((x) => x === 'done') && !s.pending) break
    if (Date.now() > end) throw new Error(`timed out: steps ${s.steps}, pending ${s.pending}`)
    await sleep(2000)
  }
  log('executed, and the page has applied its block')
  if (shots) await page.screenshot({path: join(shots, '2-painted.png')})

  // What the chain holds now.
  const want = new Map()
  for (let y = Y0; y <= Y0 + 5; y++) for (let x = X0; x <= X0 + 7; x++) want.set(y * W + x, C2)
  for (let x = X0; x <= X0 + 9; x++) want.set((Y0 + 9) * W + x, C1)
  const got = await readPixels(t, [...want.keys()])
  const wrong = [...want].filter(([i, c]) => got.get(i) !== c)
  if (wrong.length) throw new Error(`${wrong.length} pixels on chain are not what was drawn, e.g. ${wrong.slice(0, 3).map(([i, c]) => `${i % W},${Math.floor(i / W)} is ${hexOf(got.get(i))} not ${hexOf(c)}`).join('; ')}`)
  log(`all ${want.size} pixels read back from the chain match`)
  if ((await count()) !== 0) throw new Error('the draft still holds pixels after painting')

  // The whole canvas as one draft: a filled rectangle from corner to corner,
  // drawn at the zoom that fits it. Free; it is cleared again, not painted.
  const txCount = () => page.$$eval('[data-testid="paint-panel"] .stat b', (b) => Number(b[1].textContent.replace(/[^\d]/g, '')))
  const waitCount = async (n, what) => {
    for (let end = Date.now() + 30_000; (await count()) !== n; ) {
      if (Date.now() > end) throw new Error(`${what}: the draft shows ${await count()} pixels, not ${n}`)
      await sleep(200)
    }
  }
  // The canvas covers the board rather than fitting inside it, so at the
  // furthest zoom part of it is off screen, and a press must start on the
  // canvas, a few pixels in from the board's rounded corner. So four
  // rectangles, each started inside the board near one corner and dragged out
  // past the opposite canvas corner (the pointer is captured, so the drag keeps
  // drawing beyond the board, and anything past the canvas is dropped): two
  // panned to the top, two to the bottom. Between them, every pixel.
  const dragTo = async (from, to, steps = 12) => {
    await page.mouse.move(...from)
    await page.mouse.down()
    await page.mouse.move(...to, {steps})
    await page.mouse.up()
    await sleep(150)
  }
  const view = page.viewport()
  const [vw, vh] = [view.width, view.height]
  const tl = [box.left + 4, box.top + 4]
  const tr = [box.left + box.w - 4, box.top + 4]
  const bl = [box.left + 4, box.top + box.h - 4]
  const br = [box.left + box.w - 4, box.top + box.h - 4]
  const mid = [box.left + box.w / 2, box.top + box.h / 2]
  await key('0')
  await sleep(500)
  // A colour nobody has painted, or pixels already that colour are free and
  // the count comes up short of a million (the draft's pink did, from earlier runs).
  await setColor(0x010000 + Math.floor(Math.random() * 0xfe0000))
  let t0 = Date.now()
  await key('h') // the brush is in hand from the line above; this picks up the hand
  await dragTo(mid, [mid[0] + 800, mid[1] + 800]) // pan to the top
  await key('r')
  await dragTo(br, [1, 1], 20)
  await dragTo(bl, [vw - 1, 1], 20)
  await key('h')
  await dragTo(mid, [mid[0] - 800, mid[1] - 800]) // pan to the bottom
  await key('r')
  await dragTo(tr, [1, vh - 1], 20)
  await dragTo(tl, [vw - 1, vh - 1], 20)
  await waitCount(1_000_000, 'four rectangles between them covering the canvas')
  const drew = Date.now() - t0
  const txs = await txCount()
  // Gas-bound: 90 transactions if every slot is already painted, 230 if none are.
  if (txs < 90 || txs > 230) throw new Error(`a full canvas quotes ${txs} transactions, outside 90 to 230`)
  if (shots) await page.screenshot({path: join(shots, '3-full-draft.png')})
  t0 = Date.now()
  for (let i = 0; i < 4; i++) await key('z', ['Control'])
  await waitCount(0, 'undo of the full canvas')
  log(`a full-canvas draft: 1,000,000 pixels, ${txs} transactions, drawn in ${drew} ms, undone in ${Date.now() - t0} ms`)

  // A draft of two transactions goes through a paint session: one wallet
  // prompt funds it, the page signs both batches, and the rest comes back.
  // 150 x 100 = 15,000 pixels of one colour: through the router a paint is
  // gas-bound, and 15,000 is past one transaction's 13.5M budget even where
  // every slot is already painted (6,000 was not, on a canvas this full). The
  // colour is fresh each run, so no pixel of it is already right.
  const SW = 150
  const SH = 100
  const SN = SW * SH
  const SC = 0x010101 + Math.floor(Math.random() * 0xfdfdfd)
  const promptsBefore = prompts
  // Past the draft's save delay, so the reload restores the empty draft.
  await sleep(2500)
  const SX = 100 + Math.floor(Math.random() * (900 - SW))
  const SY = 100 + Math.floor(Math.random() * (900 - SH))
  await page.goto(`${app}?rpc=${encodeURIComponent(rpc)}&contract=${t.contract}&x=${SX + SW / 2}&y=${SY + SH / 2}&z=4`, {waitUntil: 'networkidle2', timeout: 90_000})
  await page.waitForFunction(() => document.querySelector('[data-testid="board"]') && !document.body.innerText.includes('Reading the canvas'), {timeout: 90_000})
  // Unfolded first, then measured: unfolding narrows the board and moves its
  // centre, and a board measured before that drew the rectangle 35 canvas
  // pixels to the side of where it was then looked for.
  await unfold()
  const box2 = await page.$eval('[data-testid="board"]', (el) => {
    const r = el.getBoundingClientRect()
    return {left: r.left, top: r.top, w: r.width, h: r.height}
  })
  const at2 = (x, y) => [box2.left + box2.w / 2 + (x - (SX + SW / 2)) * 4, box2.top + box2.h / 2 + (y - (SY + SH / 2)) * 4]
  await waitCount(0, 'the draft after reloading')
  await setColor(SC)
  await key('r')
  await page.mouse.move(...at2(SX, SY))
  await page.mouse.down()
  await page.mouse.move(...at2(SX + SW - 1, SY + SH - 1), {steps: 10})
  await page.mouse.up()
  await waitCount(SN, 'the session rectangle')
  await page.waitForFunction(() => !document.querySelector('[data-testid="paint"]')?.disabled, {timeout: 30_000})
  const before = await t.client.getBalance({address: account.address})
  log(`session: pressing "${await page.$eval('[data-testid="paint"]', (b) => b.textContent.trim())}"`)
  await page.click('[data-testid="paint"]')
  let widest = 0
  for (let end = Date.now() + 600_000; ; ) {
    const s = await page.evaluate(() => ({
      steps: [...document.querySelectorAll('li[data-state]')].map((li) => `${li.dataset.state}: ${li.textContent.replace(/\s+/g, ' ').trim()}`),
      running: !!document.querySelector('[data-testid="stop"]'),
      sideways: (() => {
        const a = document.querySelector('.side-scroll')
        return a ? a.scrollWidth - a.clientWidth : 0
      })(),
      // What is sticking out, named, for when it is not zero.
      culprits: (() => {
        const a = document.querySelector('.side-scroll')
        if (!a) return []
        const edge = a.getBoundingClientRect().left + a.clientWidth + 0.5
        return [...a.querySelectorAll('*')]
          .filter((e) => e.getBoundingClientRect().right > edge)
          .map((e) => `${e.tagName}.${[...e.classList].slice(0, 4).join('.')} w=${Math.round(e.getBoundingClientRect().width)} "${e.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)}"`)
          .slice(0, 6)
      })(),
    }))
    if (s.sideways > widest) log(`   side column ${s.sideways} px too wide: ${JSON.stringify(s.culprits)}`)
    widest = Math.max(widest, s.sideways)
    if (s.steps.some((x) => x.startsWith('failed'))) throw new Error(`the session failed:\n  ${s.steps.join('\n  ')}`)
    if (s.steps.length === 3 && s.steps.every((x) => x.startsWith('done')) && !s.running) {
      for (const x of s.steps) log(`   ${x}`)
      break
    }
    if (Date.now() > end) throw new Error(`the session timed out:\n  ${s.steps.join('\n  ')}`)
    await sleep(3000)
  }
  if (widest > 0) throw new Error(`during the session the side column scrolled ${widest} px sideways`)
  const walletPrompts = prompts - promptsBefore
  if (walletPrompts !== 1) throw new Error(`the session asked the wallet ${walletPrompts} times, not once`)
  const sessionPx = new Map()
  for (let y = SY; y < SY + SH; y++) for (let x = SX; x < SX + SW; x++) sessionPx.set(y * W + x, SC)
  const gotS = await readPixels(t, [...sessionPx.keys()])
  const wrongS = [...sessionPx].filter(([i, c]) => gotS.get(i) !== c)
  if (wrongS.length) throw new Error(`${wrongS.length} of the session's ${SN} pixels are not on chain`)
  const after = await t.client.getBalance({address: account.address})
  log(`session: one wallet prompt, ${SN} pixels on chain, ${formatEther(before - after)} ZNN spent in all`)

  if (t.router) {
    const head = await t.client.getBlockNumber()
    const credited = await t.client.getLogs({
      address: t.router,
      event: parseAbiItem('event PaintedBy(address indexed artist, address indexed sender, uint256 count)'),
      fromBlock: head - 400n,
      toBlock: head,
    })
    const ours = credited.filter((l) => l.args.artist.toLowerCase() === account.address.toLowerCase())
    const bySession = ours.filter((l) => l.args.sender.toLowerCase() !== account.address.toLowerCase())
    const pixelsOurs = ours.reduce((n, l) => n + Number(l.args.count), 0)
    if (pixelsOurs !== 58 + SN) throw new Error(`the router credits the wallet with ${pixelsOurs} pixels, not ${58 + SN}`)
    if (!bySession.length) throw new Error('no paint signed by the session was credited to the wallet')
    log(`attribution: all ${pixelsOurs} pixels credited to the wallet, ${bySession.length} of those paints signed by the session key`)
  }

  // The gallery: the canvas alone, looking at the chain every ten seconds.
  let heads = 0
  const countHeads = (req) => {
    if (req.method() === 'POST' && (req.postData() ?? '').includes('eth_blockNumber')) heads++
  }
  await page.click('[data-testid="gallery"]')
  await page.waitForSelector('[data-testid="gallery-view"]', {timeout: 20_000})
  await sleep(2000)
  const chrome = await page.evaluate(() => ({header: !!document.querySelector('header'), panels: !!document.querySelector('.studio-side'), footer: !!document.querySelector('footer')}))
  if (chrome.header || chrome.panels || chrome.footer) throw new Error(`the gallery still shows ${JSON.stringify(chrome)}`)
  // It once rendered blank: the board collapsed to zero height inside the overlay.
  const size = await page.$eval('[data-testid="board"]', (el) => ({w: el.clientWidth, h: el.clientHeight, vw: innerWidth, vh: innerHeight}))
  if (size.w < size.vw * 0.9 || size.h < size.vh * 0.9) throw new Error(`the gallery's canvas is ${size.w} x ${size.h} in a ${size.vw} x ${size.vh} window`)
  page.on('request', countHeads)
  await sleep(31_000)
  page.off('request', countHeads)
  if (heads < 2 || heads > 4) throw new Error(`the gallery looked at the chain ${heads} times in 31 s, not about 3`)
  if (shots) await page.screenshot({path: join(shots, '6-gallery.png')})
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="paint-panel"]', {timeout: 20_000})
  log(`gallery: canvas alone, ${heads} looks at the chain in 31 s, Esc returns to the canvas`)

  // The light theme, and a phone that must not scroll sideways.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  if (shots) await page.screenshot({path: join(shots, '4-light.png')})
  await page.setViewport({width: 400, height: 860, deviceScaleFactor: 1})
  await sleep(600)
  // clientWidth, not innerWidth: innerWidth counts the vertical scrollbar,
  // which a long phone page always has, and reads as 17 px of overflow.
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (shots) await page.screenshot({path: join(shots, '5-phone.png'), fullPage: true})
  if (sideways > 0) throw new Error(`at 400 px the page scrolls ${sideways} px sideways`)
  log('light theme and 400 px phone render; no sideways scroll')

  if (problems.length) throw new Error(`the page logged errors:\n  ${problems.join('\n  ')}`)
  log('verify passed')
} finally {
  await browser.close()
}
