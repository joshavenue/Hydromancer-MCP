/**
 * Hydromancer MCP tools. Each tool answers a question a trader would actually ask,
 * accepts friendly inputs (coin names in any case, "7d" style times), and returns a
 * compact summary first with the raw rows after it.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HydromancerClient } from "./client.js";
import { resolveCoin, resolveCoins } from "./coins.js";
import { fail, num, ok, page, round, type ToolResult } from "./shape.js";
import { iso, parseTime, timeDescription } from "./time.js";

type Obj = Record<string, any>;

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a 0x wallet address with 40 hex characters")
  .describe("Wallet address, 0x followed by 40 hex characters.");
const coin = z.string().min(1).describe('Market name, any case: "BTC", "eth", "HYPE", "kPEPE", or a HIP-3 market such as "xyz:TSLA".');
const timeArg = z.union([z.string(), z.number()]);
const limit = (def: number, max: number) => z.number().int().min(1).max(max).optional().describe(`How many rows to return (default ${def}, max ${max}).`);
const offset = z.number().int().min(0).optional().describe("Rows to skip, for paging.");

function define(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  inputSchema: z.ZodRawShape,
  handler: (args: Obj) => Promise<unknown>,
): string {
  server.registerTool(
    name,
    { title, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: true } },
    (async (args: Obj): Promise<ToolResult> => {
      try {
        return ok(await handler(args ?? {}));
      } catch (err) {
        return fail(err);
      }
    }) as any,
  );
  return name;
}

function window(args: Obj, defaultStart: string): { start: number; end?: number } {
  const start = parseTime(args.since ?? defaultStart)!;
  const end = parseTime(args.until);
  if (end !== undefined && end <= start) throw new Error("`until` must be later than `since`.");
  return { start, end };
}

/* ---------------- summaries ---------------- */

function summarisePerpState(state: Obj | null): Obj {
  if (!state || !state.marginSummary) return { note: "No perp account found for this address." };
  const positions = (state.assetPositions ?? []).map((p: Obj) => {
    const pos = p.position ?? {};
    const size = num(pos.szi);
    return {
      coin: pos.coin,
      side: size > 0 ? "long" : size < 0 ? "short" : "flat",
      size: Math.abs(size),
      valueUsd: round(num(pos.positionValue)),
      entryPrice: num(pos.entryPx),
      liquidationPrice: pos.liquidationPx == null ? null : num(pos.liquidationPx),
      leverage: pos.leverage ? `${pos.leverage.value}x ${pos.leverage.type}` : null,
      unrealizedPnlUsd: round(num(pos.unrealizedPnl)),
      returnOnEquityPct: round(num(pos.returnOnEquity) * 100),
      fundingSinceOpenUsd: pos.cumFunding ? round(-num(pos.cumFunding.sinceOpen)) : null,
    };
  });
  positions.sort((a: Obj, b: Obj) => b.valueUsd - a.valueUsd);
  return {
    accountValueUsd: round(num(state.marginSummary.accountValue)),
    totalPositionValueUsd: round(num(state.marginSummary.totalNtlPos)),
    marginUsedUsd: round(num(state.marginSummary.totalMarginUsed)),
    withdrawableUsd: round(num(state.withdrawable)),
    effectiveLeverage: num(state.marginSummary.accountValue) > 0 ? round(num(state.marginSummary.totalNtlPos) / num(state.marginSummary.accountValue)) : null,
    openPositions: positions.length,
    positions,
  };
}

/* Unified-account and portfolio-margin wallets hold their money in spot; the perp
 * accountValue then only reflects margin in open positions (or 0 with none). */
const SPOT_BALANCE_MODES = new Set(["unifiedAccount", "portfolioMargin"]);
const STABLECOINS = new Set(["USDC", "USDT0", "USDH", "USDE"]);

function spotStablecoinsUsd(spot: Obj | null | undefined): number {
  return (spot?.balances ?? []).reduce((s: number, b: Obj) => s + (STABLECOINS.has(b.coin) ? num(b.total) : 0), 0);
}

function perpAccountValue(chs: Obj | null | undefined): number {
  if (!chs) return 0;
  if (chs.marginSummary) return num(chs.marginSummary.accountValue);
  return Object.values(chs).reduce((s: number, st) => s + num((st as Obj)?.marginSummary?.accountValue), 0);
}

/** Best single balance figure for a wallet, honest about what it covers. */
function balanceSummary(mode: string | null | undefined, chs: Obj | null | undefined, spot: Obj | null | undefined): Obj {
  const stables = spotStablecoinsUsd(spot);
  const perp = perpAccountValue(chs);
  const spotMode = SPOT_BALANCE_MODES.has(mode ?? "");
  return {
    accountMode: mode ?? null,
    balanceUsd: round(spotMode ? stables : perp + stables),
    balanceNote: spotMode
      ? `${mode} wallet: its balance lives in spot, so this is its spot stablecoin balance (USDC, USDT0, USDH, USDE). The perp accountValue below only shows margin in open positions. Other spot tokens are listed separately and not priced.`
      : "Perp account value plus spot stablecoins (USDC, USDT0, USDH, USDE). Other spot tokens are listed separately and not priced.",
  };
}

