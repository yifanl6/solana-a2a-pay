# solana-a2a-pay

Three AI-style agents pay each other per HTTP request on Solana, using an [x402](https://x402.org)-style `402 Payment Required` flow with a test stablecoin.

```
orchestrator ──$0.02/call──▶ analyst-agent ──$0.005/call──▶ data-agent ──▶ Solana RPC
 (buyer, hard budget)        (seller AND buyer)             (seller)
```

The analyst is the interesting node. It earns from the orchestrator and spends on the data agent within the same request. It also returns the upstream payment signature as **provenance**, and the orchestrator checks on-chain that the data agent really received $0.005 in that transaction.

## The flow (x402 "exact" scheme)

1. The client calls `GET /risk/:address`. The server replies `402` with the price, token mint, `payTo`, `feePayer`, and a single-use nonce.
2. The client checks its **spend policy**: token, per-call cap, total budget, and payee allow-list. It then builds a `TransferChecked + Memo(nonce)` transaction, signs **only as token owner**, and retries with an `X-PAYMENT` header.
3. The server verifies the transaction instruction by instruction and burns the nonce. It then co-signs as fee payer (so buyers need no SOL), submits, waits for `confirmed`, and serves the response with an `X-PAYMENT-RESPONSE` receipt.

## Run it (local validator, about 2 minutes)

Install the Solana CLI (Agave): `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`, then:

```bash
npm install
solana-test-validator --reset          # terminal 1
npm run setup                          # wallets, SOL, test stablecoin, token accounts
npm run demo                           # starts both agents, runs orchestrator + attack suite
```

Or run each piece in its own terminal, which works better for a live demo:

```bash
npm run data-agent                     # terminal 2
npm run analyst-agent                  # terminal 3
npm run orchestrator                   # terminal 4 (or: npm run orchestrator -- <address> ...)
npm run attack                         # adversarial checks against the data agent
```

If you restart the validator with `--reset`, run `npm run setup` again. It keeps the wallets and recreates the mint.

**Devnet:** `RPC_URL=https://api.devnet.solana.com NETWORK=solana-devnet npm run setup`. Pass the same env vars to every other command. Faucet airdrops are rate-limited, so if setup fails, top up the printed address at [faucet.solana.com](https://faucet.solana.com) and re-run it. Wallets are stored per network under `.wallets/<network>/`.

**Expected orchestrator output:** two paid reports, each with provenance verified on-chain. The third call is then refused by the orchestrator's own budget policy ($0.05 budget, $0.02 per call), and the on-chain balance change matches the tracked spend:

```
▶ risk report for 693tZNaD…
  paid $0.0200  tx 4xyw6YnS…  (1212 ms)
  score 40/100 (medium)
    +25  new-account: first activity under an hour ago
    +15  low-activity: 3 transactions on record
  provenance: data agent received $0.0050 in 2qWb92PC… ✓ verified on-chain
  budget left $0.0300
...
▶ risk report for 44G247Sm…
  ⛔ refused by spend policy: price 20000 exceeds remaining budget 10000 (spent 40000 of 50000)

tracked spend $0.0400 across 2 payments
on-chain balance change $0.0400 ✓ matches
```

## Layout

| File | Role |
|---|---|
| `src/x402/verify.ts` | Pure verifier for buyer-signed payment transactions (the security boundary) |
| `src/x402/server.ts` | Express paywall middleware: quote → verify → burn nonce → co-sign → settle → serve |
| `src/x402/client.ts` | Paying HTTP client with a hard spend policy |
| `src/x402/nonce.ts` | Single-use nonces bound to resource and price |
| `src/agents/*.ts` | data agent, analyst agent (seller + buyer), orchestrator, toy risk heuristic |
| `src/scripts/attack.ts` | 15 adversarial checks against a live seller |

Each agent describes its offers at `GET /` (`curl localhost:4002/`).

## Security model

The seller signs as fee payer, which makes it a target. `src/x402/verify.ts` rejects:

| Attack | Defense |
|---|---|
| Drain the fee payer (SOL transfer out of it, or a token transfer from the seller) | The facilitator key may appear only as fee payer, never inside an instruction |
| Priority-fee or compute griefing | Caps on compute-unit price (5,000 µlamports) and limit (100k CU) |
| Fee inflation via extra signers | Exactly two signers: fee payer + token owner |
| Underpay, wrong token, wrong decimals, wrong recipient | Exact amount, mint, decimals, and recipient ATA |
| Replay, or reusing a quote on another resource | Single-use nonce in a Memo, burned before submission, bound to resource and price |
| Smuggled instructions | Program allow-list (ComputeBudget, Token, Memo), and only `TransferChecked` on Token |

`npm run attack` exercises all of these against a live agent and then checks the seller's balances. The only change should be one honest payment: **-10,001 lamports, +5,000 token units**.

The buyer side is defended too. `X402Client` checks the payee allow-list, per-call cap, and remaining budget **before signing**, and it reserves budget so concurrent calls can't overspend.

## Economics (the part people skip)

Settlement costs the seller 10,000 lamports for the two signatures (payer + fee payer), plus a 1-lamport priority fee. At $150/SOL that is about **$0.0015 per payment**:

| Price per call | Fee as share of revenue |
|---|---|
| $0.02 | ~7.5% |
| $0.005 | ~30% |
| $0.002 | ~75% |
| $0.001 | ~150% (loses money) |

Per-call on-chain settlement stops making sense below about half a cent. Under that, you need batching (see Next steps).

## Known limitations (deliberate, for clarity)

- **Pay-then-fail:** if the analyst's upstream call fails after the customer paid, it returns `502` and logs "refund owed". There is no automated refund yet.
- **Latency:** each paid call waits for `confirmed`. Locally that is about 1s end to end for a two-hop request; it takes longer on devnet.
- **In-memory nonces:** fine for one process. Use Redis for multiple instances.
- **Not certified x402-compatible:** wire shapes follow x402 v1, but the facilitator logic is self-hosted. Swap in `@x402/*` or a hosted facilitator to interoperate with other agents.
- **The risk score is a transparent toy heuristic, not a model.** Every point is traceable to a listed factor.

## Next steps

- **Batched settlement:** sign cumulative IOUs off-chain, and settle every N calls or every $X.
- **Refund path:** the seller refunds automatically when it can't deliver after settlement.
- **Discovery:** publish offers (`GET /`) in a registry so agents can find and compare sellers.
- **Any-token payments:** accept any SPL token, swap via Jupiter, and settle exact USDC to the seller.
