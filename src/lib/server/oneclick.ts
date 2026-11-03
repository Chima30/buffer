/**
 * NEAR Intents 1Click — QUOTES ONLY.
 *
 * There is no testnet for NEAR Intents (HACKATHON.md Q-007). This module can
 * only request `dry: true` quotes, which move no funds and return no deposit
 * address. Live settlement is intentionally not implemented and requires the
 * owner's explicit approval before it is ever added.
 */
import { oneClickConfig } from "./env";

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  contractAddress?: string;
}

export interface PreviewQuote {
  kind: "QUOTE";
  originAsset: string;
  destinationAsset: string;
  amountOut: string;
  amountIn: string | null;
  minAmountIn: string | null;
  maxAmountIn: string | null;
  fetchedAt: string;
  raw: unknown;
}

function headers(): Record<string, string> {
  const { jwt } = oneClickConfig();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "buffer-platform/0.1",
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
}

export async function listTokens(): Promise<OneClickToken[]> {
  const { baseUrl } = oneClickConfig();
  const res = await fetch(`${baseUrl}/v0/tokens`, { headers: headers() });
  if (!res.ok) throw new Error(`1Click /v0/tokens failed: ${res.status}`);
  return (await res.json()) as OneClickToken[];
}

/**
 * "Customer wants to pay `amountOut` of destinationAsset, holding originAsset."
 * EXACT_OUTPUT so the business would receive exactly the price; conversion
 * fees fall on the payer. Recipient/refund use INTENTS accounts so a single
 * NEAR preview account is valid for any origin chain. dry: true is hard-coded.
 */
export async function previewQuote(params: {
  originAsset: string;
  destinationAsset: string;
  amountOut: string;
}): Promise<PreviewQuote> {
  const { baseUrl, previewAccount } = oneClickConfig();
  const body = {
    dry: true,
    swapType: "EXACT_OUTPUT",
    originAsset: params.originAsset,
    destinationAsset: params.destinationAsset,
    amount: params.amountOut,
    depositType: "ORIGIN_CHAIN",
    recipient: previewAccount,
    recipientType: "INTENTS",
    refundTo: previewAccount,
    refundType: "INTENTS",
    slippageTolerance: 100,
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    referral: "buffer",
    quoteWaitingTimeMs: 3000,
  } as const;
  if (body.dry !== true) throw new Error("Only dry quotes are permitted");

  const res = await fetch(`${baseUrl}/v0/quote`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click quote failed: ${res.status} ${text.slice(0, 300)}`);
  const raw = JSON.parse(text) as { quote?: Record<string, string | undefined> };
  const q = raw.quote ?? {};
  return {
    kind: "QUOTE",
    originAsset: params.originAsset,
    destinationAsset: params.destinationAsset,
    amountOut: q.amountOut ?? params.amountOut,
    amountIn: q.amountIn ?? null,
    minAmountIn: q.minAmountIn ?? null,
    maxAmountIn: q.maxAmountIn ?? null,
    fetchedAt: new Date().toISOString(),
    raw,
  };
}
