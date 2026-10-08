import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTime } from "../src/time.js";
import { HydromancerClient } from "../src/client.js";

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
