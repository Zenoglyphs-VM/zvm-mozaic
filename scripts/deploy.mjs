// Puts Mozaic on a ZVM chain and writes down where.
//
//   node scripts/deploy.mjs [--rpc URL] [--record deployments/zvm.json]
//                           [--owner 0x…] [--price-wei 100000000000000]
//
// The gas is paid by the devnet deployer (zvm's dev EVM key 900), or by
// DEPLOYER_KEY. That key is public on a devnet, so it is never the owner: the
// owner is --owner, or else a fresh key this script writes to
// secrets/owner-<chainId>.json (git-ignored) and reuses on the next run.
// The owner can withdraw what painting has paid, and nothing else.
//
// Each step checks the chain first, so a deploy that stopped is finished by
// running it again with the same record.

import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import {parseArgs} from 'node:util'
import {createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes, formatEther} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'
import {artifact, TIP_WEI} from './lib.mjs'

const routerArtifact = JSON.parse(readFileSync(new URL('../contracts/MozaicRouter.json', import.meta.url), 'utf8'))

const {values: args} = parseArgs({
  options: {
    rpc: {type: 'string', default: process.env.ZVM_RPC},
    record: {type: 'string', default: 'deployments/zvm.json'},
    owner: {type: 'string'},
    'price-wei': {type: 'string', default: '100000000000000'}, // 0.0001 ZNN
    'no-verify': {type: 'boolean', default: false},
  },
})

const rpc = args.rpc
if (!rpc) throw new Error('pass --rpc, or set ZVM_RPC')
const probe = createPublicClient({transport: http(rpc)})
const chainId = await probe.getChainId()
const chain = defineChain({id: chainId, name: `ZVM ${chainId}`, nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18}, rpcUrls: {default: {http: [rpc]}}})
const client = createPublicClient({chain, transport: http(rpc)})

// zvm's devnet.EVMKey: keccak256("zvm-dev-evm-<i>"). Index 900 is the deployer.
const deployerKey = process.env.DEPLOYER_KEY || keccak256(toBytes('zvm-dev-evm-900'))
const deployer = privateKeyToAccount(deployerKey)
const wallet = createWalletClient({account: deployer, chain, transport: http(rpc)})

const record = existsSync(args.record) ? JSON.parse(readFileSync(args.record, 'utf8')) : {}
if (record.chainId && record.chainId !== chainId) throw new Error(`${args.record} is for chain ${record.chainId}, and ${rpc} is chain ${chainId}`)

function save() {
  mkdirSync(new URL('.', `file:///${process.cwd().replace(/\\/g, '/')}/${args.record}`), {recursive: true})
  writeFileSync(args.record + '.tmp', JSON.stringify(record, null, 2) + '\n')
  renameSync(args.record + '.tmp', args.record)
}

function ownerAddress() {
  if (args.owner) return args.owner
  if (record.owner) return record.owner
  mkdirSync('secrets', {recursive: true})
  const file = `secrets/owner-${chainId}.json`
  if (!existsSync(file)) {
    const privateKey = generatePrivateKey()
    const address = privateKeyToAccount(privateKey).address
    writeFileSync(file, JSON.stringify({address, privateKey, note: 'Mozaic owner: withdraws what painting paid.'}, null, 2) + '\n', {flag: 'wx'})
    console.log(`owner key written to ${file}`)
  }
  return JSON.parse(readFileSync(file, 'utf8')).address
}

const hasCode = async (a) => !!a && ((await client.getCode({address: a})) ?? '0x') !== '0x'

record.chainId = chainId
const owner = ownerAddress()
const price = BigInt(args['price-wei'])
console.log(`chain ${chainId} at ${rpc}`)
console.log(`deployer ${deployer.address}, ${formatEther(await client.getBalance({address: deployer.address}))} ZNN`)

if (!(await hasCode(record.mozaic))) {
  const block = await client.getBlock({blockTag: 'latest'})
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [price, owner],
    maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + TIP_WEI,
    maxPriorityFeePerGas: TIP_WEI,
  })
  console.log(`deploying: ${hash}`)
  const r = await client.waitForTransactionReceipt({hash, pollingInterval: 4000, timeout: 600_000})
  if (r.status !== 'success') throw new Error('the deploy reverted')
  Object.assign(record, {
    mozaic: r.contractAddress,
    owner,
    priceWei: price.toString(),
    deployBlock: Number(r.blockNumber),
    deployTx: hash,
    deployedAt: new Date().toISOString(),
  })
  delete record.verified
  save()
  console.log(`Mozaic at ${r.contractAddress}, block ${r.blockNumber}`)
}

