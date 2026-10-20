#!/usr/bin/env node
// Mozaic from a terminal, for people and for bots.
//
//   npm run mozaic -- <command> [args] [--dry-run] [--max-znn N] [--all]
//
// Reads need nothing. Painting needs MOZAIC_KEY (or MOZAIC_KEY_FILE); see
// scripts/lib.mjs for every setting. Run with no command for the list.

import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {parseArgs} from 'node:util'
import {formatEther, parseAbiItem} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'
import {PNG} from 'pngjs'
import {W, H, abi, connect, decode, faucet, hex, paint, parseColor, readCanvas, readInfo, readPixels, sleep} from './lib.mjs'

const HELP = `mozaic: a million-pixel canvas on the ZVM

reads
  info                              contract, price, pixels painted, your balance
  get <x> <y>                       one pixel's colour
  snapshot <out.png> [x y w h]      the canvas, or part of it, as a PNG
  watch [--from BLOCK]              every paint as a JSON line, as it lands

paints (MOZAIC_KEY)
  paint <x> <y> <#rrggbb> [<x> <y> <#rrggbb> ...]
  rect <x> <y> <w> <h> <#rrggbb> [--outline]
  line <x0> <y0> <x1> <y1> <#rrggbb>
  image <file.png> <x> <y> [--width N] [--alpha 128]
                                    a PNG, scaled to --width, transparent pixels skipped
  keep <file.png> <x> <y> [--width N] [--every 30]
                                    hold an image in place: repaint what others change
  json <file.json>                  [{"x":1,"y":2,"color":"#ff0000"}, ...], or - for stdin

account
  key [file]                        make a new key (default: secrets/bot.key)
  faucet                            devnet ZNN for your key, from the node's faucet
  withdraw <to>                     owner only: send what painting paid to <to>
  clear                             owner only: the whole canvas back to white, at once
  transfer-ownership <address>      owner only: hand all three owner powers to another address

flags
  --dry-run      say what it would paint and cost, send nothing
  --all          paint pixels that already have the colour (skipped by default)
  --max-znn N    refuse a paint that could cost more than N ZNN, fees included

env: MOZAIC_RPC (default $ZVM_RPC), MOZAIC_CONTRACT, MOZAIC_KEY, MOZAIC_KEY_FILE`

const {values: flags, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': {type: 'boolean', default: false},
    all: {type: 'boolean', default: false},
    'max-znn': {type: 'string'},
    outline: {type: 'boolean', default: false},
    width: {type: 'string'},
    alpha: {type: 'string', default: '128'},
    every: {type: 'string', default: '30'},
    from: {type: 'string'},
    help: {type: 'boolean', short: 'h', default: false},
  },
})

