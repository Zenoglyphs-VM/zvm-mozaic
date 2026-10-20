// Builds contracts/*.sol into contracts/<Name>.json: the ABI, the bytecode, and
// the standard JSON input that produced them, so the node's verifier is handed
// exactly what was compiled. Each contract is its own compilation unit.
//
// solc 0.8.19 targeting paris is what Bullet Game's and Rain's contracts run on
// the ZVM, so it is the combination known to execute there unchanged.
import {createRequire} from 'node:module'
import {readFileSync, writeFileSync} from 'node:fs'

const require = createRequire(import.meta.url)
const solc = require('solc')

const CONTRACTS = ['Mozaic', 'MozaicRouter']
const abis = {}

for (const name of CONTRACTS) {
  const unit = `${name}.sol`
  const input = {
    language: 'Solidity',
    sources: {[unit]: {content: readFileSync(new URL(`../contracts/${unit}`, import.meta.url), 'utf8')}},
    settings: {
      evmVersion: 'paris',
      libraries: {},
      metadata: {bytecodeHash: 'ipfs'},
      optimizer: {enabled: true, runs: 200},
      remappings: [],
      outputSelection: {'*': {'*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata']}},
    },
  }
  const out = JSON.parse(solc.compile(JSON.stringify(input)))
  for (const e of out.errors ?? []) console.error(e.formattedMessage)
  if ((out.errors ?? []).some((e) => e.severity === 'error')) process.exit(1)
  const c = out.contracts[unit][name]
  const artifact = {
    contractName: name,
    sourceName: unit,
    compiler: solc.version(),
    compilerVersion: 'v0.8.19+commit.7dd6d404',
    abi: c.abi,
    bytecode: '0x' + c.evm.bytecode.object,
    deployedBytecode: '0x' + c.evm.deployedBytecode.object,
    standardJsonInput: input,
  }
  writeFileSync(new URL(`../contracts/${name}.json`, import.meta.url), JSON.stringify(artifact, null, 1) + '\n')
  abis[name] = c.abi
  console.log(`${name}: ${c.evm.bytecode.object.length / 2} bytes creation code, solc ${solc.version()}`)
}

// The page's copy, typed: `as const` is what lets viem check every call.
writeFileSync(
  new URL('../src/core/abi.ts', import.meta.url),
  `// Written by scripts/build-contract.mjs from contracts/*.sol. Do not edit.\n\n` +
    `export const MOZAIC_ABI = ${JSON.stringify(abis.Mozaic, null, 2)} as const\n\n` +
    `export const ROUTER_ABI = ${JSON.stringify(abis.MozaicRouter, null, 2)} as const\n`,
)
