// Paying for the draft.
//
// A transaction carries what fits its gas and one NoM block (ops.ts plan):
// about 4,300 fresh pixels, so a whole canvas is two hundred-odd of them, and
// that many wallet prompts is not a thing anyone would sit through. So a draft
// that needs more than one transaction is painted through a paint session: the
// wallet signs one transfer into a key this page makes, the page signs every
// batch with that key, and what is left goes back to the wallet at the end. It
// is the burner-key pattern game front ends use for the same reason.
//
// The wallet funds the session through the router's `open`, which records the
// wallet as the key's owner, so every paint the key signs is credited to the
// wallet in Top painters and under the pointer, not to a stranger's address.
//
// The session's key is written to localStorage before a wei is sent to it, so
// a closed tab or a crash never strands funds: the page finds the key on the
// next visit and offers to send what it holds back. It holds only what one
// paint needs, for as long as that paint takes.
//
// Progress is read cheaply. The session's confirmed nonce, one request every
// four seconds, says how many batches have executed; each executed batch's
// receipt is then read once, to know it did not revert. A batch that reverts
// goes back into the draft.

import {reactive, watch} from 'vue'
import {createWalletClient, encodeFunctionData, http, type Address, type Hash, type Hex} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'
import {MOZAIC_ABI, ROUTER_ABI} from './abi'
import {board, slotBlank} from './board'
import {DIRECT_MAX_PIXELS, encodePixels, MAX_TX_GAS, type Px} from './codec'
import {plan} from './ops'
import {endpoint} from './endpoint'
import {wallet} from './wallet'
import {chain} from './chain'
import {estimateFees, publicClient, walletClient, zvmChain, TIP_WEI} from '@zvm/web/evm'
import {forgetHistory, markExecuted, markFailed, markSent, outgoing} from './draft'
import {reason, record, type Step} from './tx'
import {toast} from './toast'
import {units} from './format'

/** Batches a session keeps unexecuted at once: a momentum's worth and more, few enough to stop promptly. */
const WINDOW = 24
const POLL_MS = 4000
const SEND_GAS = 21_000n

export interface Quote {
  pixels: number
  txs: number
  paint: bigint
  fee: bigint
  /** What a session is funded with: paint, plus fees at their ceiling, plus the return transfer. */
  fund: bigint
}

const cap = (g: bigint) => (g < MAX_TX_GAS ? g : MAX_TX_GAS)

/**
 * What a transaction declares: the estimate and a tenth. The relayer budgets
 * each momentum by *declared* gas, so the 1.3x this used to send spent a
 * quarter of the momentum's room on gas no paint ever used.
 */
const declare = (est: bigint) => cap((est * 11n) / 10n)

interface Planned {
  px: Px[]
  to: Address
  /** The call: the router's ops, or the canvas's six-byte form without one. */
  data: Hex
  gas: bigint
}

/**
 * The draft cut into transactions. Through the router each carries compact
 * ops; a canvas with no router is painted directly, in its six-byte form,
 * which is twice the bytes, so a planned batch goes in pieces of 2,000.
 */
function batchesFor(list: Px[]): Planned[] {
  const router = endpoint.router
  const canvas = endpoint.contract as Address
  const out: Planned[] = []
  for (const b of plan(list, slotBlank)) {
    if (router) {
      out.push({px: b.px, to: router, data: encodeFunctionData({abi: ROUTER_ABI, functionName: 'paint', args: [b.ops as Hex]}), gas: b.gas})
      continue
    }
    for (let i = 0; i < b.px.length; i += DIRECT_MAX_PIXELS) {
      const px = b.px.slice(i, i + DIRECT_MAX_PIXELS)
      out.push({
        px,
        to: canvas,
        data: encodeFunctionData({abi: MOZAIC_ABI, functionName: 'paint', args: [encodePixels(px)]}),
        gas: (b.gas * BigInt(px.length)) / BigInt(b.px.length),
      })
    }
  }
  return out
}

/**
 * Paint cost and a fee estimate for the current draft, in wei. No request: the
 * base fee is the one chain.ts read with the last block, and the gas is the
 * measured model in ops.ts, which knows from the canvas which slots are blank.
 */