// Read it back: the code is this build's, and the constructor took.
const code = await client.getCode({address: record.mozaic})
const want = artifact.deployedBytecode
// Immutables are zeros in the build and filled in by the constructor.
if (code.length !== want.length || [...want].some((c, i) => i > 1 && c !== code[i] && !zeroRun(want, i))) {
  throw new Error(`the code at ${record.mozaic} is not this build of Mozaic`)
}
const read = (fn) => client.readContract({address: record.mozaic, abi: artifact.abi, functionName: fn})
const [gotPrice, gotOwner] = await Promise.all([read('price'), read('owner')])
if (gotPrice.toString() !== record.priceWei) throw new Error(`price is ${gotPrice}, not ${record.priceWei}`)
if (gotOwner.toLowerCase() !== record.owner.toLowerCase()) throw new Error(`owner is ${gotOwner}, not ${record.owner}`)
console.log(`checked: price ${formatEther(gotPrice)} ZNN per pixel, owner ${gotOwner}`)

// The router in front of it: compact paints, and sessions that paint in their
// funder's name. It holds nothing and owns nothing, so it is deployed from the
// same key with no owner at all.
if (!(await hasCode(record.router))) {
  const block = await client.getBlock({blockTag: 'latest'})
  const hash = await wallet.deployContract({
    abi: routerArtifact.abi,
    bytecode: routerArtifact.bytecode,
    args: [record.mozaic],
    maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + TIP_WEI,
    maxPriorityFeePerGas: TIP_WEI,
  })
  console.log(`deploying the router: ${hash}`)
  const r = await client.waitForTransactionReceipt({hash, pollingInterval: 4000, timeout: 600_000})
  if (r.status !== 'success') throw new Error('the router deploy reverted')
  Object.assign(record, {router: r.contractAddress, routerBlock: Number(r.blockNumber), routerTx: hash})
  delete record.routerVerified
  save()
  console.log(`router at ${r.contractAddress}, block ${r.blockNumber}`)
}
const routerCanvas = await client.readContract({address: record.router, abi: routerArtifact.abi, functionName: 'canvas'})
if (routerCanvas.toLowerCase() !== record.mozaic.toLowerCase()) throw new Error(`the router at ${record.router} fronts ${routerCanvas}, not ${record.mozaic}`)
console.log(`checked: the router fronts ${routerCanvas}`)

// The explorer's verifier, when the RPC is a zvm node's.
const api = /\/rpc$/.test(rpc) ? rpc.replace(/\/rpc$/, '') : null
if (api && !args['no-verify'] && !record.verified) {
  record.verified = await verify(api, record.mozaic, artifact)
  save()
  console.log(`verified: ${record.verified}`)
}
if (api && !args['no-verify'] && !record.routerVerified) {
  record.routerVerified = await verify(api, record.router, routerArtifact)
  save()
  console.log(`router verified: ${record.routerVerified}`)
}
save()
console.log(JSON.stringify(record, null, 2))

/** Whether position i sits inside a run of 64 hex zeros: an immutable's placeholder. */
function zeroRun(hexStr, i) {
  if (hexStr[i] !== '0') return false
  let a = i
  let b = i
  while (a > 2 && hexStr[a - 1] === '0') a--
  while (b < hexStr.length - 1 && hexStr[b + 1] === '0') b++
  return b - a + 1 >= 64
}

async function verify(base, address, artifact) {
  const res = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      address,
      compiler: artifact.compilerVersion,
      contract: `${artifact.sourceName}:${artifact.contractName}`,
      input: artifact.standardJsonInput,
    }),
  })
  let job = await res.json().catch(() => ({}))
  if (!job.id) {
    const msg = `${job.error ?? ''}${job.message ?? ''}`
    if (/already verified/i.test(msg)) return 'already verified'
    throw new Error(`verify: ${res.status} ${msg}`)
  }
  const end = Date.now() + 600_000
  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() > end) throw new Error(`verify job ${job.id} still ${job.status}`)
    await new Promise((r) => setTimeout(r, 3000))
    job = await (await fetch(`${base}/api/verify/${job.id}`)).json()
  }
  if (job.status !== 'verified') throw new Error(`verify: ${job.status}: ${job.message}`)
  return job.match || 'verified'
}