const [cmd, ...rest] = positionals
const int = (v, name) => {
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number, got ${v}`)
  return n
}
const paintOpts = () => ({dryRun: flags['dry-run'], all: flags.all, maxZnn: flags['max-znn'] ? Number(flags['max-znn']) : null})
const inside = (p) => p.x >= 0 && p.y >= 0 && p.x < W && p.y < H

const commands = {
  async info() {
    const t = await connect()
    const i = await readInfo(t)
    console.log(`rpc       ${t.rpc} (chain ${t.chainId})`)
    console.log(`contract  ${t.contract}`)
    console.log(`router    ${t.router ?? 'none: painting the canvas directly'}`)
    console.log(`canvas    ${W} x ${H}, ${formatEther(i.price)} ZNN per pixel`)
    console.log(`painted   ${i.painted} pixels since deployment`)
    console.log(`holds     ${formatEther(i.balance)} ZNN, withdrawable by ${i.owner}`)
    if (t.account) console.log(`you       ${t.account.address}, ${formatEther(await t.client.getBalance({address: t.account.address}))} ZNN`)
  },

  async get(x, y) {
    const t = await connect()
    const rgb = await t.client.readContract({address: t.contract, abi, functionName: 'pixel', args: [BigInt(int(x, 'x')), BigInt(int(y, 'y'))]})
    console.log(hex(Number(rgb)))
  },

  async snapshot(out, x = 0, y = 0, w = W, h = H) {
    if (!out) throw new Error('snapshot <out.png>')
    ;[x, y, w, h] = [int(x, 'x'), int(y, 'y'), int(w, 'w'), int(h, 'h')]
    const t = await connect()
    const px = await readCanvas(t)
    const png = new PNG({width: w, height: h})
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const c = px[(y + j) * W + x + i]
        const o = (j * w + i) * 4
        png.data[o] = c >> 16
        png.data[o + 1] = (c >> 8) & 0xff
        png.data[o + 2] = c & 0xff
        png.data[o + 3] = 255
      }
    writeFileSync(out, PNG.sync.write(png))
    console.log(`wrote ${out} (${w} x ${h})`)
  },

  async watch() {
    const t = await connect()
    const painted = parseAbiItem('event Painted(address indexed painter, uint256 count, bytes pixels)')
    const paintedBy = parseAbiItem('event PaintedBy(address indexed artist, address indexed sender, uint256 count)')
    let next = flags.from ? BigInt(flags.from) : (await t.client.getBlockNumber()) + 1n
    console.error(`watching ${t.contract}${t.router ? ` and its router ${t.router}` : ''} from block ${next}`)
    for (;;) {
      const head = await t.client.getBlockNumber()
      if (head >= next) {
        for (let from = next; from <= head; from += 5000n) {
          const to = from + 4999n < head ? from + 4999n : head
          const logs = await t.client.getLogs({address: [t.contract, t.router].filter(Boolean), events: [painted, paintedBy], fromBlock: from, toBlock: to})
          // A paint through the router is its artist's: the router names them
          // just before the canvas logs the pixels, in the same transaction.
          const artist = new Map()
          for (const l of logs) {
            if (l.eventName === 'PaintedBy') {
              artist.set(l.transactionHash, l.args.artist)
              continue
            }
            const pixels = decode(l.args.pixels).map((p) => ({x: p.x, y: p.y, color: hex(p.rgb)}))
            console.log(JSON.stringify({block: Number(l.blockNumber), tx: l.transactionHash, painter: artist.get(l.transactionHash) ?? l.args.painter, pixels}))
          }
        }
        next = head + 1n
      }
      await sleep(15_000) // one momentum: a block cannot land faster
    }
  },

  async paint(...args) {
    if (!args.length || args.length % 3) throw new Error('paint <x> <y> <#rrggbb> [...], in threes')
    const pixels = []
    for (let i = 0; i < args.length; i += 3) pixels.push({x: int(args[i], 'x'), y: int(args[i + 1], 'y'), rgb: parseColor(args[i + 2])})
    await paint(await connect({needKey: !flags['dry-run']}), pixels, paintOpts())
  },

  async rect(x, y, w, h, color) {
    ;[x, y, w, h] = [int(x, 'x'), int(y, 'y'), int(w, 'w'), int(h, 'h')]
    const rgb = parseColor(color)
    const pixels = []
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        if (flags.outline && i > 0 && j > 0 && i < w - 1 && j < h - 1) continue
        pixels.push({x: x + i, y: y + j, rgb})
      }
    await paint(await connect({needKey: !flags['dry-run']}), pixels.filter(inside), paintOpts())
  },

  async line(x0, y0, x1, y1, color) {
    ;[x0, y0, x1, y1] = [int(x0, 'x0'), int(y0, 'y0'), int(x1, 'x1'), int(y1, 'y1')]
    const rgb = parseColor(color)
    const pixels = []
    // Bresenham, so a bot's line is the same line the page's line tool draws.
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      pixels.push({x: x0, y: y0, rgb})
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) (err += dy), (x0 += sx)
      if (e2 <= dx) (err += dx), (y0 += sy)
    }
    await paint(await connect({needKey: !flags['dry-run']}), pixels.filter(inside), paintOpts())
  },

  async image(file, x, y) {
    const pixels = imagePixels(file, int(x, 'x'), int(y, 'y'))
    await paint(await connect({needKey: !flags['dry-run']}), pixels, paintOpts())
  },

  async keep(file, x, y) {
    const want = imagePixels(file, int(x, 'x'), int(y, 'y'))
    const every = Math.max(15, Number(flags.every)) * 1000
    const t = await connect({needKey: !flags['dry-run']})
    console.log(`keeping ${want.length} pixels of ${file} at ${x},${y}; checking every ${every / 1000}s`)
    for (;;) {
      try {
        const now = await readPixels(t, want.map((p) => p.y * W + p.x))
        const wrong = want.filter((p) => now.get(p.y * W + p.x) !== p.rgb)
        if (wrong.length) {
          console.log(`${new Date().toISOString()} ${wrong.length} pixels changed; repainting`)
          await paint(t, wrong, {...paintOpts(), all: true})
        }
      } catch (err) {
        // A bot left running should outlive a node restart or one failed paint.
        console.error(`${new Date().toISOString()} ${err.shortMessage ?? err.message}`)
      }
      await sleep(every)
    }
  },

  async json(file) {
    const raw = file === '-' || !file ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8')
    const pixels = JSON.parse(raw).map((p) => ({x: int(p.x, 'x'), y: int(p.y, 'y'), rgb: parseColor(p.color ?? p.rgb)}))
    await paint(await connect({needKey: !flags['dry-run']}), pixels.filter(inside), paintOpts())
  },

  async key(file = 'secrets/bot.key') {
    if (existsSync(file)) throw new Error(`${file} exists; not overwriting it`)
    const privateKey = generatePrivateKey()
    writeFileSync(file, privateKey + '\n', {flag: 'wx', mode: 0o600})
    console.log(`${privateKeyToAccount(privateKey).address}\nkey written to ${file}; use MOZAIC_KEY_FILE=${file}`)
  },

  async faucet() {
    const t = await connect({needKey: true})
    const r = await faucet(t, t.account.address)
    // The drip lands a momentum or two later; the answer only says it was sent.
    console.log(`faucet sent devnet ZNN to ${t.account.address} in ${r.l2Tx}; it lands in about thirty seconds`)
  },

  async withdraw(to) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(to ?? '')) throw new Error('withdraw <0x address to send to>')
    const t = await connect({needKey: true})
    const i = await readInfo(t)
    if (i.owner.toLowerCase() !== t.account.address.toLowerCase()) throw new Error(`the owner is ${i.owner}, and this key is ${t.account.address}`)
    console.log(`withdrawing ${formatEther(i.balance)} ZNN to ${to}`)
    if (flags['dry-run']) return
    const hash = await t.wallet.writeContract({address: t.contract, abi, functionName: 'withdraw', args: [to], maxPriorityFeePerGas: 100_000_000_000n})
    const r = await t.client.waitForTransactionReceipt({hash, pollingInterval: 4000, timeout: 600_000})
    console.log(`${r.status}: ${hash}`)
  },

  async 'transfer-ownership'(next) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(next ?? '')) throw new Error('transfer-ownership <0x address of the new owner>')
    const t = await ownerOnly()
    console.log(`handing ownership to ${next}; from then on it alone can withdraw, clear and hand ownership on`)
    if (flags['dry-run']) return
    await ownerCall(t, 'transferOwnership', [next])
  },

  // The old name, kept for anyone who learned it.
  async 'set-owner'(next) {
    return commands['transfer-ownership'](next)
  },

  async clear() {
    const t = await ownerOnly()
    const i = await readInfo(t)
    console.log(`clearing the whole canvas to white; ${i.painted} pixels painted so far stay counted, and the ${formatEther(i.balance)} ZNN it holds stays put`)
    if (flags['dry-run']) return
    await ownerCall(t, 'clear', [])
  },
}

/** Connects with MOZAIC_KEY and refuses unless that key owns the canvas. */
async function ownerOnly() {
  const t = await connect({needKey: true})
  const i = await readInfo(t)
  if (i.owner.toLowerCase() !== t.account.address.toLowerCase()) throw new Error(`the owner is ${i.owner}, and this key is ${t.account.address}`)
  return t
}

async function ownerCall(t, functionName, args) {
  const hash = await t.wallet.writeContract({address: t.contract, abi, functionName, args, maxPriorityFeePerGas: 100_000_000_000n})
  const r = await t.client.waitForTransactionReceipt({hash, pollingInterval: 4000, timeout: 600_000})
  console.log(`${r.status}: ${hash}`)
}

/** A PNG's opaque pixels, scaled (nearest neighbour) to --width, placed at x,y. */
function imagePixels(file, x, y) {
  if (!file) throw new Error('image <file.png> <x> <y>')
  const png = PNG.sync.read(readFileSync(file))
  const w = flags.width ? int(flags.width, '--width') : png.width
  const h = Math.max(1, Math.round((png.height * w) / png.width))
  const alpha = Number(flags.alpha)
  const pixels = []
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const sx = Math.min(png.width - 1, Math.floor((i * png.width) / w))
      const sy = Math.min(png.height - 1, Math.floor((j * png.height) / h))
      const o = (sy * png.width + sx) * 4
      if (png.data[o + 3] < alpha) continue
      pixels.push({x: x + i, y: y + j, rgb: (png.data[o] << 16) | (png.data[o + 1] << 8) | png.data[o + 2]})
    }
  return pixels.filter(inside)
}

if (!cmd || flags.help || !commands[cmd]) {
  console.log(HELP)
  process.exit(cmd && !commands[cmd] ? 1 : 0)
}
try {
  await commands[cmd](...rest)
} catch (err) {
  console.error(`mozaic ${cmd}: ${err.shortMessage ?? err.message}`)
  process.exit(1)
}
