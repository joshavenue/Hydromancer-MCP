/**
 * Keep tool results small enough for a model to read. Lists are paged with limit/offset,
 * and any result is hard-capped with an explicit note so the model knows data was cut.
 */

export const MAX_RESULT_CHARS = Number(process.env.HYDROMANCER_MAX_RESULT_CHARS ?? 40_000);

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function page<T>(rows: T[], limit: number, offset = 0): { rows: T[]; paging: { total: number; offset: number; returned: number; hasMore: boolean } } {
  const slice = rows.slice(offset, offset + limit);
  return { rows: slice, paging: { total: rows.length, offset, returned: slice.length, hasMore: offset + slice.length < rows.length } };
}

export function ok(payload: unknown): ToolResult {
  let text = JSON.stringify(payload, null, 1);
  if (text.length > MAX_RESULT_CHARS) {
    text =
      text.slice(0, MAX_RESULT_CHARS) +
      `\n...[TRUNCATED: result was ${text.length} characters, cut to ${MAX_RESULT_CHARS}. Ask again with a smaller limit, a shorter time range, or one coin/address.]`;
  }
  return { content: [{ type: "text", text }] };
}

export function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

export const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const round = (n: number, dp = 2): number => Math.round(n * 10 ** dp) / 10 ** dp;