function summariseFills(fills: Obj[]): Obj {
  let volume = 0, pnl = 0, fees = 0;
  const byCoin: Record<string, { fills: number; volumeUsd: number; realizedPnlUsd: number }> = {};
  for (const f of fills) {
    const v = num(f.px) * num(f.sz);
    volume += v; pnl += num(f.closedPnl); fees += num(f.fee);
    const c = (byCoin[f.coin] ??= { fills: 0, volumeUsd: 0, realizedPnlUsd: 0 });
    c.fills++; c.volumeUsd += v; c.realizedPnlUsd += num(f.closedPnl);
  }
  for (const c of Object.values(byCoin)) { c.volumeUsd = round(c.volumeUsd); c.realizedPnlUsd = round(c.realizedPnlUsd); }
  return { fills: fills.length, volumeUsd: round(volume), realizedPnlUsd: round(pnl), feesPaid: round(fees), byCoin };
}

function compactFill(f: Obj): Obj {
  return {
    time: iso(f.time),
    coin: f.coin,
    action: f.dir,
    price: num(f.px),
    size: num(f.sz),
    valueUsd: round(num(f.px) * num(f.sz)),
    realizedPnlUsd: round(num(f.closedPnl)),
    fee: num(f.fee),
    taker: f.crossed,
    ...(f.user ? { user: f.user } : {}),
    ...(f.builderFee ? { builderFee: num(f.builderFee) } : {}),
    ...(f.liquidation ? { liquidation: true } : {}),
  };
}

/* ---------------- registration ---------------- */

