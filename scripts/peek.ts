/** Print one tool result: npx tsx scripts/peek.ts <tool> '<json args>' */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [name, args = "{}", max = "3000"] = process.argv.slice(2);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { PATH: process.env.PATH ?? "", HYDROMANCER_API_KEY: process.env.HYDROMANCER_API_KEY ?? "" },
  stderr: "ignore",
});
const client = new Client({ name: "peek", version: "0" });
await client.connect(transport);
const r: any = await client.callTool({ name, arguments: JSON.parse(args) });
console.log((r.isError ? "ERROR " : "") + (r.content?.[0]?.text ?? "").slice(0, Number(max)));
await client.close();
