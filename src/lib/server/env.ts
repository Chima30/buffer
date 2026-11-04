/**
 * Server-side configuration. Each integration validates only the variables it
 * needs, so a missing optional key never breaks unrelated features.
 * Secrets are read here and nowhere else. Never import this from client code.
 */
import { z } from "zod";

if (typeof window !== "undefined") {
  throw new Error("server/env must never be imported in the browser");
}

const nonEmpty = z.string().trim().min(1);

/** Empty values and unedited placeholders like "<server-only>" count as not set. */
export function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    const t = v?.trim();
    out[k] = !t || /^<.*>$/.test(t) || t.includes("<") ? undefined : t;
  }
  return out;
}

function read<T extends z.ZodRawShape>(name: string, shape: T): z.infer<z.ZodObject<T>> {
  const result = z.object(shape).safeParse(cleanEnv(process.env));
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`${name} is not configured. Check environment variables: ${missing}`);
  }
  return result.data;
}

/** The MVP is testnet-only. Refuse to start against mainnet by accident. */
export function nearConfig() {
  const cfg = read("NEAR", {
    NEAR_NETWORK: z.literal("testnet", { message: "NEAR_NETWORK must be 'testnet' for the MVP" }),
    NEAR_RPC_URL: z.url().default("https://rpc.testnet.near.org"),
    BUFFER_CONTRACT_ID: nonEmpty,
    USDC_TOKEN_ID: nonEmpty,
    OWNER_ACCOUNT_ID: nonEmpty,
    CONTRIBUTOR_ACCOUNT_ID: nonEmpty,
    VENDOR_ACCOUNT_ID: nonEmpty,
  });
  return {
    network: cfg.NEAR_NETWORK,
    rpcUrl: cfg.NEAR_RPC_URL,
    contractId: cfg.BUFFER_CONTRACT_ID,
    usdcTokenId: cfg.USDC_TOKEN_ID,
    ownerAccountId: cfg.OWNER_ACCOUNT_ID,
    contributorAccountId: cfg.CONTRIBUTOR_ACCOUNT_ID,
    vendorAccountId: cfg.VENDOR_ACCOUNT_ID,
    explorerTxUrl: (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`,
  };
}

/** Ethereum Sepolia side of Chain Signatures. Testnet only, all values have safe defaults. */
export function sepoliaConfig() {
  const cfg = read("Sepolia", {
    SEPOLIA_RPC_URL: z.url().default("https://ethereum-sepolia-rpc.publicnode.com"),
    MPC_CONTRACT_ID: z.string().default("v1.signer-prod.testnet"),
  });
  return {
    rpcUrl: cfg.SEPOLIA_RPC_URL,
    mpcContract: cfg.MPC_CONTRACT_ID,
    chainId: 11155111,
    explorerTxUrl: (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`,
    explorerAddressUrl: (address: string) => `https://sepolia.etherscan.io/address/${address}`,
  };
}

export function nearAiConfig() {
  const cfg = read("NEAR AI Cloud", {
    NEARAI_API_BASE: z.url().default("https://cloud-api.near.ai/v1"),
    NEARAI_API_KEY: nonEmpty,
    NEARAI_MODEL: nonEmpty,
    NEARAI_FALLBACK_MODEL: z.string().optional(),
  });
  if (/\.completions\.near\.ai/.test(cfg.NEARAI_API_BASE)) {
    // Direct completion endpoints are experimental with known verification limits; use the gateway.
    throw new Error("NEARAI_API_BASE must be the gateway (https://cloud-api.near.ai/v1), not a direct completions endpoint");
  }
  return {
    baseUrl: cfg.NEARAI_API_BASE.replace(/\/$/, ""),
    apiKey: cfg.NEARAI_API_KEY,
    model: cfg.NEARAI_MODEL,
    fallbackModel: cfg.NEARAI_FALLBACK_MODEL || null,
  };
}

export function outlayerConfig() {
  const cfg = read("OutLayer", {
    OUTLAYER_NETWORK: z.literal("testnet").default("testnet"),
    OUTLAYER_API_BASE: z.url().optional(),
    OUTLAYER_API_KEY: nonEmpty,
    OUTLAYER_WALLET_ID: z.string().optional(),
  });
  return {
    network: cfg.OUTLAYER_NETWORK,
    baseUrl: cfg.OUTLAYER_API_BASE,
    apiKey: cfg.OUTLAYER_API_KEY,
    walletId: cfg.OUTLAYER_WALLET_ID ?? null,
  };
}

export function oneClickConfig() {
  const cfg = read("1Click", {
    ONECLICK_API_BASE: z.url().default("https://1click.chaindefuser.com"),
    ONECLICK_JWT: z.string().optional(),
    ONECLICK_PREVIEW_ACCOUNT: nonEmpty,
  });
  return {
    baseUrl: cfg.ONECLICK_API_BASE.replace(/\/$/, ""),
    jwt: cfg.ONECLICK_JWT || null,
    previewAccount: cfg.ONECLICK_PREVIEW_ACCOUNT,
  };
}

export function supabaseConfig() {
  const cfg = read("Supabase", {
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
  });
  return { url: cfg.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: cfg.SUPABASE_SERVICE_ROLE_KEY };
}

export function runtimeConfig() {
  const cfg = read("Runtime", {
    RUNTIME_SECRET: z.string().min(32, "RUNTIME_SECRET must be at least 32 characters"),
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  });
  return { runtimeSecret: cfg.RUNTIME_SECRET, sessionSecret: cfg.SESSION_SECRET };
}
