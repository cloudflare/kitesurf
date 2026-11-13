// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A comment ends at its first `-->`. A lazy `<!--[\s\S]*?-->` may span several comments and
// backtracks exponentially on `<!----><!---->…` without a doctype.
const LEADING_COMMENTS = String.raw`(?:\s|<!--(?:(?!-->)[\s\S])*-->)*`;
const SOURCE_DOCTYPE = new RegExp(String.raw`^(${LEADING_COMMENTS})(<!doctype\b[^>]*>)`, "i");
const LEADING_DOCTYPE = new RegExp(String.raw`^${LEADING_COMMENTS}<!doctype\b`, "i");

export function leadsWithDoctype(html: string): boolean {
  return LEADING_DOCTYPE.test(html);
}

export function sourceDoctypeOf(html: string): { markup: string; end: number } | null {
  const match = html.match(SOURCE_DOCTYPE);
  const raw = match?.[2];
  if (!raw) return null;
  const prefix = match?.[1] ?? "";
  const end = prefix.length + raw.length;

  const body = raw.slice("<!doctype".length, -1).trim();
  const parsed = body.match(
    /^([^\s>]+)(?:\s+(PUBLIC|SYSTEM)\s+(?:"([^"]*)"|'([^']*)')(?:\s+(?:"([^"]*)"|'([^']*)'))?)?$/i,
  );
  if (!parsed) return { markup: raw, end };

  const name = parsed[1]?.toLowerCase() ?? "html";
  const keyword = parsed[2]?.toUpperCase();
  const firstId = parsed[3] ?? parsed[4];
  const secondId = parsed[5] ?? parsed[6];
  const quote = (value: string) => (value.includes('"') ? `'${value}'` : `"${value}"`);
  if (keyword === "PUBLIC" && firstId !== undefined) {
    const system = secondId === undefined ? "" : ` ${quote(secondId)}`;
    return {
      markup: `<!DOCTYPE ${name} PUBLIC ${quote(firstId)}${system}>`,
      end,
    };
  }
  if (keyword === "SYSTEM" && firstId !== undefined) {
    return {
      markup: `<!DOCTYPE ${name} SYSTEM ${quote(firstId)}>`,
      end,
    };
  }
  return { markup: `<!DOCTYPE ${name}>`, end };
}
