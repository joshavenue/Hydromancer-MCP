import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HydromancerClient } from "./client.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "hydromancer-mcp";
export const SERVER_VERSION = "0.2.0";

export const INSTRUCTIONS =
  "Read-only Hyperliquid data from the Hydromancer API: wallets (positions, trades, closed trades, orders, transfers, funding), " +
  "top-trader leaderboards with bot filters, live market stats, candles, funding, open interest, liquidations, order-book depth, " +
  "builder app activity and prediction markets. Start with hydromancer_wallet_overview for a wallet, hydromancer_top_traders for " +
  "\"who is winning\", hydromancer_market_snapshot for prices. Times accept \"24h\"/\"7d\" or dates. Never places trades.";

export const GUIDE_MD = `# Hydromancer MCP: which tool to use

| Question | Tool |
|---|---|
| What is this wallet holding? Is it a good trader? | hydromancer_wallet_overview |
| What did this wallet trade today / this week? | hydromancer_wallet_trades |
| Win rate, best coin, average hold time | hydromancer_wallet_closed_trades |
| Where are its stop-losses / take-profits? | hydromancer_wallet_open_orders |
| Deposits, withdrawals, liquidations of a wallet | hydromancer_wallet_transfers |
| Funding a wallet paid or received | hydromancer_wallet_funding |
| Many wallets at once (watchlist, whales) | hydromancer_compare_wallets |
| Best traders this week/month, without bots | hydromancer_top_traders |
| Price, volume, open interest, funding now | hydromancer_market_snapshot |
| Price chart data | hydromancer_price_history |
| Funding rate history | hydromancer_funding_history |
| Open interest trend | hydromancer_open_interest_history |
| Who got liquidated? | hydromancer_recent_liquidations |
| Liquidity / slippage for a trade size | hydromancer_market_depth |
| Exact market names, HIP-3 stock markets | hydromancer_list_markets |
| Volume and fees of a builder app | hydromancer_builder_activity |
| Prediction market results | hydromancer_prediction_markets |
| My API plan usage | hydromancer_my_usage |
| Anything else in the API | hydromancer_raw_request |

Recipes
- Find whales worth following: hydromancer_top_traders (period 30d) -> hydromancer_compare_wallets with the addresses -> hydromancer_wallet_overview on the biggest.
- Judge a trader: hydromancer_wallet_overview -> hydromancer_wallet_closed_trades (90d).
- Market mood: hydromancer_market_snapshot -> hydromancer_open_interest_history -> hydromancer_recent_liquidations.

Rules
- Read-only. Nothing here can place, cancel or sign orders.
- Mainnet only. HIP-3 markets use a prefix: xyz:TSLA, xyz:XYZ100.
- Times: "30m", "24h", "7d", "2026-10-01" or ISO date-times. Results are UTC.
- Large results are paged; ask for fewer rows or a shorter window when a result says TRUNCATED.
`;

export function createServer(client: HydromancerClient = new HydromancerClient()): { server: McpServer; tools: string[] } {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const tools = registerTools(server, client);
  server.registerPrompt(
    "hydromancer_guide",
    { title: "Hydromancer tool guide", description: "Which Hydromancer tool answers which question, plus recipes." },
    async () => ({ messages: [{ role: "user", content: { type: "text", text: GUIDE_MD } }] }),
  );
  server.registerResource(
    "hydromancer_guide",
    "hydromancer://guide",
    { title: "Hydromancer tool guide", mimeType: "text/markdown" },
    async (uri: URL) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE_MD }] }),
  );
  return { server, tools };
}
