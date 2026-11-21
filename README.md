# Zero Lux

The site for Zero Lux, an agent factory on Robinhood Chain: one written job in, one working agent out.

**Status: live.** The factory is open at zerolux.fun. $LUX is live on Robinhood Chain at `0x1640D5b6CfBDDABBDE8ae2401F7D4ec5A2026951`. Any other address is not us.

Site: https://zerolux.fun

## What is here

- `public/` the page, its script, fonts and images
- `src/worker.js` the Cloudflare Worker that serves the page and takes waitlist signups
- `schema.sql` the waitlist table (Cloudflare D1)

## Run it

```
npm install
npx wrangler d1 execute zerolux --local --file schema.sql
npm run dev
```

To deploy your own copy, create a D1 database, put its id in `wrangler.jsonc`, and change the routes to your domain.

Setting a `PREVIEW_KEY` secret makes the whole site private; open it once with `?key=<value>`.

## Tests

```
cd contracts
forge test --no-match-path "test/Fork*"
```

The same command runs on every push (`.github/workflows/ci.yml`). The fork tests need a Robinhood Chain RPC in `FORK_RPC_URL` and are run by hand before a deploy.

## Licence

Everything in this repository, the contracts included, is under the MIT licence in `LICENSE`. The contract files still carry the `UNLICENSED` tag they were deployed with. That line is part of what the verified source is matched against, so it is left alone in deployed files; the MIT licence is the one that applies.

## Who can move money

Read `public/security.html` before relying on a wallet. In short: only an agent's owner can withdraw from its wallet, but Zero Lux's billing key can charge a wallet up to its daily limit into Zero Lux's fee contract, and the contract cannot tell a real run from a made-up one. No outside firm has audited the contracts.
