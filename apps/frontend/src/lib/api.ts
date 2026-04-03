// API 클라이언트 — fetch를 감싸서 에러를 일관되게 처리한다.

import type {
  CreateChallengeResponse,
  CreateClaimResponse,
  GetClaimResponse,
  FaucetStatusResponse,
} from "@eip712-faucet/shared";

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api/v1";

export class ApiError extends Error {
  code?: string;
  status: number;

  constructor(message: string, options: { code?: string; status: number }) {
    super(message);
    this.name = "ApiError";
    this.code = options.code;
    this.status = options.status;
  }
}

async function parseResponseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getErrorDetails(payload: unknown): { code?: string; message?: string } {
  if (!payload || typeof payload !== "object") return {};

  const record = payload as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const payload = await parseResponseBody(res);

  if (!res.ok) {
    const { code, message } = getErrorDetails(payload);
    throw new ApiError(
      message ?? (typeof payload === "string" ? payload : res.statusText || "Request failed"),
      { code, status: res.status }
    );
  }

  return payload as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

export const api = {
  createChallenge: (recipient: string) =>
    post<CreateChallengeResponse>("/claim-challenges", { recipient }),

  createClaim: (challengeId: string, signature: string) =>
    post<CreateClaimResponse>("/claims", { challengeId, signature }),

  getClaim: (claimId: string) =>
    get<GetClaimResponse>(`/claims/${claimId}`),

  getFaucetStatus: (recipient?: string) =>
    get<FaucetStatusResponse>(`/faucet/status${recipient ? `?recipient=${recipient}` : ""}`),
};