export function quote(): Quote {
  const list = outgoing()
  const groups = batchesFor(list)
  const price = endpoint.canvas?.price ?? 0n
  const perGas = (chain.baseFee ?? 0n) + TIP_WEI
  const maxFee = (chain.baseFee ?? 0n) * 2n + TIP_WEI
  let gas = 0n
  let ceiling = 0n
  for (const g of groups) {
    gas += g.gas
    ceiling += cap((g.gas * 12n) / 10n)
  }
  const paint = price * BigInt(list.length)
  return {pixels: list.length, txs: groups.length, paint, fee: gas * perGas, fund: paint + ceiling * maxFee + SEND_GAS * maxFee}
}

export const submission = reactive({
  running: false,
  mode: null as 'wallet' | 'session' | null,
  steps: [] as Step[],
  batches: 0,
  sent: 0,
  executed: 0,
  failed: 0,
  pixels: 0,
  pixelsDone: 0,
  stopping: false,
  error: '',
  /** A session key from an earlier visit that still holds ZNN. */
  leftover: null as {address: Address; balance: bigint} | null,
})

// --- the session key ---------------------------------------------------------------

interface Saved {
  key: Hex
  /** The wallet that funded it, and where what is left goes by default. */
  owner: Address
}

const sessionKey = () => (endpoint.chainId ? `mozaic.session.${endpoint.chainId}` : null)

function loadSession(): Saved | null {
  const k = sessionKey()
  if (!k) return null
  try {
    const s = JSON.parse(localStorage.getItem(k) ?? 'null')
    return s?.key ? s : null
  } catch {
    return null
  }
}

function saveSession(s: Saved | null) {
  const k = sessionKey()
  if (!k) return
  if (s) localStorage.setItem(k, JSON.stringify(s))
  else localStorage.removeItem(k)
}

function sessionSigner(key: Hex) {
  const account = privateKeyToAccount(key)
  return createWalletClient({account, chain: zvmChain(endpoint.chainId!), transport: http(endpoint.rpc)})
}

/** Looks for ZNN left in a session key, on load and after each paint. */
export async function checkLeftover() {
  const s = loadSession()
  if (!s || endpoint.chainId === null) return (submission.leftover = null)
  const address = privateKeyToAccount(s.key).address
  try {
    const balance = await publicClient(endpoint.chainId).getBalance({address})
    const {maxFeePerGas} = await estimateFees(endpoint.chainId)
    if (balance <= SEND_GAS * maxFeePerGas) {
      // Nothing worth sending back: forget the key.
      if (!submission.running) saveSession(null)
      submission.leftover = null
    } else submission.leftover = {address, balance}
  } catch {
    /* checked again on the next visit */
  }
}

watch(
  () => [board.status, wallet.address] as const,
  ([s]) => s === 'ready' && checkLeftover(),
)

/** Sends everything a session key holds, less the transfer's own fee, to `to`. */
export async function returnLeftover(to: Address | null = wallet.address): Promise<bigint> {
  const s = loadSession()
  const chainId = endpoint.chainId
  if (!s || chainId === null) return 0n
  const target = to ?? s.owner
  const signer = sessionSigner(s.key)
  const client = publicClient(chainId)
  const address = signer.account.address
  // Wait out anything of the session's still in flight: its nonce must be free.
  for (let end = Date.now() + 120_000; ; ) {
    const [latest, pendingN] = await Promise.all([
      client.getTransactionCount({address, blockTag: 'latest'}),
      client.getTransactionCount({address, blockTag: 'pending'}),
    ])
    if (latest >= pendingN || Date.now() > end) break
    await sleep(POLL_MS)
  }
  const balance = await client.getBalance({address})
  const fees = await estimateFees(chainId)
  const value = balance - SEND_GAS * fees.maxFeePerGas
  if (value <= 0n) {
    saveSession(null)
    submission.leftover = null
    return 0n
  }
  const hash = await signer.sendTransaction({to: target, value, gas: SEND_GAS, ...fees})
  const r = await client.waitForTransactionReceipt({hash, pollingInterval: POLL_MS, timeout: 600_000})
  if (r.status === 'success') {
    // What the fee did not use is still there; it is dust, and forgotten.
    saveSession(null)
    submission.leftover = null
  }
  return value
}

// --- painting -------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function stop() {
  if (submission.running) submission.stopping = true
}

