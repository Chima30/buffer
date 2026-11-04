/**
 * npm run nras  -> fetches a fresh attestation for NEARAI_MODEL and asks NVIDIA
 * NRAS to verify the GPU evidence of each node in it. Read-only; costs nothing.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { getAttestation } = await import("../src/lib/server/nearai");
  const { gpuCandidates, verifyGpuAttestation } = await import("../src/lib/server/nras");
  const model = process.env.NEARAI_MODEL;
  const att = await getAttestation(model);
  const nodes = gpuCandidates(att.report);
  console.log(`Model ${model}: ${nodes.length} node(s) with GPU evidence`);
  for (const n of nodes.slice(0, 3)) {
    const r = await verifyGpuAttestation(att.report, att.nonce, n.signing_address ?? null);
    console.log(`${r.verdict === "PASS" ? "PASS" : r.verdict}  ${n.signing_address}  ${r.detail}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
