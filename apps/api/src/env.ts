// 환경변수를 한 곳에서 파싱하고 검증한다.
// 앱 시작 시 누락된 필수 변수가 있으면 즉시 crash.

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
  PORT: optionalInt("PORT", "3001"),
  DATABASE_URL: required("DATABASE_URL"),
  RPC_URL: required("RPC_URL"),
  CHAIN_ID: requiredInt("CHAIN_ID"),
  FAUCET_ADDRESS: required("FAUCET_ADDRESS") as `0x${string}`,

  CHALLENGE_TTL_SECONDS: optionalInt("CHALLENGE_TTL_SECONDS", "300"),
  IP_HMAC_SECRET: required("IP_HMAC_SECRET"),
  FRONTEND_URL: optional("FRONTEND_URL", ""),

  RATE_LIMIT_WINDOW_SECONDS: optionalInt("RATE_LIMIT_WINDOW_SECONDS", "600"),
  RATE_LIMIT_MAX_CHALLENGE: optionalInt("RATE_LIMIT_MAX_CHALLENGE", "10"),
  RATE_LIMIT_MAX_CLAIM: optionalInt("RATE_LIMIT_MAX_CLAIM", "5"),
} as const;
