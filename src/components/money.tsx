import { formatUnits } from "@/lib/domain/money";

/** Renders smallest-unit amounts with tabular figures. Never computes with floats. */
export function Money({ units, symbol = "USDC", className = "" }: { units: bigint | string; symbol?: string; className?: string }) {
  const value = typeof units === "bigint" ? units : BigInt(units);
  return (
    <span className={`whitespace-nowrap font-mono tabular ${className}`}>
      {formatUnits(value)} <span className="text-ink-3">{symbol}</span>
    </span>
  );
}
