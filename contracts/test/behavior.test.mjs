import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {encodeFunctionData} from 'viem'
import {BATCH_BYTES, BATCH_GAS, decodeOps, encodeOps, gasFor, plan} from '../../src/core/ops.ts'
import {artifacts, fixture, rawPixels, WHITE, ZERO} from './evm.mjs'

function random(seed) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return state >>> 0
  }
}
function packed(model, slot) {
  let value = 0n
  for (let k = 0; k < 10; k++) value |= BigInt((model.get(slot * 10 + k) ?? WHITE) ^ WHITE) << BigInt(k * 24)
  return value
}
function expectedChunk(model, start, count) {
  let out = '0x'
  for (let slot = start; slot < Math.min(start + count, 100_000); slot++) {
    const value = packed(model, slot)
    if (value) out += slot.toString(16).padStart(8, '0') + value.toString(16).padStart(64, '0')
  }
  return out
}
async function checkModel(f, model, {canvas = f.canvas, slots = 15} = {}) {
  assert.equal(await f.read(canvas, 'chunk', [0n, BigInt(slots)]), expectedChunk(model, 0, slots))
  for (const slot of [0, 1, 9, slots - 1]) assert.equal(await f.read(canvas, 'slotAt', [BigInt(slot)]), packed(model, slot))
}
const add = (model, pixels) => { for (const p of pixels) model.set(p.index, p.rgb) }
const paint = (f, pixels, options = {}) => f.write(f.alice, f.canvas, 'paint', [rawPixels(pixels)], f.price * BigInt(pixels.length), options)

test('fresh production compilation matches both saved artifacts and the frontend ABI', () => {
  for (const name of ['Mozaic', 'MozaicRouter']) {
    const saved = JSON.parse(readFileSync(new URL('../' + name + '.json', import.meta.url), 'utf8'))
    assert.deepEqual(artifacts[name], saved, name + ' must be rebuilt after any source or setting change')
  }
  const want = '// Written by scripts/build-contract.mjs from contracts/*.sol. Do not edit.\n\n' +
    `export const MOZAIC_ABI = ${JSON.stringify(artifacts.Mozaic.abi, null, 2)} as const\n\n` +
    `export const ROUTER_ABI = ${JSON.stringify(artifacts.MozaicRouter.abi, null, 2)} as const\n`
  assert.equal(readFileSync(new URL('../../src/core/abi.ts', import.meta.url), 'utf8'), want)
})

test('deployment fixes price and ownership, starts white, and rejects a zero owner', async () => {
  const f = await fixture()
  assert.equal(await f.read(f.canvas, 'price'), f.price)
  assert.equal(await f.read(f.canvas, 'owner'), f.owner)
  assert.equal(await f.read(f.canvas, 'painted'), 0n)
  assert.equal(await f.read(f.canvas, 'epoch'), 0n)
  assert.equal(await f.read(f.canvas, 'WIDTH'), 1000n)
  assert.equal(await f.read(f.canvas, 'HEIGHT'), 1000n)
  assert.equal(await f.read(f.canvas, 'PIXELS_PER_SLOT'), 10n)
  assert.equal(await f.read(f.canvas, 'SLOTS'), 100_000n)
  assert.equal(await f.read(f.canvas, 'pixel', [999n, 999n]), BigInt(WHITE))
  assert.equal(await f.read(f.canvas, 'chunk', [0n, 50n]), '0x')
  assert.equal(await f.read(f.router, 'canvas'), f.canvas)
  assert.equal(await f.read(f.router, 'price'), f.price)
  await f.deploy(artifacts.Mozaic, [1n, ZERO], {error: 'Mozaic: no owner'})
})

