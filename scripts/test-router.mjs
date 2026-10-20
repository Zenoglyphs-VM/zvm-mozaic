// The router's rules, against a real EVM: an anvil fork of chain 69 (see
// test-contract.mjs for the command). Deploys a fresh canvas and router.
//
//   node scripts/test-router.mjs [rpc, default $ANVIL_RPC]
//
// Checks that what src/core/ops.ts encodes expands on chain to exactly the
// pixels it was given, that a session paints in its funder's name and no one
// else can take a session over, and measures gas for the model in ops.ts.

import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createPublicClient, createTestClient, createWalletClient, decodeEventLog, defineChain, formatEther, http, parseEther} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'
import {W, abi, readCanvas, TIP_WEI} from './lib.mjs'
import {decodeOps, encodeOps, gasFor, plan} from '../src/core/ops.ts'

const router = JSON.parse(readFileSync(new URL('../contracts/MozaicRouter.json', import.meta.url), 'utf8'))
const canvasArt = JSON.parse(readFileSync(new URL('../contracts/Mozaic.json', import.meta.url), 'utf8'))

const rpc = process.argv[2] ?? process.env.ANVIL_RPC
if (!rpc) throw new Error("pass the fork's JSON-RPC, or set ANVIL_RPC")
const chainId = await createPublicClient({transport: http(rpc)}).getChainId()
const chain = defineChain({id: chainId, name: 'fork', nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18}, rpcUrls: {default: {http: [rpc]}}})
const client = createPublicClient({chain, transport: http(rpc)})
const test = createTestClient({chain, mode: 'anvil', transport: http(rpc)})
const fees = {maxFeePerGas: 1_000_000_000_000n, maxPriorityFeePerGas: TIP_WEI}

const [deployer, alice, mallory] = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()))
for (const a of [deployer, alice, mallory]) await test.setBalance({address: a.address, value: parseEther('100000')})
const as = (account) => createWalletClient({account, chain, transport: http(rpc)})
const mined = async (hash) => {
  const r = await client.waitForTransactionReceipt({hash})
  if (r.status !== 'success') throw new Error(`reverted: ${hash}`)
  return r
}

const price = parseEther('0.0001')
const canvasAddr = (await mined(await as(deployer).deployContract({abi, bytecode: canvasArt.bytecode, args: [price, deployer.address], ...fees}))).contractAddress
const routerAddr = (await mined(await as(deployer).deployContract({abi: router.abi, bytecode: router.bytecode, args: [canvasAddr], ...fees}))).contractAddress
console.log(`canvas ${canvasAddr}, router ${routerAddr}`)
const t = {client, contract: canvasAddr}
const read = (functionName, args = []) => client.readContract({address: routerAddr, abi: router.abi, functionName, args})
const sim = (functionName, args, {value = 0n, account = alice} = {}) => client.simulateContract({address: routerAddr, abi: router.abi, functionName, args, value, account})
async function reverts(fn, why) {
  try {
    await fn()
  } catch (err) {
    const s = String(err.shortMessage ?? err.message) + String(err.details ?? '') + String(err.cause?.reason ?? '')
    if (why && !s.includes(why)) throw new Error(`reverted, but not with "${why}": ${s}`)
    return
  }
  throw new Error(`expected a revert${why ? ` with "${why}"` : ''}`)
}
async function paintVia(account, px) {
  const ops = encodeOps(px)
  return mined(await as(account).writeContract({address: routerAddr, abi: router.abi, functionName: 'paint', args: [ops], value: price * BigInt(px.length), gas: 16_000_000n, ...fees}))
}

assert.equal(await read('price'), price)

// expand() agrees with ops.ts, byte for byte, on a mix of runs and spans.
const mix = []
for (let i = 0; i < 40; i++) mix.push({index: 1000 + i, rgb: i < 10 ? 0xaa0000 : i < 13 ? 0x00bb00 + i : 0x0000cc})
mix.push({index: 5000, rgb: 1}, {index: 5001, rgb: 2}, {index: 9999, rgb: 0xffffff}, {index: W * 1000 - 1, rgb: 0x123456})
const ops = encodeOps(mix)
const expanded = await read('expand', [ops])
const want = '0x' + mix.map((p) => p.index.toString(16).padStart(6, '0') + p.rgb.toString(16).padStart(6, '0')).join('')
assert.equal(expanded, want)
assert.deepEqual(decodeOps(ops), mix)
console.log(`${mix.length} pixels in ${(ops.length - 2) / 2} bytes of ops against ${mix.length * 6} raw; expand() matches`)

