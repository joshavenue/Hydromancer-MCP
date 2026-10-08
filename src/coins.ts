/**
 * Coin name resolution. Users type "btc", "$ETH", "BTC-PERP", "ETHUSDT", "xyz:tsla" or "kpepe";
 * Hyperliquid wants exact names such as "BTC", "kPEPE" or "xyz:TSLA". We resolve against the
 * live list of every market (allMids across all dexes), cached for 10 minutes.
 */
import type { HydromancerClient } from "./client.js";

const TTL_MS = 10 * 60_000;
let cache: { at: number; names: Map<string, string> } | null = null;

async function marketNames(client: HydromancerClient): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.names;
  const mids = await client.info<Record<string, string>>({ type: "allMids", dex: "ALL_DEXS" });
  const names = new Map<string, string>();
  for (const name of Object.keys(mids ?? {})) {
    if (name.startsWith("@") || name.startsWith("#")) continue; // spot pair / outcome ids
    names.set(name.toLowerCase(), name);
  }
  cache = { at: Date.now(), names };
  return names;
}

function candidates(raw: string): string[] {
  const s = raw.trim().replace(/^\$/, "");
  const out = [s];
  const stripped = s.replace(/[-_/ ]?(perp|perps|usdc|usdt|usd)$/i, "");
  if (stripped && stripped !== s) out.push(stripped);
  return out;
}

/** Resolve one user-typed coin to the exact market name. Unknown names are passed through unchanged. */
export async function resolveCoin(client: HydromancerClient, raw: string): Promise<string> {
  if (!raw) return raw;
  let names: Map<string, string>;
  try {
    names = await marketNames(client);
  } catch {
    return raw.trim();
  }
  for (const c of candidates(raw)) {
    const hit = names.get(c.toLowerCase());
    if (hit) return hit;
  }
  return raw.trim();
}

export async function resolveCoins(client: HydromancerClient, raws: string[]): Promise<string[]> {
  return Promise.all(raws.map((r) => resolveCoin(client, r)));
}

/** For tests. */
export function _resetCoinCache(): void {
  cache = null;
}
