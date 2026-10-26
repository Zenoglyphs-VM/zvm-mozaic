# Isolated contract behavior

With Node 22.18 or later:

```sh
npm ci --ignore-scripts --prefix contracts/test
npm run test:isolated
```

This small, separately locked toolchain does not install the web application or
fetch its submodule. Missing dependencies and compiler errors fail the suite.
Every run compiles the current Solidity with solc 0.8.19, separate compilation
units, Paris and optimizer 200, matching `scripts/build-contract.mjs`. There is
no fallback to saved bytecode or ABI. The saved contract artifacts, their full
compiler inputs and the frontend ABI must equal the fresh outputs.

The tests run actual EthereumJS message frames in an empty in-memory Paris EVM.
They exercise pixel packing and sparse reads against an independent model,
seeded repaints, payment and balance accounting, rollback, epochs, ownership,
withdrawal failures, frontend/router encoding equivalence, session funding and
attribution, and rejected session transfers. Batch planning is checked against
the declared byte and gas model, including the encoder's 16-bit count limit.

Addresses and account balances are synthetic. No RPC, fork, wallet, private key,
signature or real funds are used. These frames do not qualify canonical
transactions, transaction fees, Prague calldata floors, the ZVM engine, real
deployment settings, browser session storage/recovery or the chain's gas cap.
The gas model checks are not measurements on ZVM. The recipient fixture only
tests controlled transfer rejection and recovery.

The existing `test:contract` and `test:router` commands remain separate fork
integration checks. They require an explicitly selected Anvil RPC and are not
run by this suite or by the isolated CI job.
