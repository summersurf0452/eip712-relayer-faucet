-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('issued', 'consumed', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('queued', 'broadcasting', 'broadcasted', 'confirmed', 'failed_retryable', 'failed_permanent');

-- CreateEnum
CREATE TYPE "TxAttemptStatus" AS ENUM ('created', 'simulated', 'sent', 'confirmed', 'reverted', 'dropped', 'replaced', 'failed');

-- CreateTable
CREATE TABLE "claim_challenges" (
    "id" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" "ChallengeStatus" NOT NULL DEFAULT 'issued',
    "chainId" INTEGER NOT NULL,
    "verifyingContract" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipHash" TEXT,
    "uaHash" TEXT,

    CONSTRAINT "claim_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "signer" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'queued',
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "txHash" TEXT,
    "queueAttempts" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3),
    "broadcastingAt" TIMESTAMP(3),
    "broadcastedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "challengeId" TEXT NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tx_attempts" (
    "id" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "relayerAddress" TEXT NOT NULL,
    "txHash" TEXT,
    "chainNonce" BIGINT,
    "gasEstimate" BIGINT,
    "maxFeePerGas" BIGINT,
    "maxPriorityFeePerGas" BIGINT,
    "status" "TxAttemptStatus" NOT NULL DEFAULT 'created',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "rpcLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "claimId" TEXT NOT NULL,

    CONSTRAINT "tx_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "claim_challenges_challengeId_key" ON "claim_challenges"("challengeId");

-- CreateIndex
CREATE INDEX "claim_challenges_recipient_status_idx" ON "claim_challenges"("recipient", "status");

-- CreateIndex
CREATE UNIQUE INDEX "claims_requestId_key" ON "claims"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "claims_challengeId_key" ON "claims"("challengeId");

-- CreateIndex
CREATE INDEX "claims_status_createdAt_idx" ON "claims"("status", "createdAt");

-- CreateIndex
CREATE INDEX "claims_recipient_idx" ON "claims"("recipient");

-- CreateIndex
CREATE INDEX "tx_attempts_claimId_idx" ON "tx_attempts"("claimId");

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "claim_challenges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tx_attempts" ADD CONSTRAINT "tx_attempts_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
