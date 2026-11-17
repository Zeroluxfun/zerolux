# Zero Lux

The site for Zero Lux, an agent factory on Robinhood Chain: one written job in, one working agent out.

**Status: in build.** This repository holds the landing page and the waitlist only. The factory is not open, and $LUX is not launched. There is no contract address. Anything claiming otherwise is not us.

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
