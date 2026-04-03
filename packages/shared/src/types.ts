// ──────────────── Claim 상태머신 ────────────────
// DB, API 응답, 프론트 표시에서 전부 이 값을 쓴다
export const ClaimStatus = {
  QUEUED: "queued",
  BROADCASTING: "broadcasting",
  BROADCASTED: "broadcasted",
  CONFIRMED: "confirmed",
  FAILED_RETRYABLE: "failed_retryable",
  FAILED_PERMANENT: "failed_permanent",
} as const;

export type ClaimStatus = (typeof ClaimStatus)[keyof typeof ClaimStatus];

// ──────────────── Challenge 상태 ────────────────
export const ChallengeStatus = {
  ISSUED: "issued",
  CONSUMED: "consumed",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
} as const;

export type ChallengeStatus = (typeof ChallengeStatus)[keyof typeof ChallengeStatus];

// ──────────────── Tx Attempt 상태 ────────────────
export const TxAttemptStatus = {
  CREATED: "created",
  SIMULATED: "simulated",
  SENT: "sent",
  CONFIRMED: "confirmed",
  REVERTED: "reverted",
  DROPPED: "dropped",
  REPLACED: "replaced",
  FAILED: "failed",
} as const;

export type TxAttemptStatus = (typeof TxAttemptStatus)[keyof typeof TxAttemptStatus];

// ──────────────── API DTOs ────────────────
export interface CreateChallengeRequest {
  recipient: string;
}

export interface CreateChallengeResponse {
  challengeId: string;
  recipient: string;
  deadline: number;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: {
    ClaimChallenge: readonly {
      name: string;
      type: string;
    }[];
  };
  message: {
    recipient: string;
    challengeId: string;
    deadline: number;
  };
  expiresAt: string;
}

export interface CreateClaimRequest {
  challengeId: string;
  signature: string;
}

export interface CreateClaimResponse {
  claimId: string;
  status: ClaimStatus;
  requestId: string;
  recipient: string;
  createdAt: string;
}

export interface GetClaimResponse {
  claimId: string;
  status: ClaimStatus;
  recipient: string;
  requestId: string;
  txHash: string | null;
  failureCode: PublicClaimFailureCode | null;
  createdAt: string;
  updatedAt: string;
}

// ──────────────── Faucet Status ────────────────
export type ReasonCode = "COOLDOWN" | "CLAIM_IN_PROGRESS" | "PAUSED" | "UNAVAILABLE";

// 서버가 내부 worker failureCode를 정규화하여 이 값만 클라이언트에 전달
export type PublicClaimFailureCode = "REJECTED" | "SERVICE_BUSY";

export interface FaucetStatusResponse {
  eligible: boolean;
  reasonCode: ReasonCode | null;
  nextClaimAt: string | null;
  dripAmount: string;
}

// ──────────────── Error Codes ────────────────
export const ErrorCode = {
  INVALID_RECIPIENT: "INVALID_RECIPIENT",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  CHALLENGE_EXPIRED: "CHALLENGE_EXPIRED",
  CHALLENGE_ALREADY_CONSUMED: "CHALLENGE_ALREADY_CONSUMED",
  COOLDOWN_ACTIVE: "COOLDOWN_ACTIVE",
  CLAIM_IN_PROGRESS: "CLAIM_IN_PROGRESS",
  DUPLICATE_CLAIM: "DUPLICATE_CLAIM",
  RATE_LIMITED: "RATE_LIMITED",
  FAUCET_PAUSED: "FAUCET_PAUSED",
  FAUCET_UNAVAILABLE: "FAUCET_UNAVAILABLE",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
