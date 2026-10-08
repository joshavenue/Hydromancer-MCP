/**
 * Minimal Hydromancer REST client: POST https://api.hydromancer.xyz/info with a Bearer key.
 * Errors are turned into plain-English messages a model can relay to a non-technical user.
 */

export const DEFAULT_BASE_URL = "https://api.hydromancer.xyz/info";
// Cloudflare in front of the API rejects default library user agents (error 1010).
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 hydromancer-mcp/0.1.0";

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
    // Drop undefined fields so optional parameters are simply omitted.
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey!.trim()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(clean),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new HydromancerError(`Hydromancer did not answer within ${this.timeoutMs / 1000}s. Try a shorter time range or a smaller limit.`);
      }
      throw new HydromancerError(`Could not reach Hydromancer (${e.message}). Check the internet connection.`);
    }
    const text = await res.text();
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
