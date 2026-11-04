/**
 * npm run verify -- <order URL or id> [--base https://buffer-zeta.vercel.app] [--rpc <NEAR testnet RPC>]
 *
 * Independently checks one order from public data only (no keys, no .env):
 * NEAR testnet, Ethereum Sepolia, the NEAR MPC contract and NVIDIA's keys.
 * Paste the full order URL (with #t=…) to also check the report you received.
 */
import { verifyOrder } from "../src/lib/verify/order";

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) throw new Error("Usage: npm run verify -- <order URL or id> [--base <site>]");
  let base = args[args.indexOf("--base") + 1] && args.includes("--base") ? args[args.indexOf("--base") + 1] : "https://buffer-zeta.vercel.app";
  let orderId = target;
  let token: string | undefined;
  if (/^https?:\/\//.test(target)) {
    const u = new URL(target);
    base = u.origin;
    orderId = u.pathname.split("/").filter(Boolean).pop() ?? "";
    token = new URLSearchParams(u.hash.slice(1)).get("t") ?? undefined;
  }
  console.log(`Verifying order ${orderId} from ${base} using public chains only\n`);
  const rpc = args.includes("--rpc") ? args[args.indexOf("--rpc") + 1] : undefined;
  const checks = await verifyOrder({ base, orderId, token, nearRpc: rpc });
  let group = "";
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      console.log(`\n${group}`);
    }
    console.log(`  ${c.ok === true ? "PASS" : c.ok === false ? "FAIL" : "n/a "}  ${c.name}: ${c.detail}`);
  }
  const failed = checks.filter((c) => c.ok === false).length;
  const passed = checks.filter((c) => c.ok === true).length;
  console.log(`\n${passed} passed, ${failed} failed, ${checks.length - passed - failed} not checkable`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
