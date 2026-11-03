/**
 * Registers the agent's OutLayer custody wallet on TESTNET and writes its API
 * key straight into .env.local, so the key is never printed or copied by hand.
 *
 *   npm run outlayer:register
 *
 * Refuses to run if OUTLAYER_API_KEY is already set (no accidental second wallet).
 * The API key is shown by OutLayer only once; this script is the only place it lands.
 */
import { config } from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { OutlayerClient } from "@outlayer/sdk";

const ENV_FILE = ".env.local";
config({ path: ENV_FILE });

const isSet = (v?: string) => !!v && v.trim() !== "" && !v.includes("<");

function setEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
}

async function main() {
  if (!existsSync(ENV_FILE)) throw new Error(".env.local not found. Run this from the project folder.");
  if (process.env.NEAR_NETWORK !== "testnet") throw new Error("NEAR_NETWORK must be testnet.");
  if (isSet(process.env.OUTLAYER_API_KEY)) {
    console.log("OUTLAYER_API_KEY is already set in .env.local. Not registering a second wallet.");
    return;
  }
  const baseUrl = isSet(process.env.OUTLAYER_API_BASE) ? process.env.OUTLAYER_API_BASE!.trim() : "https://testnet-api.outlayer.ai";

  const res = (await OutlayerClient.register({ network: "testnet", baseUrl })) as unknown as Record<string, unknown>;
  const apiKey = (res.apiKey ?? res.api_key) as string | undefined;
  const walletId = (res.walletId ?? res.wallet_id) as string | undefined;
  const nearAccount = (res.nearAccountId ?? res.near_account_id) as string | undefined;
  const handoffUrl = (res.handoffUrl ?? res.handoff_url) as string | undefined;
  if (!apiKey) throw new Error(`Registration response had no API key. Fields: ${Object.keys(res).join(", ")}`);

  let env = readFileSync(ENV_FILE, "utf8");
  env = setEnvLine(env, "OUTLAYER_API_BASE", baseUrl);
  env = setEnvLine(env, "OUTLAYER_API_KEY", apiKey);
  if (walletId) env = setEnvLine(env, "OUTLAYER_WALLET_ID", walletId);
  if (nearAccount) env = setEnvLine(env, "AGENT_ACCOUNT_ID", nearAccount);
  writeFileSync(ENV_FILE, env);

  // The handoff link contains the wallet key, so it goes to a local file rather than the screen.
  if (handoffUrl) writeFileSync("outlayer-handoff-link.txt", `${handoffUrl}\n`);

  console.log("\nOutLayer testnet wallet registered. API key saved to .env.local (not shown).\n");
  console.log(`  Wallet id:          ${walletId ?? "(not returned)"}`);
  console.log(`  Agent NEAR account: ${nearAccount ?? "(not returned; run npm run m0 to read it)"}`);
  if (handoffUrl) {
    console.log("  Policy setup link:  saved to outlayer-handoff-link.txt");
    console.log("\n  That link contains the wallet key. Open it yourself; never share it or paste it in chat.");
  }
  console.log("\nNext: run  npm run m0  to confirm the wallet answers.\n");
}

main().catch((e) => {
  console.error(`Registration failed: ${(e as Error).message}`);
  process.exit(1);
});
