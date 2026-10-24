# zvm-mozaic

A shared 1000 x 1000 canvas on the ZVM, in the spirit of r/place. Anyone can
paint any pixel any colour for 0.0001 ZNN. A later paint covers an earlier one,
nobody owns a pixel, and there is no cooldown.

Both are verified on the explorer. The owner can withdraw, clear the canvas
and transfer ownership, and nothing else.

- `contracts/`: the canvas and the router
- `src/`: the page, a static bundle
- `scripts/`: the CLI, the deploy, the contract tests and the browser check
- `deployments/`: the record a deploy writes, `zvm.json`, bundled at build
  time; kept out of git, as every devnet deploys its own

The page compiles `@zvm/web` from the [zvm-core](https://github.com/Zenoglyphs-VM/zvm-core)
submodule, so clone with `--recurse-submodules`.

```sh
npm install
cp .env.example .env
npm run contract:build
npm run test:contract
npm run dev        # http://localhost:47700/zvm-mozaic/
npm run verify     # paints for real on chain 69, in headless Chrome
```

No node is built in. `VITE_ZVM_NODE` names the node the page reads (the build
stops without it), `VITE_ZVM_PRESETS` adds more to its picker, and the scripts
read `ZVM_RPC` and `ANVIL_RPC`; `.env.example` has
a local [zvm-devnet](https://github.com/Zenoglyphs-VM/zvm-devnet)'s.

## Isolated contract tests

With Node 22.18 or later, no RPC, wallet or submodule is needed:

```sh
npm ci --ignore-scripts --prefix contracts/test
npm run test:isolated
```

The suite compiles current Solidity in memory, checks saved bytecode and ABI,
and exercises canvas, payment, router encoding and session behavior on an
isolated EVM. CI also rebuilds the contract artifacts and rejects drift. See
[the test scope](contracts/test/README.md) for the model and integration limits.
The existing fork and browser checks remain separate.

## Deploy

Every push to `main` publishes to GitHub Pages (Settings, Pages, Source:
GitHub Actions), built with the organisation's `ZVM_NODE` and `ZVM_GATEWAY`
Actions variables. Add `public/CNAME` to serve from a domain's root.

MIT licence. The full guide, with how it works and why: [docs/GUIDE.md](docs/GUIDE.md).
