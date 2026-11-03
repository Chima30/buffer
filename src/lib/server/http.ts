import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const fail = (status: number, error: string, details?: unknown) => json({ error, details }, status);

export const hashToken = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
export const newToken = () => randomBytes(24).toString("hex");

export function tokenMatches(given: string | null, storedHash: string): boolean {
  if (!given) return false;
  const a = Buffer.from(hashToken(given), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function secretMatches(given: string | null, secret: string): boolean {
  if (!given) return false;
  const a = Buffer.from(hashToken(given), "hex");
  const b = Buffer.from(hashToken(secret), "hex");
  return timingSafeEqual(a, b);
}
