// What every Mozaic script shares: where the chain is, which contract, whose
// key, and how a list of pixels becomes transactions.
//
// Settings come from the environment, so a bot is configured the same way
// whether it runs from a shell, a cron job or a container:
//
//   MOZAIC_RPC        JSON-RPC, default $ZVM_RPC; one of them must be set
//   MOZAIC_CONTRACT   default: deployments/<chain>.json for that chain
//   MOZAIC_ROUTER     default: the router in that record, when it is the
//                     record's canvas; "none" paints the canvas directly
//   MOZAIC_KEY        a 0x private key, or
//   MOZAIC_KEY_FILE   a file holding one (what `mozaic key` writes)
//
// The compact paint format, the gas model and the batch cutting are
// src/core/ops.ts, the very file the page uses: Node runs it as it is.

import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
} from 'viem'
import {privateKeyToAccount} from 'viem/accounts'
import {plan} from '../src/core/ops.ts'

export const artifact = JSON.parse(readFileSync(new URL('../contracts/Mozaic.json', import.meta.url), 'utf8'))
export const abi = artifact.abi
export const routerAbi = JSON.parse(readFileSync(new URL('../contracts/MozaicRouter.json', import.meta.url), 'utf8')).abi

export const W = 1000
export const H = 1000
export const PER_SLOT = 10
export const SLOTS = (W * H) / PER_SLOT

/** The relayer accepts a transaction on its effective tip, and its floor is 50
 *  gwei. Every sender in the zvm tree offers double that. */
export const TIP_WEI = 100_000_000_000n
/** Karst's per-transaction gas cap. */
export const MAX_TX_GAS = 16_777_216n

/** One transaction carries at most this many pixels, and touches at most this
 *  many storage slots. Together they bound gas: the worst case, 400 slots
 *  written for the first time with ten pixels each, is about 11.4M, inside
 *  the 16.7M cap even after estimateGas's margin. src/core/codec.ts agrees. */
export const MAX_PIXELS_PER_TX = 4000
export const MAX_SLOTS_PER_TX = 400

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- colour and wire format ------------------------------------------------

/** "#ff0080", "ff0080", "f08" or a number, to 0xRRGGBB. */
export function parseColor(input) {
  if (typeof input === 'number') return input & 0xffffff
  let s = String(input).trim().replace(/^#|^0x/i, '')
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.replace(/./g, (c) => c + c)
  if (!/^[0-9a-f]{6}$/i.test(s)) throw new Error(`not a colour: ${input} (use #rrggbb)`)
  return parseInt(s, 16)
}

export const hex = (rgb) => '#' + rgb.toString(16).padStart(6, '0')

/** Pixels ({x, y, rgb}) to paint()'s argument: six bytes each, index then colour. */
export function encode(pixels) {
  const out = new Uint8Array(pixels.length * 6)
  pixels.forEach((p, i) => {
    const index = p.index ?? p.y * W + p.x
    const o = i * 6
    out[o] = index >> 16
    out[o + 1] = (index >> 8) & 0xff
    out[o + 2] = index & 0xff
    out[o + 3] = p.rgb >> 16
    out[o + 4] = (p.rgb >> 8) & 0xff
    out[o + 5] = p.rgb & 0xff
  })
  return '0x' + Buffer.from(out).toString('hex')
}

export function decode(data) {
  const b = Buffer.from(data.replace(/^0x/, ''), 'hex')
  const out = []
  for (let o = 0; o + 6 <= b.length; o += 6) {
    const index = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]
    out.push({index, x: index % W, y: Math.floor(index / W), rgb: (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5]})
  }
  return out
}

/**
 * Splits pixels into transactions by the two limits above, keeping a slot's
 * pixels together where it can, since ten pixels in one slot cost barely more
 * than one. Sorting by index is what makes a row share slots.
 */
export function batches(pixels) {
  const sorted = [...pixels].sort((a, b) => (a.index ?? a.y * W + a.x) - (b.index ?? b.y * W + b.x))
  const out = []
  let cur = []
  let slots = new Set()
  for (const p of sorted) {
    const slot = Math.floor((p.index ?? p.y * W + p.x) / PER_SLOT)
    if (cur.length >= MAX_PIXELS_PER_TX || (!slots.has(slot) && slots.size >= MAX_SLOTS_PER_TX)) {
      out.push(cur)
      cur = []
      slots = new Set()
    }
    cur.push(p)
    slots.add(slot)
  }
  if (cur.length) out.push(cur)
  return out
}

// --- chain -----------------------------------------------------------------

export function settings() {
  const rpc = process.env.MOZAIC_RPC || process.env.ZVM_RPC
  if (!rpc) throw new Error("set MOZAIC_RPC or ZVM_RPC to a ZVM node's JSON-RPC")
  return {rpc, contract: process.env.MOZAIC_CONTRACT || null}
}

/** The deployment record for a chain id, from deployments/. */
export function deploymentFor(chainId) {
  const dir = new URL('../deployments/', import.meta.url)
  if (!existsSync(dir)) return null
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const rec = JSON.parse(readFileSync(new URL(f, dir), 'utf8'))
    if (rec.chainId === chainId) return rec
  }
  return null
}