// Painted through the router, they are on the canvas.
const r1 = await paintVia(alice, mix)
const px = await readCanvas(t)
for (const p of mix) assert.equal(px[p.index], p.rgb, `pixel ${p.index}`)
// The router names the artist first, then the canvas records its own event.
const events = r1.logs.map((l) => {
  try {
    return {at: l.address.toLowerCase(), ...decodeEventLog({abi: l.address.toLowerCase() === routerAddr.toLowerCase() ? router.abi : abi, data: l.data, topics: l.topics})}
  } catch {
    return null
  }
}).filter(Boolean)
assert.equal(events[0].eventName, 'PaintedBy')
assert.equal(events[0].args.artist.toLowerCase(), alice.address.toLowerCase())
assert.equal(events[1].eventName, 'Painted')
assert.equal(events[1].args.painter.toLowerCase(), routerAddr.toLowerCase())

// The rules.
await reverts(() => sim('paint', [encodeOps([{index: 1, rgb: 1}])], {value: price * 2n}), 'pay price per pixel')
await reverts(() => sim('paint', ['0x'], {}), 'nothing to paint')
await reverts(() => sim('paint', ['0x0100000100'], {value: price}), 'truncated op')
await reverts(() => sim('paint', ['0x020000010003aabbcc'], {value: price * 3n}), 'truncated span')
await reverts(() => sim('paint', ['0x010000010000aabbcc'], {value: 0n}), 'empty op')
await reverts(() => sim('paint', ['0x030000010001aabbcc'], {value: price}), 'unknown op')
await reverts(() => sim('paint', [encodeOps([{index: W * 1000, rgb: 1}])], {value: price}), 'off the canvas')

// Sessions: alice funds a key, and its paints are hers.
const session = privateKeyToAccount(generatePrivateKey())
await mined(await as(alice).writeContract({address: routerAddr, abi: router.abi, functionName: 'open', args: [session.address], value: parseEther('30'), ...fees}))
assert.equal(await client.getBalance({address: session.address}), parseEther('30'))
assert.equal((await read('ownerOf', [session.address])).toLowerCase(), alice.address.toLowerCase())
assert.equal((await read('artistOf', [session.address])).toLowerCase(), alice.address.toLowerCase())
await reverts(() => sim('open', [session.address], {value: 1n, account: mallory}), "someone else's session")
// Alice may top her own session up.
await mined(await as(alice).writeContract({address: routerAddr, abi: router.abi, functionName: 'open', args: [session.address], value: 1n, ...fees}))
const r2 = await paintVia(session, [{index: 77, rgb: 0x777777}])
const by = decodeEventLog({abi: router.abi, data: r2.logs[0].data, topics: r2.logs[0].topics})
assert.equal(by.args.artist.toLowerCase(), alice.address.toLowerCase())
assert.equal(by.args.sender.toLowerCase(), session.address.toLowerCase())
console.log('a session paints in its funder\'s name, and cannot be taken over')

// Gas, against the model in ops.ts.
const row = (y, n, rgb) => Array.from({length: n}, (_, x) => ({index: y * W + x, rgb}))
const rows = (y0, count, n, f) => Array.from({length: count}, (_, k) => row(y0 + k, n, 0)).flat().map((p, i) => ({index: p.index, rgb: f(i)}))
const cases = [
  ['solid, blank rows', rows(200, 4, 1000, () => 0x00ff00), true],
  ['solid, repainted', rows(200, 4, 1000, () => 0x0000ff), false],
  ['noise, blank rows', rows(300, 4, 1000, () => (Math.random() * 0xfffffe) | 0), true],
]
for (const [name, list, blank] of cases) {
  const r = await paintVia(alice, list)
  const model = gasFor(list, () => blank)
  const ratio = Number(model) / Number(r.gasUsed)
  console.log(`${name.padEnd(20)} ${list.length} px, ${(encodeOps(list).length - 2) / 2} bytes: ${r.gasUsed} gas (${Math.round(Number(r.gasUsed) / list.length)}/px), model ${model} (${ratio.toFixed(2)}x)`)
  assert.ok(ratio >= 1 && ratio < 1.25, `the gas model for "${name}" is off: ${ratio.toFixed(2)}x of what was used`)
}

// A planned batch fits under Karst's transaction cap with the page's margin.
const big = rows(400, 10, 1000, () => 0x335577)
const batch = plan(big, () => true)[0]
const rb = await paintVia(alice, batch.px)
assert.ok((rb.gasUsed * 11n) / 10n < 16_777_216n, `a full planned batch used ${rb.gasUsed}`)
console.log(`a full planned batch: ${batch.px.length} px, ${(batch.ops.length - 2) / 2} bytes, ${rb.gasUsed} gas, ${formatEther(rb.gasUsed * TIP_WEI)} ZNN at the tip`)
console.log('all router checks passed')