test('canvas enforces complete pixels and exact payment with complete rollback', async () => {
  const f = await fixture()
  for (const pixels of ['0x', '0x00', '0x0000000000', '0x000001aabbcc00']) {
    await f.write(f.alice, f.canvas, 'paint', [pixels], f.price, {error: 'Mozaic: 6 bytes per pixel'})
  }
  const px = [{index: 1, rgb: 0x123456}]
  for (const value of [0n, f.price - 1n, f.price + 1n]) {
    await f.write(f.alice, f.canvas, 'paint', [rawPixels(px)], value, {error: 'Mozaic: pay price per pixel'})
  }
  // The first slot is flushed before the later invalid index is encountered.
  await paint(f, [{index: 1, rgb: 0}, {index: 50, rgb: 1}, {index: 1_000_000, rgb: 2}], {error: 'Mozaic: off the canvas'})
  assert.equal(await f.read(f.canvas, 'painted'), 0n)
  assert.equal(await f.balance(f.canvas), 0n)
})

test('packed storage handles boundaries, revisited slots, duplicate indices and white erasure', async () => {
  const f = await fixture(), model = new Map()
  const px = [0, 9, 10, 999, 1000, 999_999, 9, 10, 0].map((index, i) => ({index, rgb: i < 6 ? i * 0x12345 : WHITE}))
  const result = await paint(f, px); add(model, px)
  for (const p of px) assert.equal(await f.read(f.canvas, 'pixel', [BigInt(p.index % 1000), BigInt(Math.floor(p.index / 1000))]), BigInt(model.get(p.index)))
  for (const slot of [0, 1, 99, 100, 99_999]) assert.equal(await f.read(f.canvas, 'slotAt', [BigInt(slot)]), packed(model, slot))
  assert.equal(await f.read(f.canvas, 'chunk', [99_999n, 2n]), expectedChunk(model, 99_999, 2))
  const events = f.events(result)
  assert.equal(events.length, 1)
  assert.equal(events[0].eventName, 'Painted')
  assert.deepEqual(events[0].args, {painter: f.alice, count: BigInt(px.length), pixels: rawPixels(px)})
  assert.equal(await f.read(f.canvas, 'painted'), BigInt(px.length))
  await paint(f, [{index: 999_999, rgb: WHITE}]); model.set(999_999, WHITE)
  assert.equal(await f.read(f.canvas, 'chunk', [99_999n, 2n]), '0x')
})

test('seeded paint traces match an independent slot and sparse-chunk model', async (t) => {
  for (const seed of [1, 7, 42, 0x12345678, 0x9e3779b9, 0xffffffff]) await t.test('seed ' + seed, async () => {
    const f = await fixture(), next = random(seed), model = new Map()
    let painted = 0n, paid = 0n
    const aliceBefore = await f.balance(f.alice)
    for (let round = 0; round < 20; round++) {
      const px = Array.from({length: 1 + next() % 16}, () => ({index: next() % 150, rgb: next() % 5 === 0 ? WHITE : next() & WHITE}))
      if (px.length > 2) px.at(-1).index = px[0].index
      await paint(f, px); add(model, px)
      painted += BigInt(px.length); paid += BigInt(px.length) * f.price
      await checkModel(f, model)
      assert.equal(await f.read(f.canvas, 'painted'), painted)
      assert.equal(await f.balance(f.canvas), paid)
      assert.equal(await f.balance(f.alice), aliceBefore - paid)
    }
  })
})

test('view bounds, sparse windows and arithmetic overflow have explicit behavior', async () => {
  const f = await fixture()
  await paint(f, [{index: 9, rgb: 0x12}, {index: 30, rgb: 0x34}])
  const model = new Map([[9, 0x12], [30, 0x34]])
  for (const [start, count] of [[0, 4], [1, 2], [3, 1], [4, 0], [100_000, 1], [100_001, 3]]) {
    assert.equal(await f.read(f.canvas, 'chunk', [BigInt(start), BigInt(count)]), expectedChunk(model, start, count))
  }
  for (const args of [[1000n, 0n], [0n, 1000n]]) await f.write(f.alice, f.canvas, 'pixel', args, 0n, {isStatic: true, error: 'Mozaic: off the canvas'})
  await f.write(f.alice, f.canvas, 'slotAt', [100_000n], 0n, {isStatic: true, error: null})
  await f.write(f.alice, f.canvas, 'chunk', [(1n << 256n) - 1n, 1n], 0n, {isStatic: true, error: null})
})

