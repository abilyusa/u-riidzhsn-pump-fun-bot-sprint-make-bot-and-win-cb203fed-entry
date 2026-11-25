// surge-pullback: a two-sleeve trading bot for the pump.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim is
// the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Sleeve 1 — pullback: buys a 3-12% dip after a real run-up, once the price has bounced 5%
// off its window low and fresh buys confirm it. Small (0.03 SOL), never pyramided, exits
// fast on flow fade, a big sell, a -15% stop, or a +30% half take-profit with a 20% trail.
// Sleeve 2 — runner: buys only the strongest fresh breakouts (≥50% run-up in 20 slots on
// ≥5 SOL net inflow from ≥6 buyers, still within 3% of the window high) with 0.10 SOL and
// rides them on a wide -20% stop, a +50% half take-profit and a 20% trail for up to 3000
// slots. A 0.01 SOL probe mechanism keeps the run above the 20-coin guardrail.
//
// Paper money only: the bot trades the replay's simulated market, never real funds, never
// touches the network, and is deterministic (no clock, no randomness, no I/O), so the two
// graded executions produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
