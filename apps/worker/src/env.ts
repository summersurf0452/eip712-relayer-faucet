function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function requiredInt(key: string): number {
  const raw = required(key);
  const val = parseInt(raw, 10);
  if (Number.isNaN(val)) throw new Error(`Env var ${key} must be a valid integer, got: "${raw}"`);
  return val;
}

function optionalInt(key: string, fallback: string): number {
  const raw = process.env[key] ?? fallback;
  const val = parseInt(raw, 10);
  if (Number.isNaN(val)) throw new Error(`Env var ${key} must be a valid integer, got: "${raw}"`);
  return val;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  RPC_URL: required("RPC_URL"),
  CHAIN_ID: requiredInt("CHAIN_ID"),
  FAUCET_ADDRESS: required("FAUCET_ADDRESS") as `0x${string}`,
  RELAYER_PRIVATE_KEY: required("RELAYER_PRIVATE_KEY") as `0x${string}`,

  WORKER_ID: optional("WORKER_ID", "worker-1"),
  CONFIRMATIONS_REQUIRED: optionalInt("CONFIRMATIONS_REQUIRED", "1"),
  BROADCAST_TIMEOUT_SECONDS: optionalInt("BROADCAST_TIMEOUT_SECONDS", "120"),
  POLL_INTERVAL_MS: optionalInt("POLL_INTERVAL_MS", "5000"),
  LEASE_DURATION_SECONDS: optionalInt("LEASE_DURATION_SECONDS", "120"),
  MAX_FEE_PER_GAS_GWEI: optionalInt("MAX_FEE_PER_GAS_GWEI", "50"),
} as const;
