// The contract's rules, checked against a real EVM: an anvil fork of chain 69.
//
//   docker run -d -p 127.0.0.1:48747:8545 --add-host=host.docker.internal:host-gateway \
//     ghcr.io/foundry-rs/foundry:latest \
//     "anvil --host 0.0.0.0 --fork-url $ZVM_RPC --chain-id 7340469 --block-time 1"
//   node scripts/test-contract.mjs [rpc, default $ANVIL_RPC]
//
// Deploys a fresh Mozaic each run, so it never touches a deployment anyone uses.

import assert from 'node:assert/strict'
import {createPublicClient, createTestClient, createWalletClient, defineChain, formatEther, http, parseEther} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'
import {W, abi, applyChunk, artifact, encode, readCanvas, SLOTS, TIP_WEI} from './lib.mjs'

const rpc = process.argv[2] ?? process.env.ANVIL_RPC
if (!rpc) throw new Error("pass the fork's JSON-RPC, or set ANVIL_RPC")
const chainId = await createPublicClient({transport: http(rpc)}).getChainId()
const chain = defineChain({id: chainId, name: 'fork', nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18}, rpcUrls: {default: {http: [rpc]}}})
const client = createPublicClient({chain, transport: http(rpc)})
const test = createTestClient({chain, mode: 'anvil', transport: http(rpc)})

const owner = privateKeyToAccount(generatePrivateKey())
const painter = privateKeyToAccount(generatePrivateKey())
for (const a of [owner, painter]) await test.setBalance({address: a.address, value: parseEther('10000')})
const as = (account) => createWalletClient({account, chain, transport: http(rpc)})
const fees = {maxFeePerGas: 1_000_000_000_000n, maxPriorityFeePerGas: TIP_WEI}

const price = parseEther('0.0001')
const deployHash = await as(owner).deployContract({abi, bytecode: artifact.bytecode, args: [price, owner.address], ...fees})
const address = (await client.waitForTransactionReceipt({hash: deployHash})).contractAddress
const t = {client, contract: address}
console.log(`Mozaic at ${address}`)

const read = (functionName, args = []) => client.readContract({address, abi, functionName, args})
async function paint(pixels, {value, account = painter} = {}) {
  const data = encode(pixels)
  const hash = await as(account).writeContract({address, abi, functionName: 'paint', args: [data], value: value ?? price * BigInt(pixels.length), gas: 16_000_000n, ...fees})
  const r = await client.waitForTransactionReceipt({hash})
  if (r.status !== 'success') throw new Error('reverted')
  return r
}
const sim = (functionName, args, {value = 0n, account = painter} = {}) =>
  client.simulateContract({address, abi, functionName, args, value, account})
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
const color = async (x, y) => Number(await read('pixel', [BigInt(x), BigInt(y)]))

// An untouched canvas is white.
assert.equal(await color(0, 0), 0xffffff)
assert.equal(await color(999, 999), 0xffffff)

// Out of order, back and forth between slots, and the same index twice: the
// last entry for an index wins, whatever else is in between.
await paint([
  {x: 3, y: 0, rgb: 0x111111},
  {x: 25, y: 0, rgb: 0x222222},
  {x: 4, y: 0, rgb: 0x333333},
  {x: 3, y: 0, rgb: 0x444444},
  {x: 999, y: 999, rgb: 0x000000},
  {x: 25, y: 0, rgb: 0x555555},
])
assert.equal(await color(3, 0), 0x444444)
assert.equal(await color(4, 0), 0x333333)
assert.equal(await color(25, 0), 0x555555)
assert.equal(await color(999, 999), 0x000000)
assert.equal(await color(5, 0), 0xffffff, 'a neighbour in the same slot is untouched')
assert.equal(await read('painted'), 6n)

// Painting white stores zero again, so chunk() leaves the slot out.
await paint([{x: 999, y: 999, rgb: 0xffffff}])
assert.equal(await color(999, 999), 0xffffff)
assert.equal(await read('slotAt', [BigInt(SLOTS - 1)]), 0n)

// chunk() and the whole-canvas read agree with pixel().
const px = await readCanvas(t)
assert.equal(px[3], 0x444444)
assert.equal(px[25], 0x555555)
assert.equal(px[W * 999 + 999], 0xffffff)
const one = new Uint32Array(W * 1000).fill(0xffffff)
applyChunk(one, await read('chunk', [0n, 3n]))
assert.equal(one[4], 0x333333)
assert.equal((await read('chunk', [BigInt(SLOTS), 10n])), '0x', 'past the end is empty')