export function loadKey() {
  let key = process.env.MOZAIC_KEY
  if (!key && process.env.MOZAIC_KEY_FILE) {
    const raw = readFileSync(process.env.MOZAIC_KEY_FILE, 'utf8').trim()
    key = raw.startsWith('{') ? JSON.parse(raw).privateKey : raw
  }
  if (!key) return null
  if (!/^0x[0-9a-fA-F]{64}$/.test(key.trim())) throw new Error('MOZAIC_KEY is not a 0x private key of 64 hex characters')
  return privateKeyToAccount(key.trim())
}

export async function connect({needKey = false} = {}) {
  const {rpc, contract: override} = settings()
  const probe = createPublicClient({transport: http(rpc)})
  const chainId = await probe.getChainId()
  const chain = defineChain({
    id: chainId,
    name: `ZVM ${chainId}`,
    nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18},
    rpcUrls: {default: {http: [rpc]}},
  })
  const client = createPublicClient({chain, transport: http(rpc, {batch: {wait: 10}, timeout: 60_000})})
  const record = deploymentFor(chainId)
  const contract = override || record?.mozaic
  if (!contract) throw new Error(`no Mozaic known on chain ${chainId}; set MOZAIC_CONTRACT`)
  const routerEnv = process.env.MOZAIC_ROUTER
  let router = routerEnv === 'none' ? null : routerEnv || (record?.mozaic?.toLowerCase() === contract.toLowerCase() ? record.router : null) || null
  if (router) {
    // Only a router that says it fronts this canvas.
    const fronts = await client.readContract({address: router, abi: routerAbi, functionName: 'canvas'}).catch(() => null)
    if (!fronts || fronts.toLowerCase() !== contract.toLowerCase()) router = null
  }
  const account = loadKey()
  if (needKey && !account) throw new Error('set MOZAIC_KEY (a 0x private key) or MOZAIC_KEY_FILE. `mozaic key` makes one.')
  const wallet = account ? createWalletClient({account, chain, transport: http(rpc, {timeout: 60_000})}) : null
  const apiBase = /\/rpc$/.test(rpc) ? rpc.replace(/\/rpc$/, '') : null
  return {rpc, apiBase, chain, chainId, client, wallet, account, contract, router}
}

export async function readInfo(t) {
  const call = (functionName, args = []) => t.client.readContract({address: t.contract, abi, functionName, args})
  const [price, painted, owner, width, height] = await Promise.all([call('price'), call('painted'), call('owner'), call('WIDTH'), call('HEIGHT')])
  if (Number(width) !== W || Number(height) !== H) throw new Error(`this Mozaic is ${width} x ${height}; the scripts are built for ${W} x ${H}`)
  const balance = await t.client.getBalance({address: t.contract})
  return {price, painted, owner, balance}
}

/**
 * The whole canvas as a Uint32Array of 0xRRGGBB, a million entries, read with
 * `chunk` in ten calls of ten thousand slots.
 */
export async function readCanvas(t, {slotsPerCall = 10_000} = {}) {
  const px = new Uint32Array(W * H).fill(0xffffff)
  const starts = []
  for (let s = 0; s < SLOTS; s += slotsPerCall) starts.push(s)
  await Promise.all(
    starts.map(async (start) => {
      const data = await t.client.readContract({address: t.contract, abi, functionName: 'chunk', args: [BigInt(start), BigInt(slotsPerCall)]})
      applyChunk(px, data)
    }),
  )
  return px
}

export function applyChunk(px, data) {
  const b = Buffer.from(data.replace(/^0x/, ''), 'hex')
  for (let o = 0; o + 36 <= b.length; o += 36) {
    const slot = b.readUInt32BE(o)
    let v = BigInt('0x' + b.subarray(o + 4, o + 36).toString('hex'))
    for (let k = 0; k < PER_SLOT; k++) {
      px[slot * PER_SLOT + k] = Number(v & 0xffffffn) ^ 0xffffff
      v >>= 24n
    }
  }
}

/** Current colours of just these pixels, reading only the slots they are in. `slots` gets the raw slot values. */
export async function readPixels(t, indices, slots = new Map()) {
  const wanted = [...new Set(indices.map((i) => Math.floor(i / PER_SLOT)))]
  const values = new Map()
  for (let i = 0; i < wanted.length; i += 500) {
    const part = wanted.slice(i, i + 500)
    const got = await Promise.all(part.map((s) => t.client.readContract({address: t.contract, abi, functionName: 'slotAt', args: [BigInt(s)]})))
    part.forEach((s, j) => values.set(s, got[j]))
  }
  for (const [k, v] of values) slots.set(k, v)
  const out = new Map()
  for (const index of indices) {
    const v = values.get(Math.floor(index / PER_SLOT))
    out.set(index, Number((v >> BigInt((index % PER_SLOT) * 24)) & 0xffffffn) ^ 0xffffff)
  }
  return out
}

