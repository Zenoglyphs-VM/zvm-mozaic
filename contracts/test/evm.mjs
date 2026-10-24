// Current source, fresh compilation, and isolated EVM frames. No RPC or keys.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createCustomCommon, Hardfork, Mainnet} from '@ethereumjs/common'
import {createAccount, createAddressFromString, bytesToHex, hexToBytes} from '@ethereumjs/util'
import {createVM} from '@ethereumjs/vm'
import {decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeDeployData, encodeFunctionData, getAddress} from 'viem'
import solc from 'solc'

export const ZERO = '0x0000000000000000000000000000000000000000'
export const WHITE = 0xffffff
const prefixed = (hex) => hex.startsWith('0x') ? hex : '0x' + hex
assert.match(solc.version(), /^0\.8\.19\+commit\.7dd6d404\./, 'the locked Solidity compiler is required')

// Match scripts/build-contract.mjs: separate units, Paris, optimizer 200, no IR.
export const inputs = {}, artifacts = {}
for (const name of ['Mozaic', 'MozaicRouter', 'Fixtures']) {
  const unit = name + '.sol'
  const input = {
    language: 'Solidity',
    sources: {[unit]: {content: readFileSync(new URL(name === 'Fixtures' ? './Fixtures.sol' : '../' + unit, import.meta.url), 'utf8')}},
    settings: {
      evmVersion: 'paris', libraries: {}, metadata: {bytecodeHash: 'ipfs'},
      optimizer: {enabled: true, runs: 200}, remappings: [],
      outputSelection: {'*': {'*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata']}},
    },
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input)))
  assert.deepEqual((output.errors ?? []).filter((e) => e.severity === 'error'), [], 'fresh compilation must succeed')
  inputs[name] = input
  for (const [contractName, compiled] of Object.entries(output.contracts[unit])) {
    artifacts[contractName] = {
      contractName, sourceName: unit, compiler: solc.version(), compilerVersion: 'v0.8.19+commit.7dd6d404',
      abi: compiled.abi, bytecode: prefixed(compiled.evm.bytecode.object),
      deployedBytecode: prefixed(compiled.evm.deployedBytecode.object), standardJsonInput: input,
    }
  }
}

export const rawPixels = (pixels) => '0x' + pixels.map(({index, rgb}) =>
  index.toString(16).padStart(6, '0') + rgb.toString(16).padStart(6, '0'),
).join('')

export async function fixture({price = 100n} = {}) {
  const common = createCustomCommon({chainId: 7340469}, Mainnet, {hardfork: Hardfork.Paris})
  const vm = await createVM({common})
  const actors = Array.from({length: 6}, (_, n) => '0x' + (0x10000n + BigInt(n)).toString(16).padStart(40, '0'))
  const [owner, alice, bob, session, heir, recipient] = actors
  const address = (value) => createAddressFromString(value)
  for (const actor of actors) await vm.stateManager.putAccount(address(actor), createAccount({balance: 10n ** 30n}))
  const abis = new Map()
  const root = async () => bytesToHex(await vm.stateManager.getStateRoot())
  const balance = async (at) => (await vm.stateManager.getAccount(address(at)))?.balance ?? 0n
  async function frame({from = owner, to, data = '0x', value = 0n, gas = 40_000_000n, isStatic = false, error}) {
    vm.stateManager.originalStorageCache.clear()
    vm.evm.journal.cleanJournal()
    const before = to ? await root() : undefined
    // These are message frames with value transfer/revert handling. Canonical
    // signing, inclusion, intrinsic gas, fee charging and ZVM are not simulated.
    const result = await vm.evm.runCall({caller: address(from), ...(to ? {to: address(to)} : {}),
      data: hexToBytes(data), value, gasLimit: gas, isStatic, skipNonceIncrement: Boolean(to)})
    const returned = bytesToHex(result.execResult.returnValue)
    if (error !== undefined) {
      assert.ok(result.execResult.exceptionError, 'expected EVM failure')
      if (typeof error === 'string') {
        const decoded = decodeErrorResult({abi: [], data: returned})
        assert.equal(decoded.errorName, 'Error')
        assert.equal(decoded.args[0], error)
      }
      if (to) assert.equal(await root(), before, 'reverted calls must restore the complete state root, including balances')
      assert.equal(result.execResult.logs?.length ?? 0, 0, 'reverted calls must retain no events')
    } else assert.equal(result.execResult.exceptionError, undefined, `EVM frame failed: ${returned}`)
    return {...result, returned}
  }
  async function deploy(artifact, args = [], options = {}) {
    const result = await frame({data: encodeDeployData({abi: artifact.abi, bytecode: artifact.bytecode, args}), ...options})
    if (options.error !== undefined) return result
    const at = getAddress(result.createdAddress.toString())
    assert.ok((await vm.stateManager.getCode(address(at))).length > 0)
    abis.set(at.toLowerCase(), artifact.abi)
    return at
  }
  async function write(from, to, functionName, args = [], value = 0n, options = {}) {
    const abi = abis.get(to.toLowerCase())
    assert.ok(abi, 'an explicit fresh ABI is required')
    return frame({from, to, data: encodeFunctionData({abi, functionName, args}), value, ...options})
  }
  async function read(to, functionName, args = []) {
    const abi = abis.get(to.toLowerCase())
    const result = await frame({to, data: encodeFunctionData({abi, functionName, args}), isStatic: true})
    return decodeFunctionResult({abi, functionName, data: result.returned})
  }
  function events(result) {
    return (result.execResult.logs ?? []).map(([at, topics, data]) => {
      const location = bytesToHex(at)
      return {address: location, ...decodeEventLog({abi: abis.get(location.toLowerCase()), topics: topics.map(bytesToHex), data: bytesToHex(data)})}
    })
  }
  const canvas = await deploy(artifacts.Mozaic, [price, owner])
  const router = await deploy(artifacts.MozaicRouter, [canvas])
  return {vm, actors, owner, alice, bob, session, heir, recipient, canvas, router, price, root, balance, frame, deploy, write, read, events}
}