/** Paints the draft: through the wallet for one transaction, through a session for more. */
export async function submitDraft(opts: {signEach?: boolean} = {}): Promise<void> {
  const chainId = endpoint.chainId
  const contract = endpoint.contract as Address | null
  const price = endpoint.canvas?.price
  if (chainId === null || !contract || price === undefined) throw new Error('No canvas connected.')
  if (!wallet.address || !wallet.provider) throw new Error('Connect a wallet first.')
  if (submission.running) return
  const list = outgoing()
  if (!list.length) return
  const groups = batchesFor(list)
  Object.assign(submission, {
    running: true,
    stopping: false,
    error: '',
    steps: [],
    batches: groups.length,
    sent: 0,
    executed: 0,
    failed: 0,
    pixels: list.length,
    pixelsDone: 0,
    mode: groups.length === 1 || opts.signEach ? 'wallet' : 'session',
  })
  forgetHistory()
  try {
    if (submission.mode === 'wallet') await viaWallet(groups, price, chainId)
    else await viaSession(groups, price, chainId)
  } catch (err) {
    submission.error = reason(err)
  } finally {
    submission.running = false
    submission.stopping = false
  }
  const {executed, batches: n, pixelsDone} = submission
  if (executed === n) toast(`Painted. ${pixelsDone.toLocaleString()} pixels are on the canvas.`, 'good')
  else if (executed) toast(`${executed} of ${n} batches executed. The rest are back in your draft.`, 'bad')
}

/** One wallet prompt per batch, each sent without waiting for the one before. */
async function viaWallet(groups: Planned[], price: bigint, chainId: number) {
  const client = publicClient(chainId)
  const signer = walletClient(wallet.provider, chainId, wallet.address!)
  const from = wallet.address!
  const steps: Step[] = groups.map((g, i) => ({
    label: groups.length > 1 ? `Paint ${g.px.length.toLocaleString()} pixels (${i + 1} of ${groups.length})` : `Paint ${g.px.length.toLocaleString()} pixels`,
    state: 'queued',
  }))
  const emit = () => (submission.steps = steps.map((s) => ({...s})))
  emit()
  const waits: Promise<void>[] = []
  for (const [k, g] of groups.entries()) {
    if (submission.stopping) break
    const step = steps[k]
    try {
      step.state = 'signing'
      emit()
      const value = price * BigInt(g.px.length)
      const [est, fees] = await Promise.all([client.estimateGas({account: from, to: g.to, data: g.data, value}), estimateFees(chainId)])
      const hash: Hash = await signer.sendTransaction({to: g.to, data: g.data, value, gas: declare(est), ...fees})
      step.hash = hash
      step.state = 'ordered'
      submission.sent++
      emit()
      record({hash, label: step.label, chainId, at: Date.now(), state: 'ordered'})
      markSent(g.px)
      waits.push(
        client
          .waitForTransactionReceipt({hash, pollingInterval: POLL_MS, timeout: 600_000})
          .then((r) => {
            if (r.status !== 'success') throw new Error('The ZVM reverted this paint.')
            step.state = 'done'
            submission.executed++
            submission.pixelsDone += g.px.length
            record({hash, label: step.label, chainId, at: Date.now(), state: 'done'})
            markExecuted(Number(r.blockNumber), g.px)
          })
          .catch((err) => {
            step.state = 'failed'
            step.detail = reason(err)
            submission.failed++
            record({hash, label: step.label, chainId, at: Date.now(), state: 'failed'})
            markFailed(g.px)
          })
          .finally(emit),
      )
    } catch (err) {
      step.state = 'failed'
      step.detail = reason(err)
      for (const rest of steps.slice(k + 1)) rest.detail = 'Not sent. These pixels are still in your draft.'
      emit()
      break
    }
  }
  await Promise.all(waits)
}

