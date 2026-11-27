#!/bin/sh
# Switches card payment on. Run it after deploy-tools.sh. Safe to run again.
# It reads the Stripe keys from two files you make yourself (so they never pass through a chat or a command line):
#   ~/.config/zerolux/stripe_key             the Stripe secret key (sk_test_... to try it, sk_live_... for real)
#   ~/.config/zerolux/stripe_webhook_secret  the signing secret of the webhook endpoint (whsec_...), optional at first
# and makes, once, the wallet Zero Lux pays agents from for card-bought runs. Only that wallet's address is printed.
set -e
cd "$(dirname "$0")"
export CLOUDFLARE_ACCOUNT_ID=6cd157ce9109ca2e0c6735747df64590
D="$HOME/.config/zerolux"; mkdir -p "$D"; chmod 700 "$D"
[ -s "$D/stripe_key" ] || { echo "Missing $D/stripe_key. Copy your Stripe secret key, then run:  pbpaste > $D/stripe_key"; exit 1; }
case "$(cat "$D/stripe_key")" in sk_test_*|sk_live_*|rk_test_*|rk_live_*) ;; *) echo "$D/stripe_key does not look like a Stripe secret key."; exit 1;; esac
chmod 600 "$D/stripe_key"
if [ ! -s "$D/card_payer_key" ]; then
  node -e "const{generatePrivateKey}=require('viem/accounts');require('fs').writeFileSync(process.argv[1],generatePrivateKey(),{mode:0o600})" "$D/card_payer_key"
  echo "Made a new wallet for card-bought runs."
fi
chmod 600 "$D/card_payer_key"
tr -d '\n' < "$D/stripe_key" | npx wrangler secret put STRIPE_KEY >/dev/null
tr -d '\n' < "$D/card_payer_key" | npx wrangler secret put CARD_PAYER_KEY >/dev/null
if [ -s "$D/stripe_webhook_secret" ]; then chmod 600 "$D/stripe_webhook_secret"; tr -d '\n' < "$D/stripe_webhook_secret" | npx wrangler secret put STRIPE_WEBHOOK_SECRET >/dev/null; echo "Webhook secret set."; else echo "No webhook secret yet (fine to start; add it before real customers)."; fi
case "$(cat "$D/stripe_key")" in *_test_*) echo "Stripe is in TEST mode: only Stripe's test cards work.";; *) echo "Stripe is LIVE: real cards are charged.";; esac
echo "Card payment is switched on."
echo "Fund this wallet with USDG on Robinhood Chain; card-bought runs are paid from it:"
node -e "const{privateKeyToAccount}=require('viem/accounts');console.log('  '+privateKeyToAccount(require('fs').readFileSync(process.argv[1],'utf8').trim()).address)" "$D/card_payer_key"
