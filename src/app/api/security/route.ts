/** GET /api/security: the latest red-team run (public; it contains no secrets). */
import { connection } from "next/server";
import { latestRedteamRun } from "@/lib/server/redteam";
import { fail, json } from "@/lib/server/http";

export async function GET() {
  await connection();
  try {
    return json({ run: await latestRedteamRun() });
  } catch (e) {
    return fail(500, (e as Error).message);
  }
}
