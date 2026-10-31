/**
 * Minimal Hydromancer REST client: POST https://api.hydromancer.xyz/info with a Bearer key.
 * Errors are turned into plain-English messages a model can relay to a non-technical user.
 */

export const DEFAULT_BASE_URL = "https://api.hydromancer.xyz/info";
const ALLOWED_HOSTS = new Set(["api.hydromancer.xyz", "api-testnet.hydromancer.xyz"]);
// Cloudflare in front of the API rejects default library user agents (error 1010).
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 hydromancer-mcp/0.2.1";

export class HydromancerError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "HydromancerError";
  }
}

export type InfoBody = { type: string } & Record<string, unknown>;

export interface ClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Only HTTPS Hydromancer API hosts are accepted, so the key can never be sent anywhere else. */
export function resolveBaseUrl(raw: string): string {
  const refused = new HydromancerError(
    "HYDROMANCER_BASE_URL must be https://api.hydromancer.xyz/info or https://api-testnet.hydromancer.xyz/info. " +
      "Other hosts are refused so your API key stays private.",
  );
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw refused;
  }
  const path = url.pathname.replace(/\/+$/, "");
  const clean = !url.username && !url.password && !url.search && !url.hash;
  const port = url.port === "" || url.port === "443";
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || !port || !clean || (path !== "" && path !== "/info")) {
    throw refused;
  }
  return `https://${url.hostname}/info`;
}

/** Hide the key, plain or JSON-escaped, in text from outside this process. */
function maskKey(text: string, apiKey: string): string {
  // A key this short can't be real, and masking it would scramble normal responses.
  if (apiKey.length < 8) return text;
  return text.replaceAll(apiKey, "***").replaceAll(JSON.stringify(apiKey).slice(1, -1), "***");
}

export class HydromancerClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.HYDROMANCER_API_KEY;
    this.baseUrl = opts.baseUrl ?? process.env.HYDROMANCER_BASE_URL ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.HYDROMANCER_TIMEOUT_MS ?? 30_000);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  hasKey(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim());
  }

  async info<T = unknown>(body: InfoBody): Promise<T> {
    if (!this.hasKey()) {
      throw new HydromancerError(
        "No Hydromancer API key is set. Add HYDROMANCER_API_KEY to this MCP server's env settings " +
          "(get a key at https://docs.hydromancer.xyz/readme/get-api-keys), then restart your AI app.",
      );
    }
    const baseUrl = resolveBaseUrl(this.baseUrl);
    const apiKey = this.apiKey!.trim();
    // A key with stray characters would be echoed in fetch's own error text.
    if (!/^[\x21-\x7E]+$/.test(apiKey)) {
      throw new HydromancerError("HYDROMANCER_API_KEY has invalid characters. Copy it again and restart your AI app.");
    }
    // Drop undefined fields so optional parameters are simply omitted.
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    let res: Response;
    try {
      res = await this.fetchImpl(baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(clean),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new HydromancerError(`Hydromancer did not answer within ${this.timeoutMs / 1000}s. Try a shorter time range or a smaller limit.`);
      }
      throw new HydromancerError(`Could not reach Hydromancer (${maskKey(e.message, apiKey)}). Check the internet connection.`);
    }
    const text = maskKey(await res.text(), apiKey);
    if (!res.ok) throw new HydromancerError(explainStatus(res.status, text, clean.type as string), res.status);
    if (text.trim() === "" || text.trim() === "null") return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HydromancerError(`Hydromancer returned a non-JSON response for "${clean.type}". This request type is not supported by this tool.`);
    }
  }
}

function explainStatus(status: number, text: string, type: string): string {
  const detail = text.replace(/\s+/g, " ").trim().slice(0, 300);
  switch (status) {
    case 401:
    case 403:
      return `Hydromancer refused the API key (HTTP ${status}). The key may be wrong, expired, or not allowed to use "${type}" (some endpoints are paid add-ons). Server said: ${detail}`;
    case 429:
      return `Rate limit reached (HTTP 429). Your plan's per-minute budget is used up; wait a minute and try again, or ask for less data. Server said: ${detail}`;
    case 400:
    case 422:
      return `Hydromancer rejected the request for "${type}" (HTTP ${status}). Usually a wrong coin name, address or time range. Server said: ${detail}`;
    default:
      if (status >= 500) return `Hydromancer had a server error (HTTP ${status}). Try again shortly. Server said: ${detail}`;
      return `Hydromancer returned HTTP ${status} for "${type}". Server said: ${detail}`;
  }
}
