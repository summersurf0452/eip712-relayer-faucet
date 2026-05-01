import {
  optionalEnv,
  optionalEnvInt,
  requireEnv,
  requireEnvInt,
} from "@eip712-faucet/shared";

export const env = {
  DATABASE_URL: requireEnv("DATABASE_URL"),
  RPC_URL: requireEnv("RPC_URL"),
  CHAIN_ID: requireEnvInt("CHAIN_ID"),
  FAUCET_ADDRESS: requireEnv("FAUCET_ADDRESS") as `0x${string}`,
  RELAYER_PRIVATE_KEY: requireEnv("RELAYER_PRIVATE_KEY") as `0x${string}`,

  WORKER_ID: optionalEnv("WORKER_ID", "worker-1"),
  CONFIRMATIONS_REQUIRED: optionalEnvInt("CONFIRMATIONS_REQUIRED", "1"),
  BROADCAST_TIMEOUT_SECONDS: optionalEnvInt("BROADCAST_TIMEOUT_SECONDS", "120"),
  POLL_INTERVAL_MS: optionalEnvInt("POLL_INTERVAL_MS", "5000"),
  LEASE_DURATION_SECONDS: optionalEnvInt("LEASE_DURATION_SECONDS", "120"),
  MAX_FEE_PER_GAS_GWEI: optionalEnvInt("MAX_FEE_PER_GAS_GWEI", "50"),
} as const;
