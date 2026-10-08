/**
 * End-to-end check: start the built server over stdio exactly like an AI app does,
 * list tools, call every tool against the live API, and report pass/fail per tool.
 * Needs HYDROMANCER_API_KEY in the environment. Never prints the key.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const WHALE = process.env.SMOKE_ADDRESS ?? "0xde8d9e530b0528ffa7b1190f862536c055dd9524";
const BUILDER = "0xe95a5e31904e005066614247d309e00d8ad753aa"; // MetaMask

const calls: Array<[string, Record<string, unknown>, (text: string) => boolean]> = [
  ["hydromancer_wallet_overview", { address: WHALE }, (t) => t.includes("accountValueUsd") && t.includes("tradingRecord")],
  ["hydromancer_wallet_overview", { address: WHALE, includeHip3: true }, (t) => t.includes("native")],
  ["hydromancer_compare_wallets", { addresses: [WHALE, "0x77ddcc4b6440b3a32b7802f053105c2fad3ae0e9"] }, (t) => t.includes('"returned": 2')],
  ["hydromancer_wallet_trades", { address: WHALE, since: "90d" }, (t) => t.includes("totals")],
  ["hydromancer_wallet_closed_trades", { address: WHALE, since: "120d" }, (t) => t.includes("winRatePct")],
  ["hydromancer_wallet_open_orders", { address: WHALE }, (t) => t.includes("openOrders")],
  ["hydromancer_wallet_transfers", { address: "0x77ddcc4b6440b3a32b7802f053105c2fad3ae0e9", since: "30d" }, (t) => t.includes("events")],
  ["hydromancer_wallet_funding", { address: WHALE }, (t) => t.includes("totalUsd")],
  ["hydromancer_top_traders", { period: "7d", limit: 5 }, (t) => t.includes('"rank": 1')],
  ["hydromancer_top_traders", { period: "30d", rankBy: "volume", market: "xyz", limit: 3 }, (t) => t.includes('"rank": 1')],
  ["hydromancer_market_snapshot", {}, (t) => t.includes('"coin": "BTC"')],
  ["hydromancer_market_snapshot", { coins: ["btc", "$eth", "ETH-PERP", "xyz:tsla"] }, (t) => t.includes('"coin": "ETH"') && t.includes("xyz:TSLA") && !t.includes("Unknown market")],
  ["hydromancer_price_history", { coin: "hype", interval: "1h", since: "24h" }, (t) => t.includes("changePct")],
  ["hydromancer_funding_history", { coin: "BTC", since: "3d" }, (t) => t.includes("annualizedPct")],
  ["hydromancer_open_interest_history", { coin: "ETH" }, (t) => t.includes("latestUsd")],
  ["hydromancer_recent_liquidations", { since: "6h" }, (t) => t.includes("longsLiquidatedUsd")],
  ["hydromancer_recent_liquidations", { coin: "btc", since: "24h", limit: 5 }, (t) => t.includes("longsLiquidatedUsd")],
  ["hydromancer_market_depth", { coin: "BTC", orderSizeUsd: 250000 }, (t) => t.includes("bidDepthUsd")],
  ["hydromancer_list_markets", { search: "tsla" }, (t) => t.includes("xyz:TSLA")],
  ["hydromancer_builder_activity", { builder: BUILDER, since: "30m" }, (t) => t.includes("builderFeesEarned")],
  ["hydromancer_prediction_markets", { limit: 3 }, (t) => t.includes("outcomes")],
  ["hydromancer_my_usage", { days: 2 }, (t) => t.includes("tokensConsumed")],
  ["hydromancer_raw_request", { body: { type: "exchangeStatus" } }, (t) => t.includes("time")],
];

// Inputs that must fail with a clear message instead of crashing.
const negatives: Array<[string, Record<string, unknown>, RegExp]> = [
  ["hydromancer_wallet_overview", { address: "not-an-address" }, /0x|address/i],
  ["hydromancer_price_history", { coin: "BTC", since: "yesterday-ish" }, /Could not understand the time/],
  ["hydromancer_raw_request", { body: { foo: 1 } }, /"type"/],
];

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { PATH: process.env.PATH ?? "", HYDROMANCER_API_KEY: process.env.HYDROMANCER_API_KEY ?? "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(transport);
  const info = client.getServerVersion();
  const tools = (await client.listTools()).tools;
  const prompts = (await client.listPrompts()).prompts;
  console.log(`server ${info?.name} ${info?.version}: ${tools.length} tools, ${prompts.length} prompt(s)`);
  for (const t of tools) if (!t.annotations?.readOnlyHint) throw new Error(`${t.name} is not marked read-only`);

  let pass = 0, failN = 0;
  const covered = new Set<string>();
  for (const [name, args, check] of calls) {
    const t0 = Date.now();
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    const good = !r.isError && check(text);
    covered.add(name);
    good ? pass++ : failN++;
    console.log(`${good ? "PASS" : "FAIL"} ${String(Date.now() - t0).padStart(5)}ms ${String(text.length).padStart(6)}ch ${name} ${JSON.stringify(args).slice(0, 70)}${good ? "" : "\n     " + text.slice(0, 400)}`);
  }
  for (const [name, args, re] of negatives) {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    const good = Boolean(r.isError) && re.test(text);
    good ? pass++ : failN++;
    console.log(`${good ? "PASS" : "FAIL"} error-path ${name}: ${text.replace(/\s+/g, " ").slice(0, 140)}`);
  }
  const missing = tools.map((t) => t.name).filter((n) => !covered.has(n));
  console.log(`\n${pass} passed, ${failN} failed; tools not exercised: ${missing.length ? missing.join(", ") : "none"}`);
  await client.close();
  process.exit(failN || missing.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
