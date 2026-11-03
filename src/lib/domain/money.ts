/**
 * Money is always handled as integer smallest units (bigint). Never floats.
 * USDC on NEAR uses 6 decimals.
 */

export const USDC_DECIMALS = 6;

export type Units = bigint;

export function toUnits(amount: string, decimals = USDC_DECIMALS): Units {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal amount: "${amount}"`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`Amount "${amount}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function formatUnits(units: Units, decimals = USDC_DECIMALS, minFraction = 2): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < minFraction) frac = frac.padEnd(minFraction, "0");
  return `${negative ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}

export function parseUnits(value: string | number | bigint): Units {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`Unsafe integer units: ${value}`);
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new Error(`Units must be an integer string: "${value}"`);
  return BigInt(value);
}

export function minUnits(...values: Units[]): Units {
  return values.reduce((a, b) => (a < b ? a : b));
}

export function sumUnits(values: Units[]): Units {
  return values.reduce((a, b) => a + b, 0n);
}
