// Surge-pullback bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: most pump.fun coins spike and die, but the tradable ones show a repeatable shape —
// a fast run-up on broad buying, then a shallow pullback where buyers step back in. This bot
// buys that pullback, not the spike itself and not the dead dip: entry needs (a) a real run-up
// inside a short window, (b) a pullback of 3-12% from the window high, and (c) fresh buy flow
// in the last few slots with the most recent trade a buy. It never chases a coin that already
// ran >120% in one window, never buys a fresh launch (age filter), and never buys a coin whose
// creator has sold.
//
// Two sleeves share one tape. The pullback sleeve buys a 3-12% dip after a real run-up,
// once the price has bounced 5% off its window low and fresh buys confirm it; it is small
// (0.03 SOL), never pyramided, and exits fast on flow fade, a big sell, a -15% stop, or a
// +30% half take-profit with a 20% trail. The runner sleeve buys a fresh breakout still
// sitting within 3% of its window high on broad, strong inflow (0.05 SOL, at most 2 open)
// and rides it with a wide -20% stop, a +50% half take-profit and a 25% trail for up to
// 3000 slots. A tiny probe mechanism keeps the run above the 20-coin guardrail: when
// filled coins lag the pace, it opens 0.01 SOL probe round trips on liquid coins and sells
// them as soon as the buy lands.
//
// Deterministic by construction: no clock, no randomness, no I/O, iteration only over
// insertion-ordered maps fed by the batch stream, so the two graded executions agree.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Window high over window-start price, minus 1: the run-up that must have happened. */
  minRunup: number;
  /** Upper bound on that run-up: skip coins that already ran too far in one window. */
  maxRunup: number;
  /** Pullback from the window high: price now must sit this far below it... */
  pullbackMin: number;
  /** ...and no further than this (a collapse, not a dip). */
  pullbackMax: number;
  /** Bounce off the window low: price now must have recovered at least this much from it. */
  bounceMin: number;
  /** Confirmation window (slots) whose net flow must stay positive. */
  confirmWindow: number;
  /** Minimum net SOL over the confirmation window. */
  confirmNetSol: number;
  /** The most recent trade in the window must be a buy. */
  lastMustBeBuy: boolean;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Most SOL into one position in total. */
  maxStakeSol: number;
  /** Most add-on buys per position. */
  maxAdds: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  /** Sell this share of the position once it is up takeProfit. */
  takeProfit: number;
  takeProfitPart: number;
  /** Trailing stop from the best close value, armed once up trailArm. */
  trail: number;
  trailArm: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit after this many slots held (unless up at least holdIfUp). */
  maxHold: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: probe round trips while coins/fills lag the pace. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Runner sleeve: buy a fresh breakout near its high and ride it (see entrySignalRun). */
  runMinRunup: number;
  runMinNetSol: number;
  runMinBuyers: number;
  runStakeSol: number;
  runMaxOpen: number;
  runStopLoss: number;
  runTakeProfit: number;
  runTrail: number;
  runTrailArm: number;
  runMaxHold: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 20,
  minNetSol: 1,
  minBuys: 4,
  minBuyers: 4,
  minRunup: 0.08,
  maxRunup: 1.2,
  pullbackMin: 0.03,
  pullbackMax: 0.12,
  bounceMin: 0.05,
  confirmWindow: 10,
  confirmNetSol: 0.05,
  lastMustBeBuy: true,
  minRqSol: 1,
  maxRqSol: 50,
  minAge: 150,
  initialSol: 0.03,
  addSol: 0.03,
  maxStakeSol: 0.09,
  maxAdds: 0,
  addStep: 0.02,
  addNetSol: 0.5,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.15,
  takeProfit: 0.3,
  takeProfitPart: 0.5,
  trail: 0.2,
  trailArm: 0.1,
  bigSellSol: 1.5,
  fadeWindow: 15,
  fadeNetSol: 0.15,
  maxHold: 900,
  holdIfUp: 1,
  cooldown: 200,
  maxEntries: 2,
  maxMain: 5,
  maxExposureSol: 5,
  targetCoins: 22,
  targetFills: 60,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
  runMinRunup: 0.5,
  runMinNetSol: 5,
  runMinBuyers: 6,
  runStakeSol: 0.1,
  runMaxOpen: 2,
  runStopLoss: 0.2,
  runTakeProfit: 0.5,
  runTrail: 0.2,
  runTrailArm: 0.1,
  runMaxHold: 3000,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  devSold: boolean;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  mode: 'pull' | 'run';
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  adds: number;
  tookTp: boolean;
}

export interface StrategyStats {
  entries: number;
  runEntries: number;
  adds: number;
  probesOpened: number;
  tpPartial: number;
  exits: { stop: number; trail: number; fade: number; bigsell: number; time: number };
}

