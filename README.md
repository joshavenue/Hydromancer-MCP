# Hydromancer MCP

Ask your AI about Hyperliquid in plain English, using live data from the [Hydromancer API](https://hydromancer.xyz).

> "What is this wallet holding, and is it a good trader?"
> "Who were the best traders this week, without bots?"
> "Who got liquidated in the last 6 hours?"
> "How much BTC can I sell before the price moves 0.5%?"

Your AI picks the right tool, calls Hydromancer and explains the answer. You don't need to read API docs, write code or work out timestamps.

- **19 read-only tools**: wallets, trades, top traders, markets, liquidations, builders, prediction markets
- **Works with any MCP app**: Claude Desktop, Claude Code, Cursor, Codex, VS Code (Copilot), Gemini CLI, Windsurf, Cline and others
- **Friendly inputs**: coin names in any case (`btc`, `$ETH`, `ETH-PERP`, `xyz:tsla`), times like `24h`, `7d` or `2026-10-01`
- **Safe**: read-only. It cannot place, cancel or sign orders, and it never touches funds or private keys
- **Your key stays local**: it is read from your app's settings and never sent anywhere except `api.hydromancer.xyz`

## 1. Get a Hydromancer API key

See [Get API keys](https://docs.hydromancer.xyz/readme/get-api-keys). Early-stage teams [may qualify for free access](https://docs.hydromancer.xyz/readme/hydromancer-for-early-stage-teams).

## 2. Add it to your AI app

You need [Node.js](https://nodejs.org) 20 or newer. Replace `YOUR_KEY` with your key.

### Claude Desktop

Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "hydromancer": {
      "command": "npx",
      "args": ["-y", "github:joshavenue/Hydromancer-MCP"],
      "env": { "HYDROMANCER_API_KEY": "YOUR_KEY" }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add hydromancer -e HYDROMANCER_API_KEY=YOUR_KEY -- npx -y github:joshavenue/Hydromancer-MCP
```

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project): use the same `mcpServers` block as Claude Desktop.

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.hydromancer]
command = "npx"
args = ["-y", "github:joshavenue/Hydromancer-MCP"]
env = { HYDROMANCER_API_KEY = "YOUR_KEY" }
```

### VS Code (GitHub Copilot)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "hydromancer": {
      "command": "npx",
      "args": ["-y", "github:joshavenue/Hydromancer-MCP"],
      "env": { "HYDROMANCER_API_KEY": "YOUR_KEY" }
    }
  }
}
```

### From a local copy

```bash
git clone https://github.com/joshavenue/Hydromancer-MCP && cd Hydromancer-MCP
npm install && npm run build
```

Then use `"command": "node"` and `"args": ["/full/path/to/Hydromancer-MCP/dist/index.js"]`.

## 3. Ask

Try:

- `Give me an overview of wallet 0x… and tell me if it's a good trader.`
- `Show the top 10 traders by profit over the last 7 days, no bots, then what the top 3 hold right now.`
- `Which of these wallets have more than $1M: 0x…, 0x…, 0x…?`
- `Who got liquidated on Hyperliquid in the last 6 hours? Longs or shorts?`
- `BTC, ETH and HYPE: price, 24h volume and open interest.`
- `Has ETH open interest been rising or falling today?`
- `What's the BTC funding rate averaged over the last week, annualized?`
- `How much did MetaMask's builder earn in fees in the last hour?`

## Tools

| Tool | What it answers |
|---|---|
| `hydromancer_wallet_overview` | Balance, open positions (entry, liquidation price, leverage, PnL), spot balances, trading record, bot score |
| `hydromancer_compare_wallets` | Up to 1,000 wallets in one call, sorted by size |
| `hydromancer_wallet_trades` | Fills in a time window, with volume, PnL, fees and per-coin totals |
| `hydromancer_wallet_closed_trades` | Round-trip trades: win rate, net PnL, hold time, best coin |
| `hydromancer_wallet_open_orders` | Resting limits, stop-losses, take-profits |
| `hydromancer_wallet_transfers` | Deposits, withdrawals, sends, vault moves, liquidations |
| `hydromancer_wallet_funding` | Funding paid or received, per coin |
| `hydromancer_top_traders` | Leaderboard by profit, win rate or volume, with bot and activity filters |
| `hydromancer_market_snapshot` | Price, 24h volume, open interest, max leverage |
| `hydromancer_price_history` | Candles from 1 second to 1 month |
| `hydromancer_funding_history` | Funding rates, average and annualized |
| `hydromancer_open_interest_history` | Open interest trend |
| `hydromancer_recent_liquidations` | Liquidations by market, with long/short totals |
| `hydromancer_market_depth` | Order book depth and slippage for a trade size |
| `hydromancer_list_markets` | Every market, HIP-3 exchanges, search by name or category |
| `hydromancer_builder_activity` | Volume, users and fees for a builder app |
| `hydromancer_prediction_markets` | Settled HIP-4 prediction markets |
| `hydromancer_my_usage` | Your own API usage and tokens |
| `hydromancer_raw_request` | Any other Hydromancer `/info` request |

The server also provides a `hydromancer_guide` prompt and a `hydromancer://guide` resource that tell the AI which tool to use for which question.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `HYDROMANCER_API_KEY` | (required) | Your API key |
| `HYDROMANCER_BASE_URL` | `https://api.hydromancer.xyz/info` | API endpoint |
| `HYDROMANCER_TIMEOUT_MS` | `30000` | Request timeout |
| `HYDROMANCER_MAX_RESULT_CHARS` | `40000` | Cap on one tool result, so the AI is not flooded |

## Good to know

- Each tool call uses your Hydromancer plan's tokens, like any API request. Check usage with `hydromancer_my_usage`.
- Mainnet only. HIP-3 markets use a prefix, for example `xyz:TSLA`.
- Times are UTC. Some endpoints cap a single request (for example 2,000 fills); the tool says so when it happens.

## Development

```bash
npm install
npm run build
npm test                                   # offline unit tests
HYDROMANCER_API_KEY=... npm run smoke      # calls every tool against the live API
```

## License

MIT
