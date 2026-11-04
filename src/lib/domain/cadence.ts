/** Human cadence for a subscription interval: "every week", "every hour (testnet demo pace)", … */
export function cadence(seconds: number): string {
  if (seconds % 604800 === 0) return seconds === 604800 ? "every week" : `every ${seconds / 604800} weeks`;
  if (seconds % 86400 === 0) return seconds === 86400 ? "every day" : `every ${seconds / 86400} days`;
  const label = seconds % 3600 === 0 ? (seconds === 3600 ? "every hour" : `every ${seconds / 3600} hours`) : `every ${Math.round(seconds / 60)} minutes`;
  return `${label} (testnet demo pace)`;
}