async function fees(t) {
  const block = await t.client.getBlock({blockTag: 'latest'})
  const base = block.baseFeePerGas ?? 0n
  return {maxFeePerGas: base * 2n + TIP_WEI, maxPriorityFeePerGas: TIP_WEI}
}

/**
 * Paints pixels: drops the ones already that colour (unless `all`), splits the
 * rest into transactions, and sends them with consecutive nonces, a few in
 * flight at once. Returns the receipts. `maxZnn` refuses to start a paint that
 * would cost more, fees included, which is the one guard a bot left running
 * overnight needs.
 */
export async function paint(t, pixels, {dryRun = false, all = false, maxZnn = null, inFlight = 4, log = console.log} = {}) {
  const info = await readInfo(t)
  // Last entry per index wins, as it would on chain; sending both only pays twice.
  const byIndex = new Map()
  for (const p of pixels) {
    const index = p.index ?? p.y * W + p.x
    if (index < 0 || index >= W * H) throw new Error(`pixel ${p.x},${p.y} is off the canvas`)
    byIndex.set(index, {index, rgb: p.rgb & 0xffffff})
  }
  let todo = [...byIndex.values()].sort((a, b) => a.index - b.index)
  const slots = new Map()
  const now = await readPixels(t, todo.map((p) => p.index), slots)
  if (!all) todo = todo.filter((p) => now.get(p.index) !== p.rgb)
  const groups = calls(t, todo, (slot) => slots.get(slot) === 0n)
  const cost = info.price * BigInt(todo.length)
  const f = await fees(t)
  // A ceiling on fees: the gas model, which errs over, at the maximum fee.
  const feeCeiling = groups.reduce((sum, g) => sum + g.gas * f.maxFeePerGas, 0n)
  log(`${todo.length} pixels to paint (${byIndex.size - todo.length} already right), ${groups.length} transaction(s)${t.router ? ' through the router' : ''}`)
  log(`paint ${formatEther(cost)} ZNN, network fees at most ${formatEther(feeCeiling)} ZNN`)
  if (!todo.length || dryRun) return []
  if (maxZnn !== null && Number(formatEther(cost + feeCeiling)) > maxZnn) {
    throw new Error(`this paint could cost ${formatEther(cost + feeCeiling)} ZNN, over --max-znn ${maxZnn}`)
  }
  const have = await t.client.getBalance({address: t.account.address})
  if (have < cost) throw new Error(`${t.account.address} holds ${formatEther(have)} ZNN and the paint alone is ${formatEther(cost)}. \`mozaic faucet\` on a devnet.`)

  let nonce = await t.client.getTransactionCount({address: t.account.address, blockTag: 'pending'})
  const receipts = []
  const pending = []
  for (const [i, g] of groups.entries()) {
    const value = info.price * BigInt(g.px.length)
    const est = await t.client.estimateGas({account: t.account.address, to: g.to, data: g.data, value})
    // The relayer budgets a momentum by declared gas, so declare little over the estimate.
    const gas = minBig((est * 11n) / 10n, MAX_TX_GAS)
    const hash = await t.wallet.sendTransaction({to: g.to, data: g.data, value, gas, nonce: nonce++, ...f})
    log(`  tx ${i + 1}/${groups.length}: ${g.px.length} pixels, ${hash}`)
    pending.push(t.client.waitForTransactionReceipt({hash, pollingInterval: 4000, timeout: 600_000}).then((r) => {
      if (r.status !== 'success') throw new Error(`${hash} reverted`)
      log(`  executed in block ${r.blockNumber}: ${hash}`)
      receipts.push(r)
    }))
    if (pending.length >= inFlight) await pending.shift()
  }
  await Promise.all(pending)
  return receipts
}

export const encodeCall = (group) => encodeFunctionData({abi, functionName: 'paint', args: [encode(group)]})

/**
 * Pixels, in index order, as calls: through the router in compact ops, cut by
 * ops.ts's plan, or straight to the canvas in its six-byte form, in the old
 * 4,000-pixel batches, when there is no router.
 */
export function calls(t, sorted, blank) {
  if (t.router) {
    return plan(sorted, blank).map((b) => ({
      px: b.px,
      to: t.router,
      data: encodeFunctionData({abi: routerAbi, functionName: 'paint', args: [b.ops]}),
      gas: b.gas,
    }))
  }
  return batches(sorted).map((g) => ({px: g, to: t.contract, data: encodeCall(g), gas: estimateGas(g)}))
}

/** Gas for one batch if every slot it touches is being written for the first time. */
export function estimateGas(group) {
  const slots = new Set(group.map((p) => Math.floor((p.index ?? p.y * W + p.x) / PER_SLOT)))
  return 60_000n + BigInt(slots.size) * 22_300n + BigInt(group.length) * 600n
}

const minBig = (a, b) => (a < b ? a : b)

/** The node's faucet, when the RPC is a zvm node's. */
export async function faucet(t, address) {
  if (!t.apiBase) throw new Error('this RPC is not a zvm node, so there is no faucet beside it')
  const res = await fetch(`${t.apiBase}/api/faucet`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({address}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`faucet: ${text.trim() || res.status}`)
  return JSON.parse(text)
}
