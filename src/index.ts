#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HydromancerClient } from "./client.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const USAGE = `${SERVER_NAME} ${SERVER_VERSION}
MCP server for the Hydromancer Hyperliquid API (read-only).

Usage: hydromancer-mcp            start over stdio (what AI apps run)
       hydromancer-mcp --version
       hydromancer-mcp --help

Environment:
  HYDROMANCER_API_KEY        required, your Hydromancer API key
  HYDROMANCER_BASE_URL       optional, default https://api.hydromancer.xyz/info
  HYDROMANCER_TIMEOUT_MS     optional, default 30000
  HYDROMANCER_MAX_RESULT_CHARS optional, default 40000
`;

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h") return void process.stdout.write(USAGE);
  if (arg === "--version" || arg === "-v") return void process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);

  // stdout carries the protocol: send stray logs to stderr.
  for (const k of ["log", "info", "debug"] as const) console[k] = (...a: unknown[]) => console.error(...a);

  const client = new HydromancerClient();
  if (!client.hasKey()) {
    process.stderr.write(`${SERVER_NAME}: warning, HYDROMANCER_API_KEY is not set; tools will explain how to add it.\n`);
  }
  const { server, tools } = createServer(client);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION}: ${tools.length} read-only tools ready on stdio\n`);
  const stop = () => void server.close().finally(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  process.stderr.write(`${SERVER_NAME}: fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