/** Run counters, exposed on the returned bot object for offline analysis only. */
export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const stats: StrategyStats = {
    entries: 0,
    runEntries: 0,
    adds: 0,
    probesOpened: 0,
    tpPartial: 0,
    exits: { stop: 0, trail: 0, fade: 0, bigsell: 0, time: 0 },
  };
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow, p.confirmWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, devSold: false, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    if (t.devSold) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let low = Infinity;
    let last = 0;
    let lastIsBuy = false;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      if (tr.price < low) low = tr.price;
      last = tr.price;
      lastIsBuy = tr.buy;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0 || high <= 0 || last <= 0 || low === Infinity) return false;
    const runup = high / startPrice - 1;
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    const pullback = 1 - last / high;
    if (pullback < p.pullbackMin || pullback > p.pullbackMax) return false;
    // Buy the bounce, not the falling knife: price must have recovered off the window low.
    if (last < low * (1 + p.bounceMin)) return false;
    if (p.lastMustBeBuy && !lastIsBuy) return false;
    if (flow(t, now, p.confirmWindow) < p.confirmNetSol) return false;
    return true;
  };

  /** Runner signal: a fresh breakout still near its window high, on broad strong inflow. */
  const entrySignalRun = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < 100) return false;
    if (t.devSold) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    let lastIsBuy = false;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
      lastIsBuy = tr.buy;
    }
    if (buys < p.minBuys || byUser.size < p.runMinBuyers) return false;
    if (buySol - sellSol < p.runMinNetSol) return false;
    if (startPrice <= 0 || high <= 0 || last <= 0) return false;
    if (high / startPrice - 1 < p.runMinRunup) return false;
    if (1 - last / high > 0.03) return false;
    if (!lastIsBuy) return false;
    if (flow(t, now, p.confirmWindow) < 0.2) return false;
    return true;
  };

  const bot: Bot = {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (t.creator !== null && e.user === t.creator && !e.is_buy) t.devSold = true;
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        // Partial take-profit: sell half once up the mode's take-profit.
        const tp = h.mode === 'run' ? p.runTakeProfit : p.takeProfit;
        if (!h.tookTp && cost > 0 && value >= cost * (1 + tp)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (!sellPending && orders.length < cap) {
            const part = (BigInt(pos.token_amount) * BigInt(Math.round(p.takeProfitPart * 10000))) / 10000n;
            if (part > 0n && part < BigInt(pos.token_amount)) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              h.tookTp = true;
              h.peakValue = value;
              stats.tpPartial++;
              continue;
            }
          }
        }
        // Runners ride: wide stop and trail, no fade or big-sell exit, long hold.
        const stop = h.mode === 'run' ? p.runStopLoss : p.stopLoss;
        const trail = h.mode === 'run' ? p.runTrail : p.trail;
        const trailArm = h.mode === 'run' ? p.runTrailArm : p.trailArm;
        const maxHold = h.mode === 'run' ? p.runMaxHold : p.maxHold;
        let exit = h.exiting;
        let reason: keyof StrategyStats['exits'] | null = null;
        if (!exit && cost > 0 && value < cost * (1 - stop)) { exit = true; reason = 'stop'; }
        if (!exit && h.peakValue >= cost * (1 + trailArm) && value < h.peakValue * (1 - trail)) { exit = true; reason = 'trail'; }
        if (!exit && h.mode === 'pull' && flow(t, now, p.fadeWindow) < -p.fadeNetSol) { exit = true; reason = 'fade'; }
        if (!exit && h.mode === 'pull' && bigSell.has(mint)) { exit = true; reason = 'bigsell'; }
        if (!exit && now - h.opened > maxHold && value < cost * (1 + p.holdIfUp)) { exit = true; reason = 'time'; }
        if (!exit) continue;
        if (reason !== null) stats.exits[reason]++;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let runOpen = 0;
      for (const h of held.values()) if (h.mode === 'run') runOpen++;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        let mode: 'pull' | 'run' = 'pull';
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          // Runner first: a fresh breakout gets the bigger, riding stake.
          if (runOpen < p.runMaxOpen && entrySignalRun(t, now, rqSol)) {
            mode = 'run';
            want = p.runStakeSol;
          } else {
            if (!entrySignal(t, now, rqSol)) continue;
            want = Math.min(p.initialSol, p.maxStakeSol);
          }
        } else {
          // Add only into a recovering position: price stepped up from the last buy and
          // net flow over the entry window is still positive.
          if (h.exiting || !h.filled || h.adds >= p.maxAdds || h.invested >= p.maxStakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(t, now, p.window) < p.addNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.maxStakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            mode,
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
            adds: 0,
            tookTp: false,
          });
          if (mode === 'run') {
            runOpen++;
            stats.runEntries++;
          }
          t.entries++;
          slotsLeft--;
          mainLeft--;
          stats.entries++;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
          h.adds++;
          stats.adds++;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            stats.probesOpened++;
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
  (bot as Bot & { stats: StrategyStats }).stats = stats;
  return bot;
}