test('clearing advances the epoch, preserves revenue and keeps lifetime paint count', async () => {
  const f = await fixture()
  await paint(f, [{index: 0, rgb: 0}, {index: 1, rgb: 1}])
  for (let epoch = 1n; epoch <= 3n; epoch++) {
    const before = await f.balance(f.canvas), count = await f.read(f.canvas, 'painted')
    const result = await f.write(f.owner, f.canvas, 'clear')
    assert.equal(await f.read(f.canvas, 'epoch'), epoch)
    assert.equal(await f.read(f.canvas, 'pixel', [0n, 0n]), BigInt(WHITE))
    assert.equal(await f.read(f.canvas, 'chunk', [0n, 15n]), '0x')
    assert.equal(await f.balance(f.canvas), before)
    assert.equal(await f.read(f.canvas, 'painted'), count)
    assert.deepEqual(f.events(result)[0].args, {epoch})
    await paint(f, [{index: 0, rgb: Number(epoch)}])
  }
  assert.equal(await f.read(f.canvas, 'painted'), 5n)
})

test('only the current owner clears, withdraws and transfers ownership', async () => {
  const f = await fixture()
  for (const [name, args] of [['clear', []], ['withdraw', [f.recipient]], ['transferOwnership', [f.heir]]]) {
    await f.write(f.bob, f.canvas, name, args, 0n, {error: 'Mozaic: not the owner'})
  }
  await f.write(f.owner, f.canvas, 'transferOwnership', [ZERO], 0n, {error: 'Mozaic: no owner'})
  const result = await f.write(f.owner, f.canvas, 'transferOwnership', [f.heir])
  assert.deepEqual(f.events(result)[0].args, {previousOwner: f.owner, newOwner: f.heir})
  assert.equal(await f.read(f.canvas, 'owner'), f.heir)
  await f.write(f.owner, f.canvas, 'clear', [], 0n, {error: 'Mozaic: not the owner'})
  await f.write(f.heir, f.canvas, 'clear')
  assert.equal(await f.read(f.canvas, 'price'), f.price)
})

test('withdrawal transfers exactly the revenue, rejects zero and can be repeated when empty', async () => {
  const f = await fixture()
  await paint(f, [{index: 2, rgb: 3}, {index: 3, rgb: 4}])
  await f.write(f.owner, f.canvas, 'withdraw', [ZERO], 0n, {error: 'Mozaic: no recipient'})
  const before = await f.balance(f.recipient)
  const result = await f.write(f.owner, f.canvas, 'withdraw', [f.recipient])
  assert.equal(await f.balance(f.recipient), before + 2n * f.price)
  assert.equal(await f.balance(f.canvas), 0n)
  assert.deepEqual(f.events(result)[0].args, {to: f.recipient, amount: 2n * f.price})
  await f.write(f.owner, f.canvas, 'withdraw', [f.recipient])
  assert.equal(await f.balance(f.recipient), before + 2n * f.price)
})

test('a rejected withdrawal restores funds and events, then succeeds after recipient recovery', async () => {
  const f = await fixture(), receiver = await f.deploy(artifacts.NativeReceiver)
  await paint(f, [{index: 1, rgb: 1}])
  await f.write(f.owner, f.canvas, 'withdraw', [receiver], 0n, {error: 'Mozaic: transfer failed'})
  assert.equal(await f.balance(f.canvas), f.price)
  await f.write(f.owner, receiver, 'setReject', [false])
  await f.write(f.owner, f.canvas, 'withdraw', [receiver])
  assert.equal(await f.balance(receiver), f.price)
  assert.equal(await f.balance(f.canvas), 0n)
})

test('a zero-price canvas and its router still require complete, in-range paint', async () => {
  const f = await fixture({price: 0n})
  await paint(f, [{index: 5, rgb: 6}])
  await f.write(f.alice, f.router, 'paint', [encodeOps([{index: 6, rgb: 7}])])
  assert.equal(await f.read(f.canvas, 'painted'), 2n)
  assert.equal(await f.balance(f.canvas), 0n)
  await f.write(f.alice, f.router, 'paint', [encodeOps([{index: 7, rgb: 8}])], 1n, {error: 'MozaicRouter: pay price per pixel'})
})

