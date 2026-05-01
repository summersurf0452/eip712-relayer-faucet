// 서버 환경변수 파싱 헬퍼 — API/Worker 공용
// process.env에 의존하므로 server-only 컨텍스트에서만 사용할 것.

export function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export function requireEnvInt(key: string): number {
  const raw = requireEnv(key);
  const val = parseInt(raw, 10);
  if (Number.isNaN(val)) throw new Error(`Env var ${key} must be a valid integer, got: "${raw}"`);
  return val;
}

export function optionalEnvInt(key: string, fallback: string): number {
  const raw = process.env[key] ?? fallback;
  const val = parseInt(raw, 10);
  if (Number.isNaN(val)) throw new Error(`Env var ${key} must be a valid integer, got: "${raw}"`);
  return val;
}
