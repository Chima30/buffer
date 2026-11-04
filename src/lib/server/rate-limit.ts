/**
 * Small fixed-window rate limit for public endpoints, keyed by client IP and
 * stored in Supabase (rate_limits), so it holds across serverless instances.
 * It fails open on database errors: limits protect credits, not money.
 */
import { createHash } from "node:crypto";
import { db } from "./db";
import { fail } from "./http";

export async function rateLimit(req: Request, bucket: string, max: number, windowSec: number): Promise<Response | null> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
  const key = createHash("sha256").update(`${bucket}:${ip}`).digest("hex").slice(0, 32);
  const windowStart = new Date(Math.floor(Date.now() / (windowSec * 1000)) * windowSec * 1000).toISOString();
  const { data, error } = await db().rpc("hit_rate_limit", { p_key: key, p_window: windowStart });
  if (error) return null;
  return Number(data) > max ? fail(429, "Too many requests; please wait a while and try again") : null;
}