test('seeded frontend encodings expand byte for byte on the actual router', async (t) => {
  const f = await fixture()
  assert.equal(await f.read(f.router, 'expand', ['0x']), '0x')
  for (const seed of [2, 11, 99, 0x1badb002, 0x31415926, 0xfffffffe]) await t.test('seed ' + seed, async () => {
    const next = random(seed)
    for (let trace = 0; trace < 16; trace++) {
      let index = next() % 500, rgb = next() & WHITE
      const px = Array.from({length: 1 + next() % 100}, () => {
        index += 1 + (next() % 8 === 0 ? next() % 7 : 0)
        if (next() % 4 === 0) rgb = next() & WHITE
        return {index, rgb}
      })
      const ops = encodeOps(px)
      assert.deepEqual(decodeOps(ops), px)
      assert.equal(await f.read(f.router, 'expand', [ops]), rawPixels(px))
    }
  })
})

test('router rejects malformed operations and restores complete state', async () => {
  const f = await fixture()
  for (const [ops, error] of [
    ['0x', 'MozaicRouter: nothing to paint'],
    ['0x0100000100', 'MozaicRouter: truncated op'],
    ['0x020000010003aabbcc', 'MozaicRouter: truncated span'],
    ['0x010000010000aabbcc', 'MozaicRouter: empty op'],
    ['0x030000010001aabbcc', 'MozaicRouter: unknown op'],
    ['0x010000010001aabbcc00', 'MozaicRouter: truncated op'],
  ]) await f.write(f.alice, f.router, 'paint', [ops], f.price, {error})
  const ops = encodeOps([{index: 1, rgb: 1}])
  for (const value of [0n, f.price - 1n, f.price + 1n]) await f.write(f.alice, f.router, 'paint', [ops], value, {error: 'MozaicRouter: pay price per pixel'})
})

test('a later canvas failure reverts router events, balances and earlier pixel writes', async () => {
  const f = await fixture()
  const ops = encodeOps([{index: 1, rgb: 1}, {index: 20, rgb: 2}, {index: 999_999, rgb: 3}, {index: 1_000_000, rgb: 4}])
  await f.write(f.alice, f.router, 'paint', [ops], 4n * f.price, {error: 'Mozaic: off the canvas'})
  assert.equal(await f.balance(f.router), 0n)
  assert.equal(await f.balance(f.canvas), 0n)
  assert.equal(await f.read(f.canvas, 'painted'), 0n)
})

test('direct and routed paints produce the same modeled canvas and exact revenue', async () => {
  const f = await fixture(), other = await f.deploy(artifacts.Mozaic, [f.price, f.owner]), model = new Map()
  const next = random(0x5eed1234)
  for (let step = 0; step < 12; step++) {
    const px = [...new Set(Array.from({length: 24}, () => next() % 150))].sort((a, b) => a - b).map((index) => ({index, rgb: next() & WHITE}))
    const value = f.price * BigInt(px.length)
    await f.write(f.alice, other, 'paint', [rawPixels(px)], value)
    await f.write(f.alice, f.router, 'paint', [encodeOps(px)], value)
    add(model, px)
    await checkModel(f, model)
    await checkModel(f, model, {canvas: other})
    assert.equal(await f.read(f.canvas, 'painted'), await f.read(other, 'painted'))
    assert.equal(await f.balance(f.canvas), await f.balance(other))
    assert.equal(await f.balance(f.router), 0n)
  }
})