/** One wallet prompt, then every batch signed here by the session key. */
async function viaSession(groups: Planned[], price: bigint, chainId: number) {
  const client = publicClient(chainId)
  const owner = wallet.address!
  const steps: Step[] = [
    {label: 'Fund the paint session', state: 'queued'},
    {label: `Paint ${submission.pixels.toLocaleString()} pixels in ${groups.length} batches`, state: 'queued'},
    {label: 'Return what is left to your wallet', state: 'queued'},
  ]
  const emit = () => (submission.steps = steps.map((s) => ({...s})))
  emit()

  // The key first, saved before anything is sent to it.
  let saved = loadSession()
  if (!saved) {
    saved = {key: generatePrivateKey(), owner}
    saveSession(saved)
  }
  const signer = sessionSigner(saved.key)
  const address = signer.account.address

  // What the paint needs, less what the session already holds (a stopped
  // session keeps its funds until it is used again or returned).
  const fees = await estimateFees(chainId)
  let need = SEND_GAS * fees.maxFeePerGas
  for (const g of groups) need += price * BigInt(g.px.length) + cap((g.gas * 12n) / 10n) * fees.maxFeePerGas
  const have = await client.getBalance({address})
  steps[0].state = 'signing'
  emit()
  if (have < need) {
    // Through the router when there is one, so the paints are credited to this
    // wallet; a plain transfer otherwise.
    const funder = walletClient(wallet.provider, chainId, owner)
    const router = endpoint.router
    const hash = router
      ? await funder.writeContract({address: router, abi: ROUTER_ABI, functionName: 'open', args: [address], value: need - have, gas: 120_000n, ...fees})
      : await funder.sendTransaction({to: address, value: need - have, gas: SEND_GAS, ...fees})
    steps[0].hash = hash
    steps[0].state = 'ordered'
    steps[0].detail = `${units(need - have, 18, 4)} ZNN into the session. Whatever is not spent comes back.`
    emit()
    record({hash, label: 'Fund a paint session', chainId, at: Date.now(), state: 'ordered'})
    const r = await client.waitForTransactionReceipt({hash, pollingInterval: POLL_MS, timeout: 600_000})
    if (r.status !== 'success') throw new Error('The funding transfer failed.')
    record({hash, label: 'Fund a paint session', chainId, at: Date.now(), state: 'done'})
  } else steps[0].detail = 'The session already held enough.'
  steps[0].state = 'done'
  steps[1].state = 'ordered'
  emit()

  // Batches, a window of them unexecuted at a time.
  interface Out {
    g: Planned
    hash: Hash
    nonce: number
    settled: boolean
  }
  const out: Out[] = []
  let nonce = await client.getTransactionCount({address, blockTag: 'pending'})
  let sendError: unknown = null

  const settle = async () => {
    const confirmed = await client.getTransactionCount({address, blockTag: 'latest'})
    for (const o of out) {
      if (o.settled || o.nonce >= confirmed) continue
      o.settled = true
      try {
        const r = await client.getTransactionReceipt({hash: o.hash})
        if (r.status === 'success') {
          submission.executed++
          submission.pixelsDone += o.g.px.length
          markExecuted(Number(r.blockNumber), o.g.px)
        } else {
          submission.failed++
          markFailed(o.g.px)
        }
      } catch {
        o.settled = false
      }
    }
  }

  for (const g of groups) {
    if (submission.stopping) break
    while (out.filter((o) => !o.settled).length >= WINDOW && !submission.stopping) {
      await sleep(POLL_MS)
      await settle()
    }
    if (submission.stopping) break
    try {
      const value = price * BigInt(g.px.length)
      const est = await client.estimateGas({account: address, to: g.to, data: g.data, value})
      const f = await estimateFees(chainId)
      const hash = await signer.sendTransaction({to: g.to, data: g.data, value, gas: declare(est), nonce, ...f})
      out.push({g, hash, nonce, settled: false})
      nonce++
      submission.sent++
      markSent(g.px)
    } catch (err) {
      sendError = err
      break
    }
  }
  // Everything sent is waited for, stopped or not: it was paid for.
  for (let end = Date.now() + 900_000; out.some((o) => !o.settled) && Date.now() < end; ) {
    await sleep(POLL_MS)
    await settle()
  }
  steps[1].state = submission.executed === groups.length ? 'done' : 'failed'
  steps[1].detail = `${submission.executed} of ${groups.length} batches executed${submission.failed ? `, ${submission.failed} reverted` : ''}${
    sendError ? `. Stopped: ${reason(sendError)}` : submission.stopping ? '. Stopped.' : ''
  }`
  steps[2].state = 'signing'
  emit()

  try {
    const back = await returnLeftover(owner)
    steps[2].state = 'done'
    steps[2].detail = back > 0n ? `${units(back, 18, 4)} ZNN returned.` : 'Nothing was left.'
  } catch (err) {
    steps[2].state = 'failed'
    steps[2].detail = `${reason(err)} The page will offer to return it again.`
    await checkLeftover()
  }
  emit()
}
