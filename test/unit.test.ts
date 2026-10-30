import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { parseTime } from "../src/time.js";
import { HydromancerClient, HydromancerError, resolveBaseUrl } from "../src/client.js";

const NOW = Date.parse("2026-10-09T00:00:00Z");

test("relative times", () => {
  assert.equal(parseTime("24h", NOW), NOW - 86_400_000);
  assert.equal(parseTime("7d", NOW), NOW - 7 * 86_400_000);
  assert.equal(parseTime("30 minutes ago", NOW), NOW - 30 * 60_000);
  assert.equal(parseTime("now", NOW), NOW);
});

test("dates and epochs", () => {
  assert.equal(parseTime("2026-10-01", NOW), Date.parse("2026-10-01T00:00:00Z"));
  assert.equal(parseTime(1791072000, NOW), 1791072000000);
  assert.equal(parseTime("1791072000000", NOW), 1791072000000);
  assert.equal(parseTime(undefined, NOW), undefined);
  assert.throws(() => parseTime("yesterday-ish", NOW), /Could not understand/);
});

test("missing key gives a plain-English error", async () => {
  const c = new HydromancerClient({ apiKey: "" });
  await assert.rejects(c.info({ type: "meta" }), /No Hydromancer API key/);
});

test("HTTP errors are explained, key is never echoed", async () => {
  const fake = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  const c = new HydromancerClient({ apiKey: "secret-test-key", fetchImpl: fake });
  await assert.rejects(c.info({ type: "meta" }), (e: Error) => /Rate limit/.test(e.message) && !e.message.includes("secret-test-key"));
});

test("undefined fields are dropped from the request body", async () => {
  let sent = "";
  const fake = (async (_u: unknown, init: RequestInit) => {
    sent = String(init.body);
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  const c = new HydromancerClient({ apiKey: "k", fetchImpl: fake });
  await c.info({ type: "userFillsByTime", user: "0x1", endTime: undefined });
  assert.deepEqual(JSON.parse(sent), { type: "userFillsByTime", user: "0x1" });
});

describe("key safety", () => {
  const ok = (async () => new Response("[]")) as unknown as typeof fetch;

  it("accepts only HTTPS Hydromancer hosts", () => {
    assert.equal(resolveBaseUrl("https://api.hydromancer.xyz/info"), "https://api.hydromancer.xyz/info");
    assert.equal(resolveBaseUrl("https://api-testnet.hydromancer.xyz"), "https://api-testnet.hydromancer.xyz/info");
    for (const bad of [
      "http://api.hydromancer.xyz/info",
      "https://evil.example/info",
      "https://api.hydromancer.xyz.evil.example/info",
      "https://docs.hydromancer.xyz/info",
      "https://user:pw@api.hydromancer.xyz/info",
      "https://api.hydromancer.xyz:8443/info",
      "https://api.hydromancer.xyz/other",
      "not a url",
    ]) {
      assert.throws(() => resolveBaseUrl(bad), HydromancerError, bad);
    }
  });

  it("never calls fetch for a refused host", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("[]");
    }) as unknown as typeof fetch;
    const client = new HydromancerClient({ apiKey: "abc", baseUrl: "https://evil.example/info", fetchImpl });
    await assert.rejects(client.info({ type: "x" }), HydromancerError);
    assert.equal(called, false);
  });

  it("refuses a key with stray characters without echoing it", async () => {
    const client = new HydromancerClient({ apiKey: "abc\ndef-secret", fetchImpl: ok });
    await assert.rejects(client.info({ type: "x" }), (err: Error) => !err.message.includes("def-secret"));
  });

  it("masks the key in network errors", async () => {
    const fetchImpl = (async () => {
      throw new Error("failed with abc-secret");
    }) as unknown as typeof fetch;
    const client = new HydromancerClient({ apiKey: "abc-secret", fetchImpl });
    await assert.rejects(client.info({ type: "x" }), (err: Error) => !err.message.includes("abc-secret"));
  });
});
