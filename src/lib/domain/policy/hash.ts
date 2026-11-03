import { hashCanonical } from "../canonical";
import { policyDocumentSchema, type PolicyDocument } from "./schema";

/** sha256 of the canonical JSON of a validated policy document. Anchored on-chain. */
export function policyHash(doc: PolicyDocument): string {
  return hashCanonical(policyDocumentSchema.parse(doc));
}

/** The runtime refuses to act unless the DB policy matches the on-chain anchor. */
export function assertPolicyAnchored(doc: PolicyDocument, onchainHash: string | null): void {
  if (!onchainHash) throw new Error("No policy hash anchored on-chain; refusing to act");
  const local = policyHash(doc);
  if (local !== onchainHash.toLowerCase()) {
    throw new Error(`Policy hash mismatch: local ${local} vs on-chain ${onchainHash}`);
  }
}