export function registerTools(server: McpServer, client: HydromancerClient): string[] {
  const names: string[] = [];
  const add = (...a: Parameters<typeof define> extends [any, ...infer R] ? R : never) => names.push(define(server, ...a));

  // ---------- Wallets ----------
  add(
    "hydromancer_wallet_overview",
    "Wallet overview: balance, open positions, PnL record",
    "One-call profile of any Hyperliquid wallet: account value, every open perp position (side, size, entry, liquidation price, leverage, unrealized PnL), spot balances and its realized trading record (PnL, win rate, trade count, volume, human score). Use this first for questions like \"what is this wallet holding?\" or \"is this trader any good?\". Set includeHip3=true to include HIP-3 markets such as xyz:TSLA.",
    { address, includeHip3: z.boolean().optional().describe("Also include positions on HIP-3 markets (stocks, indices, commodities). Default false.") },
    async ({ address: user, includeHip3 }) => {
      const [portfolio, pnl] = await Promise.all([
        client.info<Obj>({ type: "portfolioState", user, ...(includeHip3 ? { dex: "ALL_DEXES" } : {}) }),
        client.info<Obj>({ type: "userPnlSummary", user }).catch((e): Obj => ({ error: (e as Error).message })),
      ]);
      const chs = portfolio?.clearinghouseState ?? null;
      let perp: Obj;
      if (includeHip3 && chs && !chs.marginSummary) {
        perp = {};
        for (const [dex, st] of Object.entries(chs)) {
          const s = summarisePerpState(st as Obj);
          if ((s.openPositions ?? 0) > 0 || dex === "native") perp[dex] = s;
        }
      } else perp = summarisePerpState(chs);
      const spot = (portfolio?.spotClearinghouseState?.balances ?? [])
        .filter((b: Obj) => num(b.total) !== 0)
        .map((b: Obj) => ({ token: b.coin, amount: num(b.total), onHold: num(b.hold), costBasisUsd: round(num(b.entryNtl)) }));
      return {
        address: user,
        ...balanceSummary(portfolio?.userAbstraction, chs, portfolio?.spotClearinghouseState),
        perp,
        spotBalances: spot,
        tradingRecord: pnl && !pnl.error
          ? {
              realizedPnlUsd: round(num(pnl.totalPnl)),
              winRatePct: pnl.winRate == null ? null : round(num(pnl.winRate) * 100),
              completedTrades: pnl.totalTrades,
              volumeTradedUsd: round(num(pnl.volumeTraded)),
              feesPaidUsd: round(num(pnl.totalFees)),
              fundingUsd: round(num(pnl.totalFunding)),
              daysActive: pnl.daysActive,
              accountAgeDays: pnl.accountAgeDays,
              humanScore: pnl.humanScore,
              humanScoreMeaning: "0-100; low scores suggest a bot or market maker.",
              marketsTraded: pnl.tradedPairs,
            }
          : (pnl ?? null),
      };
    },
  );

  add(
    "hydromancer_compare_wallets",
    "Compare many wallets at once",
    "Look up balance, account mode and open positions for up to 1,000 wallets (100 when includeHip3=true), sorted by balance. Handles unified-account and portfolio-margin wallets, whose money sits in spot rather than perps. Use for watchlists: \"which of these wallets are whales?\", \"what do these 50 traders hold?\".",
    {
      addresses: z.array(address).min(1).max(1000).describe("Wallet addresses to look up."),
      includeHip3: z.boolean().optional().describe("Include HIP-3 markets (limit drops to 100 wallets)."),
      minBalanceUsd: z.number().optional().describe("Only return wallets with at least this balance (see balanceNote on each wallet)."),
    },
    async ({ addresses, includeHip3, minBalanceUsd }) => {
      if (includeHip3 && addresses.length > 100) throw new Error("With includeHip3=true the limit is 100 wallets per request.");
      // batchPortfolioStates returns perp + spot + account mode; max 500 wallets per request, so chunk.
      const chunks: string[][] = [];
      for (let i = 0; i < addresses.length; i += 500) chunks.push(addresses.slice(i, i + 500));
      const results = await Promise.all(
        chunks.map((users) => client.info<Obj>({ type: "batchPortfolioStates", users, ...(includeHip3 ? { dex: "ALL_DEXES" } : {}) })),
      );
      const states = results.flatMap((r) => r?.successful_states ?? []);
      const failed = results.flatMap((r) => r?.failed_wallets ?? []);
      const rows = states.map(([addr, ps]: [string, Obj]) => {
        const chs = ps?.clearinghouseState ?? null;
        const balance = balanceSummary(ps?.userAbstraction, chs, ps?.spotClearinghouseState);
        if (includeHip3 && chs && !chs.marginSummary) {
          const parts = Object.entries(chs).map(([dex, s]) => ({ dex, ...summarisePerpState(s as Obj) }));
          return { address: addr, ...balance, perpByDex: parts.filter((p: Obj) => p.openPositions > 0) };
        }
        return { address: addr, ...balance, perp: summarisePerpState(chs) };
      });
      const filtered = rows.filter((r: Obj) => minBalanceUsd == null || num(r.balanceUsd) >= minBalanceUsd);
      filtered.sort((a: Obj, b: Obj) => num(b.balanceUsd) - num(a.balanceUsd));
      return { requested: addresses.length, returned: filtered.length, failed, wallets: filtered };
    },
  );

  add(
    "hydromancer_wallet_trades",
    "Wallet trade history (fills)",
    `Every fill (buy/sell execution) a wallet made in a time window, newest first, with totals: volume, realized PnL, fees and a per-coin breakdown. since/until accept ${timeDescription} Default window: last 24h. Large orders split into many fills are merged by default.`,
    {
      address,
      since: timeArg.optional().describe(`Start of window. ${timeDescription} Default "24h".`),
      until: timeArg.optional().describe(`End of window. Default now.`),
      coin: coin.optional(),
      mergeSplitOrders: z.boolean().optional().describe("Merge pieces of one order into a single fill (default true)."),
      limit: limit(100, 2000),
      offset,
    },
    async (a) => {
      const { start, end } = window(a, "24h");
      const fills = await client.info<Obj[]>({ type: "userFillsByTime", user: a.address, startTime: start, endTime: end, aggregateByTime: a.mergeSplitOrders ?? true });
      let rows = fills ?? [];
      if (a.coin) {
        const c = await resolveCoin(client, a.coin);
        rows = rows.filter((f) => f.coin === c);
      }
      rows.sort((x, y) => y.time - x.time);
      const p = page(rows.map(compactFill), a.limit ?? 100, a.offset ?? 0);
      return {
        window: { from: iso(start), to: iso(end ?? Date.now()) },
        totals: summariseFills(rows),
        note: (fills?.length ?? 0) >= 2000 ? "The API returned its 2,000-fill maximum; narrow the time window to see everything." : undefined,
        paging: p.paging,
        fills: p.rows,
      };
    },
  );

  add(
    "hydromancer_wallet_closed_trades",
    "Wallet closed trades (open-to-close round trips)",
    `Completed trades for a wallet: each row is a full position from open to close with entry, exit, size, gross and net PnL, fees, funding and how long it was held. Best tool for judging trading skill ("what is this wallet's win rate and best coin?"). Default window: last 30 days. since/until accept ${timeDescription}`,
    {
      address,
      since: timeArg.optional().describe(`Start of window. Default "30d".`),
      until: timeArg.optional(),
      coin: coin.optional(),
      limit: limit(100, 500),
    },
    async (a) => {
      const { start, end } = window(a, "30d");
      const trades = await client.info<Obj[]>({ type: "userCompletedTradesByTime", user: a.address, startTime: start, endTime: end, limit: a.limit ?? 100 });
      let rows = trades ?? [];
      if (a.coin) {
        const c = await resolveCoin(client, a.coin);
        rows = rows.filter((t) => t.coin === c);
      }
      const wins = rows.filter((t) => num(t.net_pnl) > 0).length;
      const byCoin: Record<string, { trades: number; netPnlUsd: number }> = {};
      for (const t of rows) {
        const b = (byCoin[t.coin] ??= { trades: 0, netPnlUsd: 0 });
        b.trades++; b.netPnlUsd = round(b.netPnlUsd + num(t.net_pnl));
      }
      const holds = rows.map((t) => num(t.duration_ms)).sort((x, y) => x - y);
      return {
        window: { from: iso(start), to: iso(end ?? Date.now()) },
        summary: {
          trades: rows.length,
          winRatePct: rows.length ? round((wins / rows.length) * 100) : null,
          netPnlUsd: round(rows.reduce((s, t) => s + num(t.net_pnl), 0)),
          medianHoldMinutes: holds.length ? round(holds[Math.floor(holds.length / 2)] / 60_000, 1) : null,
          byCoin,
        },
        trades: rows.map((t) => ({
          coin: t.coin,
          side: t.position_type,
          opened: iso(t.open_time),
          closed: iso(t.close_time),
          holdMinutes: round(num(t.duration_ms) / 60_000, 1),
          entryPrice: num(t.entry_px),
          exitPrice: num(t.exit_px),
          size: num(t.position_closed_size),
          grossPnlUsd: round(num(t.gross_pnl)),
          netPnlUsd: round(num(t.net_pnl)),
          feesUsd: round(num(t.fees)),
          fundingUsd: round(num(t.funding_pnl)),
        })),
      };
    },
  );

  add(
    "hydromancer_wallet_open_orders",
    "Wallet open orders (limits, stop-losses, take-profits)",
    "All resting orders for a wallet right now, including stop-loss and take-profit triggers. Shows where a trader plans to buy, sell or exit.",
    { address },
    async ({ address: user }) => {
      const orders = (await client.info<Obj[]>({ type: "frontendOpenOrders", user })) ?? [];
      return {
        openOrders: orders.length,
        orders: orders.map((o) => ({
          coin: o.coin,
          side: o.side === "B" ? "buy" : "sell",
          type: o.orderType,
          price: num(o.limitPx),
          triggerPrice: o.isTrigger ? num(o.triggerPx) : null,
          triggerCondition: o.isTrigger ? o.triggerCondition : null,
          size: num(o.sz),
          valueUsd: round(num(o.limitPx) * num(o.sz)),
          reduceOnly: o.reduceOnly,
          placed: iso(o.timestamp),
        })),
      };
    },
  );

  add(
    "hydromancer_wallet_transfers",
    "Wallet deposits, withdrawals, transfers and liquidations",
    `Money movements for a wallet: deposits, withdrawals, sends, spot/perp transfers, vault deposits and liquidations. Default window: last 30 days. since/until accept ${timeDescription}`,
    { address, since: timeArg.optional().describe('Default "30d".'), until: timeArg.optional(), limit: limit(100, 2000) },
    async (a) => {
      const { start, end } = window(a, "30d");
      const rows = ((await client.info<Obj[]>({ type: "userNonFundingLedgerUpdates", user: a.address, startTime: start, endTime: end })) ?? []).sort((x, y) => y.time - x.time);
      const p = page(rows, a.limit ?? 100);
      return {
        window: { from: iso(start), to: iso(end ?? Date.now()) },
        paging: p.paging,
        events: p.rows.map((e) => ({ time: iso(e.time), type: e.delta?.type, ...e.delta, hash: e.hash })),
      };
    },
  );

  add(
    "hydromancer_wallet_funding",
    "Wallet funding payments",
    `Funding paid or received by a wallet's open positions, hour by hour, with totals per coin. Positive = received, negative = paid. Default window: last 7 days.`,
    { address, since: timeArg.optional().describe('Default "7d".'), until: timeArg.optional() },
    async (a) => {
      const { start, end } = window(a, "7d");
      const rows = (await client.info<Obj[]>({ type: "userFunding", user: a.address, startTime: start, endTime: end })) ?? [];
      const byCoin: Record<string, number> = {};
      for (const r of rows) byCoin[r.delta?.coin] = round((byCoin[r.delta?.coin] ?? 0) + num(r.delta?.usdc));
      return {
        window: { from: iso(start), to: iso(end ?? Date.now()) },
        totalUsd: round(rows.reduce((s, r) => s + num(r.delta?.usdc), 0)),
        byCoin,
        payments: rows.length,
        latest: rows.slice(-24).reverse().map((r) => ({ time: iso(r.time), coin: r.delta?.coin, usdc: num(r.delta?.usdc), rate: num(r.delta?.fundingRate) })),
      };
    },
  );

  // ---------- Traders ----------
  add(
    "hydromancer_top_traders",
    "Top traders leaderboard",
    "Rank Hyperliquid traders by realized profit, win rate or volume over 1 day to all time, with filters that remove bots and one-off wallets. Use for \"who are the best traders this week?\", \"find consistent winners on stocks (dex xyz)\" or \"top traders using builder X\". Pair with hydromancer_wallet_overview to see what they hold now.",
    {
      period: z.enum(["1d", "7d", "30d", "90d", "all"]).optional().describe('Time period (default "30d").'),
      rankBy: z.enum(["profit", "winRate", "volume"]).optional().describe('Ranking (default "profit").'),
      limit: limit(25, 1000),
      offset,
      minTrades: z.number().int().min(0).optional().describe("Minimum completed trades (default 5)."),
      minDaysActive: z.number().int().min(0).optional().describe("Minimum distinct active days (default 1)."),
      excludeBots: z.boolean().optional().describe("Drop wallets that look automated (human score below 60). Default true."),
      market: z.string().optional().describe('Only "main" (native Hyperliquid) or a HIP-3 dex such as "xyz". Omit for all.'),
      builder: address.optional().describe("Only traders who have traded through this builder's app."),
    },
    async (a) => {
      const sortBy = { profit: "totalPnl", winRate: "winRate", volume: "volumeTraded" }[(a.rankBy ?? "profit") as "profit"];
      const res = await client.info<Obj>({
        type: "userPnlLeaderboard",
        window: a.period ?? "30d",
        sortBy,
        limit: a.limit ?? 25,
        offset: a.offset,
        minTrades: a.minTrades,
        minDaysActive: a.minDaysActive,
        minHumanScore: a.excludeBots === false ? undefined : 60,
        dex: a.market === "main" ? "main_dex" : a.market,
        builder: a.builder,
      });
      return {
        period: a.period ?? "30d",
        rankedBy: a.rankBy ?? "profit",
        matchingTraders: res?.total,
        traders: (res?.users ?? []).map((u: Obj, i: number) => ({
          rank: (a.offset ?? 0) + i + 1,
          address: u.user,
          realizedPnlUsd: round(num(u.totalPnl)),
          winRatePct: u.winRate == null ? null : round(num(u.winRate) * 100),
          trades: u.totalTrades,
          volumeUsd: round(num(u.volumeTraded)),
          daysActive: u.daysActive,
          accountAgeDays: u.accountAgeDays,
          humanScore: u.humanScore,
          markets: (u.tradedPairs ?? []).slice(0, 10),
        })),
      };
    },
  );

  // ---------- Markets ----------
  add(
    "hydromancer_market_snapshot",
    "Live price, volume, open interest and funding for markets",
    "Current mark/oracle/mid price, 24h volume, open interest (in coins and USD) and max leverage for one or more markets. Leave coins empty for the top markets by 24h volume. Works for HIP-3 markets (e.g. \"xyz:TSLA\").",
    {
      coins: z.array(z.string()).max(20).optional().describe('Markets to show, e.g. ["BTC","ETH","xyz:TSLA"]. Omit for the busiest markets.'),
      top: z.number().int().min(1).max(100).optional().describe("When coins is empty, how many top markets by 24h volume (default 15)."),
    },
    async (a) => {
      if (a.coins?.length) {
        const coins = await resolveCoins(client, a.coins);
        const ctx = (await client.info<Obj>({ type: "assetContext", coins })) ?? {};
        return {
          markets: coins.map((c) => {
            const x = ctx[c];
            if (!x) return { coin: c, note: "Unknown market. Check the spelling, or use the HIP-3 prefix such as xyz:TSLA." };
            return {
              coin: c,
              markPrice: num(x.markPx),
              oraclePrice: num(x.oraclePx),
              midPrice: x.midPx == null ? null : num(x.midPx),
              volume24hUsd: round(num(x.dayNtlVlm)),
              openInterestCoins: num(x.openInterest),
              openInterestUsd: round(num(x.openInterest) * num(x.markPx)),
            };
          }),
        };
      }
      const [meta, ctxs] = (await client.info<[Obj, Obj[]]>({ type: "metaAndAssetCtxs" })) ?? [{ universe: [] }, []];
      const rows = meta.universe
        .map((u: Obj, i: number) => ({ u, c: ctxs[i] ?? {} }))
        .filter(({ u }: Obj) => !u.isDelisted)
        .map(({ u, c }: Obj) => ({
          coin: u.name,
          markPrice: num(c.markPx),
          volume24hUsd: round(num(c.dayNtlVlm)),
          openInterestUsd: round(num(c.openInterest) * num(c.markPx)),
          maxLeverage: u.maxLeverage,
        }))
        .sort((x: Obj, y: Obj) => y.volume24hUsd - x.volume24hUsd);
      return { note: "Native Hyperliquid perps, sorted by 24h volume. HIP-3 markets: pass coins such as xyz:TSLA. For funding rates use hydromancer_funding_history; for 24h change use hydromancer_price_history.", markets: rows.slice(0, a.top ?? 15) };
    },
  );

  add(
    "hydromancer_price_history",
    "Price candles (OHLCV)",
    `Price history as candles (open, high, low, close, volume) for any market. Intervals from 1 second to 1 month. Default: 1h candles for the last 24h. since/until accept ${timeDescription}`,
    {
      coin,
      interval: z.enum(["1s", "15s", "30s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"]).optional().describe('Candle size (default "1h"). "1s" only covers about the last 30 minutes.'),
      since: timeArg.optional().describe('Default "24h".'),
      until: timeArg.optional(),
    },
    async (a) => {
      const c = await resolveCoin(client, a.coin);
      const { start, end } = window(a, "24h");
      const candles = (await client.info<Obj[]>({ type: "candleSnapshot", req: { coin: c, interval: a.interval ?? "1h", startTime: start, endTime: end ?? Date.now() } })) ?? [];
      const closes = candles.map((k) => num(k.c));
      return {
        coin: c,
        interval: a.interval ?? "1h",
        candles: candles.length,
        summary: candles.length
          ? {
              open: num(candles[0].o),
              close: closes[closes.length - 1],
              high: Math.max(...candles.map((k) => num(k.h))),
              low: Math.min(...candles.map((k) => num(k.l))),
              changePct: round(((closes[closes.length - 1] - num(candles[0].o)) / num(candles[0].o)) * 100),
              volumeUsd: round(candles.reduce((s, k) => s + num(k.q ?? num(k.v) * num(k.c)), 0)),
            }
          : null,
        rows: candles.map((k) => ({ time: iso(k.t), open: num(k.o), high: num(k.h), low: num(k.l), close: num(k.c), volume: num(k.v), trades: k.n })),
      };
    },
  );

  add(
    "hydromancer_funding_history",
    "Funding rate history for a market",
    "Hourly funding rates for a market over time, with the average and annualized rate. Positive funding means longs pay shorts. Default window: last 7 days.",
    { coin, since: timeArg.optional().describe('Default "7d".'), until: timeArg.optional() },
    async (a) => {
      const c = await resolveCoin(client, a.coin);
      const { start, end } = window(a, "7d");
      const rows = (await client.info<Obj[]>({ type: "fundingHistory", coin: c, startTime: start, endTime: end })) ?? [];
      const rates = rows.map((r) => num(r.fundingRate));
      const avg = rates.length ? rates.reduce((s, r) => s + r, 0) / rates.length : 0;
      return {
        coin: c,
        periods: rows.length,
        averageHourlyPct: round(avg * 100, 5),
        annualizedPct: round(avg * 24 * 365 * 100, 2),
        latest: rows.slice(-24).reverse().map((r) => ({ time: iso(r.time), ratePct: round(num(r.fundingRate) * 100, 5) })),
        note: rows.length >= 500 ? "Capped at 500 periods; use a shorter window for full detail." : undefined,
      };
    },
  );

  add(
    "hydromancer_open_interest_history",
    "Open interest history",
    "How open interest (total open positions) in a market changed over time, in coins and USD. Rising OI with rising price usually means new longs; falling OI means positions are closing. Default: hourly for the last 24h.",
    {
      coin,
      interval: z.enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"]).optional().describe('Bucket size (default "1h").'),
      since: timeArg.optional().describe('Default "24h".'),
      until: timeArg.optional(),
    },
    async (a) => {
      const c = await resolveCoin(client, a.coin);
      const { start, end } = window(a, "24h");
      const rows = (await client.info<Obj[]>({ type: "openInterestHistory", coin: c, interval: a.interval ?? "1h", startTime: start, endTime: end })) ?? [];
      const first = rows[0], last = rows[rows.length - 1];
      return {
        coin: c,
        buckets: rows.length,
        changePct: first && last && num(first.oiOpen) ? round(((num(last.oiClose) - num(first.oiOpen)) / num(first.oiOpen)) * 100) : null,
        latestUsd: last ? round(num(last.oiUsd)) : null,
        rows: rows.map((r) => ({ time: iso(r.t), openInterest: num(r.oiClose), openInterestUsd: r.oiUsd == null ? null : round(num(r.oiUsd)) })),
      };
    },
  );

  add(
    "hydromancer_recent_liquidations",
    "Recent liquidations",
    "Positions that were force-closed (liquidated), newest first, for one market or the whole exchange, with totals by side. \"Long liquidated\" means a long position was wiped out. Default window: last 24h.",
    { coin: coin.optional().describe("Market to check; omit for every market."), since: timeArg.optional().describe('Default "24h".'), until: timeArg.optional(), limit: limit(50, 1000) },
    async (a) => {
      const c = a.coin ? await resolveCoin(client, a.coin) : undefined;
      const { start, end } = window(a, "24h");
      const rows = ((await client.info<Obj[]>({ type: "liquidationHistoryByTime", coin: c, startTime: start, endTime: end, limit: 1000 })) ?? []).sort((x, y) => y.time - x.time);
      let longUsd = 0, shortUsd = 0;
      const byCoin: Record<string, number> = {};
      for (const r of rows) {
        const v = num(r.px) * num(r.sz);
        if (r.side === "A") longUsd += v; else shortUsd += v;
        byCoin[r.coin] = round((byCoin[r.coin] ?? 0) + v);
      }
      const topCoins = Object.entries(byCoin).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, v]) => ({ coin: k, liquidatedUsd: v }));
      return {
        window: { from: iso(start), to: iso(end ?? Date.now()) },
        totals: { liquidations: rows.length, longsLiquidatedUsd: round(longUsd), shortsLiquidatedUsd: round(shortUsd), topCoins },
        note: rows.length >= 1000 ? "Capped at the 1,000 most recent liquidations; narrow the window or pick a coin for full totals." : undefined,
        liquidations: rows.slice(0, a.limit ?? 50).map((r) => ({
          time: iso(r.time),
          coin: r.coin,
          liquidated: r.side === "A" ? "long" : "short",
          address: r.user ?? r.liquidation?.liquidatedUser ?? null,
          price: num(r.px),
          size: num(r.sz),
          valueUsd: round(num(r.px) * num(r.sz)),
          realizedPnlUsd: round(num(r.closedPnl)),
        })),
      };
    },
  );

  add(
    "hydromancer_market_depth",
    "Order book depth and slippage",
    "How much can be bought or sold near the current price. Returns USD depth on each side within 0.1% to 2% of the price for a market, plus the expected slippage for a market order of a given size over time.",
    {
      coin,
      orderSizeUsd: z.number().positive().optional().describe("Order size for the slippage estimate, in USD (default 100,000)."),
      since: timeArg.optional().describe('Slippage history window. Default "24h".'),
    },
    async (a) => {
      const c = await resolveCoin(client, a.coin);
      const { start } = window(a, "24h");
      const [depth, slip] = await Promise.all([
        client.info<Obj>({ type: "currentDepth" }),
        client.info<Obj[]>({ type: "slippageHistory", coin: c, amount: a.orderSizeUsd ?? 100_000, startTime: start, limit: 2000 }).catch(() => []),
      ]);
      const bare = c.includes(":") ? c.split(":")[1] : c;
      const row = (depth?.data ?? []).find((d: Obj) => d.coin === c || d.coin === bare);
      const s = slip ?? [];
      const avg = (k: string) => (s.length ? round(s.reduce((t, r) => t + num(r[k]), 0) / s.length, 2) : null);
      return {
        coin: c,
        depthAt: depth?.timestampMs ? iso(depth.timestampMs) : null,
        depth: row ? row.levels.map((l: Obj) => ({ withinPct: l.bps / 100, bidDepthUsd: round(l.bidDepthUsd), askDepthUsd: round(l.askDepthUsd) })) : "No depth data for this market.",
        slippage: {
          orderSizeUsd: a.orderSizeUsd ?? 100_000,
          samples: s.length,
          averageBuyBps: avg("buySlippageBps"),
          averageSellBps: avg("sellSlippageBps"),
          latest: s.length ? { time: iso(s[s.length - 1].timestamp), buyBps: s[s.length - 1].buySlippageBps, sellBps: s[s.length - 1].sellSlippageBps } : null,
          bpsMeaning: "1 bps = 0.01% of the order value.",
        },
      };
    },
  );

  add(
    "hydromancer_list_markets",
    "List every market and HIP-3 exchange",
    "Lists every tradable perp market, optionally filtered by search text or category (crypto, stocks, indices, commodities, fx), plus the HIP-3 exchanges (perp DEXs) that list stocks and other assets. Use when unsure of a market's exact name.",
    {
      search: z.string().optional().describe('Text to search for, e.g. "tsla", "gold", "pepe".'),
      category: z.enum(["crypto", "stocks", "indices", "commodities", "fx"]).optional(),
      limit: limit(100, 2000),
    },
    async (a) => {
      const [mids, cats, dexs] = await Promise.all([
        client.info<Record<string, string>>({ type: "allMids", dex: "ALL_DEXS" }),
        client.info<[string, string][]>({ type: "perpCategories" }).catch(() => []),
        client.info<(Obj | null)[]>({ type: "perpDexs" }).catch(() => []),
      ]);
      const catMap = new Map((cats ?? []).map(([k, v]) => [k, v]));
      let rows = Object.entries(mids ?? {})
        .filter(([k]) => !k.startsWith("@") && !k.startsWith("#"))
        .map(([k, v]) => ({ market: k, exchange: k.includes(":") ? k.split(":")[0] : "hyperliquid", category: catMap.get(k) ?? (k.includes(":") ? null : "crypto"), midPrice: num(v) }));
      if (a.search) rows = rows.filter((r) => r.market.toLowerCase().includes(a.search.toLowerCase()));
      if (a.category) rows = rows.filter((r) => r.category === a.category || (a.category === "fx" && r.category === "currencies"));
      rows.sort((x, y) => x.market.localeCompare(y.market));
      return {
        hip3Exchanges: ((dexs ?? []).filter(Boolean) as Obj[]).map((d) => ({ name: d.name, fullName: d.fullName, markets: (d.assetToStreamingOiCap ?? []).length })),
        totalMatches: rows.length,
        markets: rows.slice(0, a.limit ?? 100),
      };
    },
  );

  // ---------- Builders ----------
  add(
    "hydromancer_builder_activity",
    "Builder app activity (trades routed through an app)",
    `Fills routed through a builder (a trading app such as MetaMask, Phantom or a Telegram bot) by its builder address, with volume, builder fees earned, unique traders and top coins. Default window: last 1h (busy builders produce thousands of fills). since/until accept ${timeDescription}`,
    { builder: address.describe("Builder (app) address."), since: timeArg.optional().describe('Default "1h".'), until: timeArg.optional(), limit: limit(25, 2000) },
    async (a) => {
      const { start, end } = window(a, "1h");
      const rows = (await client.info<Obj[]>({ type: "builderFillsByTime", builder: a.builder, startTime: start, endTime: end, limit: 2000 })) ?? [];
      const users = new Set(rows.map((r) => r.user));
      let vol = 0, fee = 0;
      const byCoin: Record<string, number> = {};
      for (const r of rows) {
        const v = num(r.px) * num(r.sz);
        vol += v; fee += num(r.builderFee);
        byCoin[r.coin] = (byCoin[r.coin] ?? 0) + v;
      }
      return {
        window: { from: iso(start), to: iso(end ?? Date.now()) },
        totals: {
          fills: rows.length,
          uniqueTraders: users.size,
          volumeUsd: round(vol),
          builderFeesEarned: round(fee),
          topCoins: Object.entries(byCoin).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, v]) => ({ coin: k, volumeUsd: round(v) })),
        },
        note: rows.length >= 2000 ? "Hit the 2,000-fill limit per request; totals cover only the newest 2,000 fills. Use a shorter window." : undefined,
        latestFills: rows.slice(-(a.limit ?? 25)).reverse().map(compactFill),
      };
    },
  );

  // ---------- Prediction markets ----------
  add(
    "hydromancer_prediction_markets",
    "Prediction markets (HIP-4 outcomes)",
    "Settled Hyperliquid prediction markets (HIP-4 outcomes) with their result and trading stats, searchable by text, underlying asset or category.",
    {
      search: z.string().optional().describe('Free text, e.g. "election", "BTC above".'),
      underlying: z.string().optional().describe('Underlying asset, e.g. "HYPE", "BTC".'),
      category: z.string().optional().describe('Category, e.g. "sports", "politics".'),
      limit: limit(20, 100),
    },
    async (a) => {
      const res = await client.info<Obj>({ type: "settledOutcomes", limit: a.limit ?? 20, search: a.search, underlying: a.underlying, category: a.category });
      return {
        hasMore: res?.hasMore,
        outcomes: (res?.outcomes ?? []).map((o: Obj) => ({
          id: o.outcomeId,
          name: o.name,
          description: o.description,
          category: o.category,
          underlying: o.underlying,
          result: o.settleFraction === "1" ? "YES" : o.settleFraction === "0" ? "NO" : o.settleFraction,
          yesVolumeUsd: o.yesStats ? round(num(o.yesStats.volumeNotional)) : null,
          yesTraders: o.yesStats?.uniqueTraders ?? null,
        })),
      };
    },
  );

  // ---------- Account / advanced ----------
  add(
    "hydromancer_my_usage",
    "My Hydromancer API usage",
    "Your own Hydromancer API usage by day and request type: requests, failures, speed and billable tokens. Use to check how much of your plan you are using.",
    { days: z.number().int().min(1).max(90).optional().describe("Days to look back (default 7).") },
    async ({ days }) => {
      const rows = (await client.info<Obj[]>({ type: "apiUsage", days: days ?? 7 })) ?? [];
      const tokens = rows.reduce((s, r) => s + num(r.tokens_consumed), 0);
      const reqs = rows.reduce((s, r) => s + num(r.total_requests), 0);
      return { days: days ?? 7, totalRequests: reqs, tokensConsumed: tokens, rows };
    },
  );

  add(
    "hydromancer_raw_request",
    "Advanced: any Hydromancer API request",
    "Send any Hydromancer /info request directly, for endpoints the other tools do not cover (e.g. vaultSummaries, historicalOrders, spotMeta, outcomeMeta, delegations, perpDexStatus). Pass the request body as JSON including \"type\". Full list: https://docs.hydromancer.xyz/llms.txt . Read-only: this server never places orders.",
    {
      body: z.record(z.string(), z.any()).describe('Request body, e.g. {"type":"vaultSummaries"} or {"type":"historicalOrders","user":"0x..."}.'),
      limit: limit(200, 5000),
    },
    async ({ body, limit: lim }) => {
      if (typeof body?.type !== "string") throw new Error('The body must include a "type" field, e.g. {"type":"meta"}.');
      const res = await client.info<unknown>(body as { type: string });
      if (Array.isArray(res)) {
        const p = page(res, lim ?? 200);
        return { paging: p.paging, rows: p.rows };
      }
      return res;
    },
  );

  return names;
}