test('session funding, top-ups, sender attribution and first-funder rules use actual calls', async () => {
  const f = await fixture(), sessionBefore = await f.balance(f.session), aliceBefore = await f.balance(f.alice)
  assert.equal(await f.read(f.router, 'ownerOf', [f.session]), ZERO)
  assert.equal(await f.read(f.router, 'artistOf', [f.session]), f.session)
  const result = await f.write(f.alice, f.router, 'open', [f.session], 1234n)
  assert.equal(await f.balance(f.session), sessionBefore + 1234n)
  assert.equal(await f.balance(f.alice), aliceBefore - 1234n)
  assert.equal(await f.balance(f.router), 0n)
  assert.equal(await f.read(f.router, 'ownerOf', [f.session]), f.alice)
  assert.deepEqual(f.events(result)[0].args, {owner: f.alice, session: f.session, value: 1234n})
  await f.write(f.bob, f.router, 'open', [f.session], 1n, {error: "MozaicRouter: someone else's session"})
  await f.write(f.alice, f.router, 'open', [f.session], 5n)
  assert.equal(await f.balance(f.session), sessionBefore + 1239n)
  const px = [{index: 77, rgb: 0x123456}], ops = encodeOps(px)
  const paid = await f.write(f.session, f.router, 'paint', [ops], f.price)
  const events = f.events(paid)
  assert.deepEqual(events.map((e) => e.eventName), ['PaintedBy', 'Painted'])
  assert.deepEqual(events[0].args, {artist: f.alice, sender: f.session, count: 1n})
  assert.deepEqual(events[1].args, {painter: f.router, count: 1n, pixels: rawPixels(px)})
  assert.equal(await f.balance(f.session), sessionBefore + 1239n - f.price)
  assert.equal(await f.balance(f.canvas), f.price)
})

test('a rejected session transfer rolls back registration and permits a later successful opener', async () => {
  const f = await fixture(), receiver = await f.deploy(artifacts.NativeReceiver)
  await f.write(f.alice, f.router, 'open', [receiver], 123n, {error: 'MozaicRouter: transfer failed'})
  assert.equal(await f.read(f.router, 'ownerOf', [receiver]), ZERO)
  assert.equal(await f.balance(receiver), 0n)
  await f.write(f.owner, receiver, 'setReject', [false])
  await f.write(f.bob, f.router, 'open', [receiver], 456n)
  assert.equal(await f.read(f.router, 'ownerOf', [receiver]), f.bob)
  assert.equal(await f.balance(receiver), 456n)
})

test('batch planning preserves drafts, byte budgets and the declared gas model', async (t) => {
  const next = random(0xabcdef01)
  const cases = [
    ['solid', Array.from({length: 10_000}, (_, index) => ({index, rgb: 0x335577})), () => true],
    ['noise', Array.from({length: 10_000}, (_, index) => ({index, rgb: next() & WHITE})), () => true],
    ['sparse', Array.from({length: 5000}, (_, index) => ({index: index * 17, rgb: index & WHITE})), (slot) => slot % 3 === 0],
  ]
  for (const [name, px, blank] of cases) await t.test(name, async () => {
    const batches = plan(px, blank)
    assert.ok(batches.length > 1)
    assert.deepEqual(batches.flatMap((b) => b.px), px)
    for (const batch of batches) {
      assert.equal(batch.ops, encodeOps(batch.px))
      assert.deepEqual(decodeOps(batch.ops), batch.px)
      assert.ok((batch.ops.length - 2) / 2 <= BATCH_BYTES)
      assert.equal(batch.gas, gasFor(batch.px, blank))
      assert.ok(batch.gas <= BATCH_GAS, 'the encoded batch must remain within its model budget')
    }
  })
})

test('encoder splits a run at the 16-bit count limit without losing pixels', () => {
  const px = Array.from({length: 65_538}, (_, index) => ({index, rgb: 0x123456}))
  assert.deepEqual(decodeOps(encodeOps(px)), px)
})

test('insufficient call gas reverts the whole paint without retaining paid value', async () => {
  const f = await fixture()
  const px = Array.from({length: 40}, (_, index) => ({index, rgb: index + 1}))
  const data = encodeFunctionData({abi: artifacts.Mozaic.abi, functionName: 'paint', args: [rawPixels(px)]})
  await f.frame({from: f.alice, to: f.canvas, data, value: BigInt(px.length) * f.price, gas: 30_000n, error: null})
  assert.equal(await f.balance(f.canvas), 0n)
  assert.equal(await f.read(f.canvas, 'painted'), 0n)
})