// The rules.
await reverts(() => sim('paint', [encode([{index: W * 1000, rgb: 1}])], {value: price}), 'off the canvas')
await reverts(() => sim('paint', [encode([{x: 1, y: 1, rgb: 1}])], {value: price * 2n}), 'pay price per pixel')
await reverts(() => sim('paint', [encode([{x: 1, y: 1, rgb: 1}])]), 'pay price per pixel')
await reverts(() => sim('paint', ['0x0000010203']), '6 bytes per pixel')
await reverts(() => sim('paint', ['0x']), '6 bytes per pixel')
await reverts(() => client.call({account: painter, to: address, value: 1n}))

// Money: held by the contract, withdrawable by the owner alone, at any time.
const held = await client.getBalance({address})
assert.equal(held, price * 7n)
await reverts(() => sim('withdraw', [painter.address]), 'not the owner')
const sink = privateKeyToAccount(generatePrivateKey()).address
const wr = await client.waitForTransactionReceipt({hash: await as(owner).writeContract({address, abi, functionName: 'withdraw', args: [sink], ...fees})})
assert.equal(wr.status, 'success')
assert.equal(await client.getBalance({address: sink}), held)
assert.equal(await client.getBalance({address}), 0n)
await reverts(() => sim('withdraw', ['0x0000000000000000000000000000000000000000'], {account: owner}), 'no recipient')

// Clearing: the owner alone, the whole board white at once, the money untouched.
await reverts(() => sim('clear', []), 'not the owner')
await paint([{x: 0, y: 0, rgb: 0x123456}, {x: 999, y: 999, rgb: 0x654321}])
const potBefore = await client.getBalance({address})
const paintedBefore = await read('painted')
const cr = await client.waitForTransactionReceipt({hash: await as(owner).writeContract({address, abi, functionName: 'clear', args: [], ...fees})})
assert.equal(cr.status, 'success')
assert.ok(cr.gasUsed < 60_000n, `clear() should be one cheap write, used ${cr.gasUsed}`)
assert.equal(await read('epoch'), 1n)
assert.equal(await color(0, 0), 0xffffff)
assert.equal(await color(999, 999), 0xffffff)
assert.equal(await color(3, 0), 0xffffff, 'everything painted before is gone')
assert.equal(await read('chunk', [0n, BigInt(SLOTS)]), '0x', 'a cleared canvas has no written slots')
assert.equal(await client.getBalance({address}), potBefore, 'clearing leaves the pot alone')
assert.equal(await read('painted'), paintedBefore, 'the painted count runs across clears')
// Painting after a clear writes the new canvas.
await paint([{x: 5, y: 5, rgb: 0xabcdef}])
assert.equal(await color(5, 5), 0xabcdef)
assert.equal(await color(0, 0), 0xffffff)

// Ownership: handed on by the owner alone, and the old owner loses every power.
await reverts(() => sim('transferOwnership', [painter.address]), 'not the owner')
await reverts(() => sim('transferOwnership', ['0x0000000000000000000000000000000000000000'], {account: owner}), 'no owner')
const heir = privateKeyToAccount(generatePrivateKey())
await test.setBalance({address: heir.address, value: parseEther('100')})
const tr = await client.waitForTransactionReceipt({hash: await as(owner).writeContract({address, abi, functionName: 'transferOwnership', args: [heir.address], ...fees})})
assert.equal(tr.status, 'success')
assert.equal((await read('owner')).toLowerCase(), heir.address.toLowerCase())
await reverts(() => sim('clear', [], {account: owner}), 'not the owner')
await reverts(() => sim('withdraw', [owner.address], {account: owner}), 'not the owner')
await reverts(() => sim('transferOwnership', [owner.address], {account: owner}), 'not the owner')
await sim('clear', [], {account: heir})
console.log('clear, withdraw and transferOwnership are the owner\'s alone')

// What painting costs in gas, for the page's estimate and the README.
const row = (y, n, rgb) => Array.from({length: n}, (_, x) => ({x, y, rgb}))
const fresh = await paint(row(10, 1000, 0x00ff00).concat(row(11, 1000, 0x00ff00)))
const again = await paint(row(10, 1000, 0x0000ff).concat(row(11, 1000, 0x0000ff)))
const scattered = await paint(Array.from({length: 400}, (_, i) => ({x: (i % 40) * 10, y: 100 + Math.floor(i / 40) * 10, rgb: 0xff00ff})))
const per = (r, n) => `${r.gasUsed} gas, ${Math.round(Number(r.gasUsed) / n)} per pixel, ${formatEther(r.gasUsed * (TIP_WEI + 2_000_000n))} ZNN in fees at the 100 gwei tip`
console.log(`2000 pixels on blank rows:     ${per(fresh, 2000)}`)
console.log(`2000 pixels repainted:         ${per(again, 2000)}`)
console.log(`400 pixels, 400 blank slots:   ${per(scattered, 400)}`)
assert.ok(scattered.gasUsed < 10_000_000n, 'the 400-slot cap leaves headroom under the 16.7M transaction cap')
console.log('all contract checks passed')
