/**
 * Server-only Supabase client using the service role. Every read and write of
 * business data goes through server routes; the browser never gets this key.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfig } from "./env";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;
  const { url, serviceRoleKey } = supabaseConfig();
  client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

/**
 * Throws on a Supabase error so callers never silently continue. The client is
 * untyped (no generated schema), so rows come back as loose records.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function must<T = any>(result: { data: unknown; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.data === null || result.data === undefined) throw new Error(`${what}: no data`);
  return result.data as T;
}
