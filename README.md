# Oorka

**A Uniswap v4 hook where the right to manage a vault's liquidity is contested on-chain.**

Anyone can challenge the vault's curator. Challengers don't need capital to prove themselves: the hook drops a dust-sized "probe" position at their declared range. That makes the PoolManager track fee growth at those exact ticks, so the hook can compute what the range *would have* earned with real swap data. A challenger who beats the seat holder for enough epochs in a row takes over, and the vault's real liquidity moves to their range automatically.

Built for the UHI11 Hookathon theme, **Active Management & Curation**. It hits three of the four listed directions in one system: curated LP networks, backtesting (forward-testing, really), and strategy migration.

![Takeover](docs/takeover.png)

## Live deployment (Unichain Sepolia + Reactive Lasna)

| Contract | Address |
|---|---|
| OorkaHook (hook + vault + curator registry) | [`0x86486253aC2C85CffaA711d297c64AF4eAb050A0`](https://sepolia.uniscan.xyz/address/0x86486253aC2C85CffaA711d297c64AF4eAb050A0) |
| OorkaKeeper (Reactive callback, settles epochs) | [`0xe2816a99acc021bbe019214f96dac78e648f1509`](https://sepolia.uniscan.xyz/address/0xe2816a99acc021bbe019214f96dac78e648f1509) |
| OorkaReactive (CRON subscriber, on Reactive Lasna) | [`0x086143eb1a65bdf2754f0b9190f85de6b638cb52`](https://lasna.reactscan.net/address/0x086143eb1a65bdf2754f0b9190f85de6b638cb52) |
| Uniswap v4 PoolManager (Unichain Sepolia) | [`0x00b036b58a818b1bc34d502d3fe730db729e62ac`](https://sepolia.uniscan.xyz/address/0x00b036b58a818b1bc34d502d3fe730db729e62ac) |
| tETH / tUSD test tokens | [`0x5387…a26b`](https://sepolia.uniscan.xyz/address/0x5387EeaE799738A34C982E705804Dfa95FDda26b) / [`0xaC15…0a6C`](https://sepolia.uniscan.xyz/address/0xaC150B417a0b1c76353Cf647A9434fBE49250a6C) |

The pool is tETH/tUSD at about 3,000. It is seeded with three curators (Passive Pam holds the seat, Tight Tony, Mid Mia), the benchmark and a vault deposit. Epochs last 10 minutes, and the Reactive CRON contract pokes the keeper about every 12 minutes. All addresses are in [`frontend/public/deployments.1301.json`](frontend/public/deployments.1301.json).

Run the dashboard against it with any browser wallet. Test tokens are minted from the app.

```bash
cd frontend && npm install && npx vite --mode unichain
```

---

## The problem

Curated LP vaults ask depositors to trust a manager. Today you pick one based on their marketing, or a backtest they ran themselves on data they chose. Nothing on-chain says "this manager is actually better than the alternatives right now", and nothing replaces a bad manager without governance drama.

## The idea

Make the curator seat a competition that settles itself:

1. **The seat holder** runs the vault. Their range is where depositors' liquidity actually sits.
2. **Challengers** post a bond and declare a range. They get a **paper portfolio** of 1,000 tUSD notional at that range.
3. **The probe trick.** v4 only tracks `feeGrowthInside` for ticks that have liquidity. So the hook adds `1e9` units of dust liquidity at every declared range. Now `StateLibrary.getFeeGrowthInside` returns real fee growth for that range, and the hook can credit each paper portfolio exactly what that range earned per unit of liquidity, plus the real price exposure of holding it. No oracle, no off-chain backtest, no trust.
4. **Epochs.** At each epoch end anyone can call `settleEpoch()`. Every paper portfolio is marked to market. A challenger whose epoch return beats the seat holder's by `marginBps` gets a win. `winStreak` wins in a row and they take the seat.
5. **Migration.** On takeover, the hook pulls the vault's liquidity and redeploys it at the winner's range in the same transaction. The old seat holder loses `slashBps` of their bond, which goes straight to depositors.

The seat holder is scored the same way as everyone else (its own paper portfolio), so the race is apples to apples.

## Why it's hard to game

| Attack | Defense |
|---|---|
| Flash-swap the price to inflate your paper NAV right before settling | All accounting uses the **block-open price**, snapshotted in `beforeSwap` on the first swap of each block. An in-block price push doesn't move it. |
| Sandwich your own vault while rebalancing, or deposit/withdraw at a pushed price | Vault-moving actions revert if spot is more than `maxTickDeviation` ticks from the block-open price. |
| Declare a range after you've seen where the price went | Ranges only accrue from the moment they're declared. There's no way to backdate one. |
| Flip ranges every block to chase fees | Every range change charges `switchCostBps` on the paper portfolio, a proxy for real swap costs. |
| Join late in an epoch with a lucky streak | A challenger must be present for the **whole** epoch to be eligible. |
| Spam the leaderboard | Bond required, max 8 curators. |
| Carry wins earned against the old seat holder into the new reign | All streaks reset on takeover. |
| Pump a range's score with `donate()`, which adds fee growth without any swap | The hook claims `beforeDonate` and reverts every donation to its pool (`DonationsDisabled`). |
| Push the price at the end of block N, then call `settleEpoch()` first thing in block N+1 | Settlement scores at the epoch's **time-weighted average of block-open ticks** (`settleSqrtPrice()`), built inside the hook from `beforeSwap`. A push that held for a few seconds barely moves a 10-minute or 1-hour average. |

Known limitation, said out loud:

- **Wash trading.** A curator could wash-trade to inflate fee growth at their range. Unlike a donation, it costs them the swap fee plus price impact, and the fees go to *real* liquidity in that range. Any range overlapping theirs benefits too. A production version would cap per-epoch fee credit or weight fees by unique swappers.

## What the demo shows

Hit **Trade in a range** a few times and the tight curator out-earns the wide one on fees. Settle three epochs and you'll watch the seat change hands and the vault bar slide to the new range. Then hit **Pump tETH**: the price walks out of the tight range, it goes hatched (earning nothing), and the wide-range curator leads the next epoch. The market regime decides who should manage, and the hook figures it out by itself.

The grey lane is the **benchmark**: the same 1,000 tUSD paper portfolio, parked on a fixed wide range that never moves and can never take the seat. Every settlement emits `BenchmarkScored` with the vault's real return next to the benchmark's, and the Vault panel shows both since the start and for the current epoch. That answers the depositor's question directly: is the contested seat beating doing nothing?

![Pump](docs/pump.png)

## Keeper-free settlement (Reactive Network)

`settleEpoch()` is permissionless, but someone still has to call it. `src/reactive/` removes that someone:

- **`OorkaReactive`** runs on Reactive Network. It subscribes to one of Reactive's built-in CRON events and, every `ticksPerPoke` ticks, emits a callback to the hook's chain.
- **`OorkaKeeper`** runs on the hook's chain. It only accepts callbacks from the Reactive callback proxy *and* from our own reactive contract's RVM id. If the epoch is over it settles it, otherwise it emits `Idle`. A failed settle is reported (`SettleFailed`) and retried on the next tick, so it can't block the schedule.

The keeper has no special rights on the hook. All it adds is liveness: the seat changes hands on time even when nobody is watching. A takeover settle uses under 1.5M gas, half the 3M callback budget (checked in the tests).

Deploy (Unichain Sepolia + Reactive Lasna), from the **same** EOA so the RVM id matches:

```bash
cd contracts
# 1. keeper on the hook's chain, with Unichain Sepolia's Reactive callback proxy, funded for callback fees
forge create src/reactive/OorkaKeeper.sol:OorkaKeeper --broadcast \
  --rpc-url https://sepolia.unichain.org --private-key $PRIVATE_KEY --value 0.01ether \
  --constructor-args 0x775c9B990ADe401060B78D0e98684eEf8d2466C1 $HOOK false

# 2. reactive contract on Lasna: Cron100 (~12 min), poke every tick, destination chain 1301
forge create src/reactive/OorkaReactive.sol:OorkaReactive --broadcast \
  --rpc-url https://lasna-rpc.rnk.dev/ --private-key $PRIVATE_KEY --value 0.1ether \
  --constructor-args 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70 1301 $KEEPER 1
```

Callback proxy addresses and CRON topics come from the [Reactive docs](https://dev.reactive.network/origins-and-destinations). Check them before deploying.

---

## Run it

Needs [Foundry](https://book.getfoundry.sh/getting-started/installation) and Node 18+.

```bash
./demo.sh
```

Then open http://localhost:5173. That one command:

1. starts a local anvil chain
2. deploys a PoolManager, tETH/tUSD test tokens, swap and LP routers, and the hook at a flag-mined CREATE2 address
3. creates a tETH/tUSD pool at about 3,000 with deep background liquidity
4. seeds three curators (Passive Pam ±40% holds the seat, Tight Tony ±3%, Mid Mia ±10%), a fixed wide-range benchmark and a vault deposit
5. starts the frontend

**On Windows:** run `./demo.sh` from WSL (Ubuntu) with Foundry and Node installed there. Or split it: run `anvil --host 0.0.0.0` and the deploy steps from `demo.sh` inside WSL, then start the frontend from Windows with `cd frontend && npm install && npx vite`. WSL forwards `127.0.0.1:8545` to Windows, so the frontend reaches anvil. The frontend reads the RPC URL from `VITE_RPC_URL` (default `http://127.0.0.1:8545`).

The frontend signs with anvil's dev keys, so there's no wallet popup. Use **Acting as** to switch between the depositor, fresh challenger wallets and the seeded curators.

### Tests

```bash
cd contracts
forge test
```

31 tests, covering:
- the probe measuring fees
- a takeover after the streak
- slashing going to depositors
- a trending market favouring the wide range
- in-block manipulation being ignored
- donations being rejected by the hook
- the benchmark: starts flat, can't be moved, exited or seated, tracks the vault, doesn't use a curator slot
- deposit/withdraw round trips
- the Reactive keeper: no-op mid-epoch, settles an ended epoch, drives a full takeover alone, rejects foreign callers and foreign RVM ids, settle fits the callback gas budget
- all the access-control reverts

### Testnet

```bash
cd contracts
PRIVATE_KEY=0x... \
POOL_MANAGER=0x00b036b58a818b1bc34d502d3fe730db729e62ac \
forge script script/DeployTestnet.s.sol --rpc-url https://sepolia.unichain.org --broadcast
```

That's the Unichain Sepolia PoolManager. Sepolia, Base Sepolia and Arbitrum Sepolia addresses are in the script header. It deploys test tokens, the hook, routers, a pool with liquidity, a "Genesis" seat holder and the benchmark, and writes `deployments/<chainId>.json`.

---

## Partner integrations

| Partner | What it does in Oorka | Where in the code |
|---|---|---|
| **Reactive Network** | Keeper-free epoch settlement. A reactive contract subscribes to Reactive's CRON events and calls back to a keeper on the hook's chain. The keeper accepts only the Reactive callback proxy plus our own RVM id, and settles the epoch once it has ended. | [`contracts/src/reactive/OorkaReactive.sol`](contracts/src/reactive/OorkaReactive.sol) (CRON subscription, `react()`, `Callback` emit)<br>[`contracts/src/reactive/OorkaKeeper.sol`](contracts/src/reactive/OorkaKeeper.sol) (`AbstractCallback`, `poke()` authorisation and settlement)<br>[`contracts/test/OorkaReactive.t.sol`](contracts/test/OorkaReactive.t.sol) (7 tests) |

No other partner integrations.

## Credits

Oorka's hook, vault, scoring, benchmark, settlement price and keeper logic were written for this project. It builds on:

- **Uniswap v4** ([v4-core](https://github.com/Uniswap/v4-core), [v4-periphery](https://github.com/Uniswap/v4-periphery)):
  - `PoolManager`, `StateLibrary`, `TickMath`, `SqrtPriceMath` and `LiquidityAmounts`;
  - the test helpers `Deployers`, `PoolSwapTest` and `PoolModifyLiquidityTest`, used in tests and the local demo.
- **solmate**: `ERC20` (vault shares) and `MockERC20` (test tokens).
- **Reactive Network** [reactive-lib](https://github.com/Reactive-Network/reactive-lib): `AbstractPausableReactive` and `AbstractCallback`. The CRON subscription pattern follows Reactive's [CRON demo](https://github.com/Reactive-Network/reactive-smart-contract-demos/tree/main/src/demos/cron).
- **Foundry** (forge, anvil), and **viem** + **React** + **Vite** for the dashboard.

## Architecture

```
contracts/
  src/OorkaHook.sol     the hook, the vault (ERC20 shares) and the curator registry, in one contract
  src/reactive/            OorkaReactive (Reactive Network CRON) + OorkaKeeper (callback, settles epochs)
  test/                    31 Foundry tests (hook + reactive keeper)
  script/DeployLocal.s.sol local world with seeded curators
  script/DeployTestnet.s.sol deploy against a real v4 PoolManager
frontend/                  Vite + React + viem dashboard
scripts/export_abi.py      copies ABIs into the frontend
demo.sh                    one-command demo
```

**Hook permissions:** `afterInitialize` (bind to one pool), `beforeSwap` (snapshot the block-open price) and `beforeDonate` (reject donations, which would otherwise inflate scores). That's it: the hook never touches swap pricing, so traders pay normal v4 fees.

**Position layout inside the PoolManager**, all owned by the hook and separated by salt:

| salt | what |
|---|---|
| `bytes32(id)` | curator `id`'s probe, `1e9` liquidity at their declared range |
| `type(uint256).max` | the vault's real liquidity at the seat holder's range |

**Paper NAV math (per curator):**

```
fees     = (feeGrowthInside_now - feeGrowthInside_last) * vL / 2^128
position = amounts(vL, range, blockOpenPrice)
NAV      = value(position + fees + cash, blockOpenPrice)    // in tUSD
```

`vL` (virtual liquidity) is set so the portfolio is worth exactly its NAV when the range is declared. A range change re-derives `vL` from the current NAV minus the switch cost.

**Key functions:**

| function | who | what |
|---|---|---|
| `register(name, lower, upper, bond)` | anyone | enter. The first registrant takes the seat. |
| `declareRange(id, lower, upper)` | curator | move your range. The seat holder's move also moves the vault. |
| `settleEpoch()` | anyone | score, update streaks, hand over the seat if earned |
| `deposit / withdraw` | depositors | ERC20 vault shares priced at the block-open price |
| `exit(id)` | challenger | leave and reclaim your bond |
| `compound()` | anyone | reinvest the vault's collected fees |
| `registerBenchmark(name, lower, upper)` | anyone, once | set the passive reference range. No owner, no bond, never competes. |
| `benchmarkReport()` | view | vault vs benchmark growth, since start and this epoch |

## Mapped to the judging criteria

| Criterion | Weight | Where Oorka scores |
|---|---|---|
| Original idea | 30% | Auction-managed AMM hooks (Chronus, Maestro, Turnstile in the UHI directory) *sell* the manager seat to the highest bidder. Oorka makes curators *earn* it with measured LP performance. Using dust probe positions to make v4 track fees at hypothetical ranges is, as far as we found, new. |
| Unique execution | 25% | Pure v4 primitives (`getFeeGrowthInside`, salted positions, the unlock callback). No oracle, no off-chain service. Manipulation-resistant block-open pricing, donations blocked at the hook. Keeper-free settlement via Reactive Network. |
| Impact | 20% | Turns "trust the manager" into "the manager is whoever is actually winning", and shows on-chain whether that beats a passive benchmark. Depositors get automatic manager replacement plus slashed bonds. Strategists get a permissionless way to prove skill without capital. |
| Functionality | 15% | 31 passing tests, one-command demo, a full lifecycle with real swaps on a real PoolManager. |
| Presentation | 10% | Live dashboard: lanes view, standings with sparklines, vault-vs-benchmark report, on-chain event log. |

## Pitch video script (about 3 minutes)

1. **(0:00) The problem.** "LP vaults ask you to trust a manager. What if the manager had to keep earning the job?"
2. **(0:20) The trick.** Show the lanes. "Every challenger's range has a dust probe, so Uniswap itself tracks what that range earns. These numbers are real fee growth, not a backtest."
3. **(0:50) Ranging market.** Click *Trade in a range* twice. Point at Tony's paper NAV climbing faster than Pam's.
4. **(1:20) Takeover.** *Skip to epoch end* and *Settle*, three times. Call out the qualifying epoch, the streak pips filling, then the takeover message and the vault bar jumping to Tony's range. Show the slashed bond in the event log.
5. **(2:00) Regime change.** Click *Pump tETH*. Tony's bar goes hatched and Pam leads. "The hook will hand the seat back if this keeps up. Nobody had to vote."
6. **(2:20) Does it pay?** Point at the Vault panel: vault vs benchmark, since start and this epoch. "Every settlement reports whether the contested seat beat sitting still."
7. **(2:35) Safety.** Flash the attack/defense table. Mention block-open pricing, blocked donations, the Reactive keeper and the 31 tests.
8. **(2:50) Close.** "Oorka: curation as a competition that settles itself on-chain."

## Next steps

- Wallet-connected frontend for testnets (the demo uses anvil dev keys)
- Per-epoch fee-credit caps against wash trading
- Benchmark-relative performance fees: the seat holder earns a cut only on returns above the benchmark, which the hook already measures
- Several vaults per pool with different risk mandates, all reading the same leaderboard
- Swap-based rebalancing on migration instead of leaving the unmatched side idle
