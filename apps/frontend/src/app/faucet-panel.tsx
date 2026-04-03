"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useSignTypedData } from "wagmi";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { formatUnits } from "viem";
import { ApiError, api } from "@/lib/api";
import { getExplorerUrl } from "@/lib/chain";
import type { GetClaimResponse, FaucetStatusResponse } from "@eip712-faucet/shared";
import { ClaimStatus, ErrorCode, type ReasonCode } from "@eip712-faucet/shared";
import { Providers } from "./providers";

type Step =
  | { type: "idle" }
  | { type: "loading"; phase: ClaimPhase; message: string }
  | { type: "error"; message: string; code?: string }
  | { type: "polling"; claimId: string; status: GetClaimResponse["status"] }
  | { type: "done"; claim: GetClaimResponse };

type ClaimPhase = "challenge" | "sign" | "submit" | "confirm";

const PHASES: { key: ClaimPhase; label: string }[] = [
  { key: "challenge", label: "Challenge" },
  { key: "sign", label: "Sign" },
  { key: "submit", label: "Submit" },
  { key: "confirm", label: "Confirm" },
];

function Steps({ phase, done }: { phase: ClaimPhase | null; done: boolean }) {
  const idx = phase ? PHASES.findIndex((p) => p.key === phase) : -1;
  return (
    <div className="steps">
      {PHASES.map((p, i) => (
        <div key={p.key} className="step">
          <div className={`step-dot ${done || i < idx ? "done" : i === idx ? "active" : "pending"}`} />
          <span className={`step-label ${done || i <= idx ? "step-label-on" : "step-label-off"}`}>{p.label}</span>
          {i < 3 && <span className={`step-line ${done || i < idx ? "step-line-done" : ""}`} />}
        </div>
      ))}
    </div>
  );
}

function formatTimeRemaining(isoDate: string): string {
  const diff = new Date(isoDate).getTime() - Date.now();
  if (diff <= 0) return "now";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "< 1m";
}

function getStatusInfo(
  status: FaucetStatusResponse | null,
  ready: boolean,
): { canClaim: boolean; reason: string } {
  if (!ready) return { canClaim: false, reason: "Checking faucet status…" };
  if (!status) return { canClaim: false, reason: "Unable to check faucet status. Try refreshing." };
  if (status.eligible) return { canClaim: true, reason: "One signature. No gas required." };

  const messages: Record<ReasonCode, string> = {
    COOLDOWN: status.nextClaimAt
      ? `Next claim in ${formatTimeRemaining(status.nextClaimAt)}`
      : "Please wait before claiming again.",
    CLAIM_IN_PROGRESS: "A claim is already being processed.",
    PAUSED: "Faucet is temporarily paused.",
    UNAVAILABLE: "Claim not available right now.",
  };
  return {
    canClaim: false,
    reason: status.reasonCode ? messages[status.reasonCode] : "Claim not available right now.",
  };
}

function FaucetPanelInner() {
  const { address, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const [step, setStep] = useState<Step>({ type: "idle" });
  const [faucetStatus, setFaucetStatus] = useState<FaucetStatusResponse | null>(null);
  const [statusReady, setStatusReady] = useState(false);

  useEffect(() => {
    if (!isConnected || !address) {
      setFaucetStatus(null);
      setStatusReady(false);
      return;
    }
    setStatusReady(false);
    api.getFaucetStatus(address)
      .then(setFaucetStatus)
      .catch(() => setFaucetStatus(null))
      .finally(() => setStatusReady(true));
  }, [isConnected, address]);

  // Re-fetch faucet status after claim completes
  useEffect(() => {
    if (step.type !== "done" || !address) return;
    api.getFaucetStatus(address)
      .then(setFaucetStatus)
      .catch(() => setFaucetStatus(null));
  }, [step.type, address]);

  const tokenSymbol = process.env.NEXT_PUBLIC_TOKEN_SYMBOL ?? "TTK";
  const dripDisplay = faucetStatus
    ? formatUnits(BigInt(faucetStatus.dripAmount), 18)
    : "10";
  const statusInfo = getStatusInfo(faucetStatus, statusReady);

  const pollingClaimId = step.type === "polling" ? step.claimId : null;
  useEffect(() => {
    if (!pollingClaimId) return;
    const iv = setInterval(async () => {
      try {
        const c = await api.getClaim(pollingClaimId);
        if (c.status === ClaimStatus.CONFIRMED || c.status === ClaimStatus.FAILED_PERMANENT) {
          clearInterval(iv);
          setStep({ type: "done", claim: c });
        } else {
          setStep({ type: "polling", claimId: pollingClaimId, status: c.status });
        }
      } catch {
        // Ignore transient polling errors and retry on the next interval.
      }
    }, 3000);
    return () => clearInterval(iv);
  }, [pollingClaimId]);

  const claim = useCallback(async () => {
    if (!address) return;
    try {
      setStep({ type: "loading", phase: "challenge", message: "Requesting challenge..." });
      const ch = await api.createChallenge(address);
      setStep({ type: "loading", phase: "sign", message: "Sign with wallet..." });
      const sig = await signTypedDataAsync({
        domain: {
          ...ch.domain,
          chainId: ch.domain.chainId,
          verifyingContract: ch.domain.verifyingContract as `0x${string}`,
        },
        types: ch.types,
        primaryType: "ClaimChallenge",
        message: {
          recipient: ch.message.recipient as `0x${string}`,
          challengeId: ch.message.challengeId as `0x${string}`,
          deadline: BigInt(ch.deadline),
        },
      });
      setStep({ type: "loading", phase: "submit", message: "Submitting..." });
      const cl = await api.createClaim(ch.challengeId, sig);
      setStep({ type: "polling", claimId: cl.claimId, status: cl.status });
    } catch (e) {
      setStep({
        type: "error",
        message: e instanceof Error ? e.message : "Unknown error",
        code: e instanceof ApiError ? e.code : undefined,
      });
    }
  }, [address, signTypedDataAsync]);

  const phase: ClaimPhase | null =
    step.type === "loading" ? step.phase : step.type === "polling" ? "confirm" : null;
  const busy = step.type === "loading" || step.type === "polling";

  return !isConnected ? (
    <div className="actions">
      <ConnectButton.Custom>
        {({ openConnectModal }) => (
          <button onClick={openConnectModal} className="glass-connect-btn" type="button">
            <span className="glass-connect-glow" />
            Connect Wallet
          </button>
        )}
      </ConnectButton.Custom>
      <p className="caption">Connect wallet to begin</p>
    </div>
  ) : (
    <div className="actions">
      <div className="wallet-row">
        <ConnectButton.Custom>
          {({ account, openAccountModal }) => (
            <button onClick={openAccountModal} className="glass-connect-btn" type="button" style={{ marginBottom: "0.75rem" }}>
              <span className="glass-connect-glow" />
              {account?.displayName}
            </button>
          )}
        </ConnectButton.Custom>
      </div>

      <AnimatePresence>
        {(busy || step.type === "done") && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <Steps phase={phase} done={step.type === "done"} />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        onClick={claim}
        disabled={busy || !statusInfo.canClaim}
        whileHover={!busy && statusInfo.canClaim ? { scale: 1.015 } : {}}
        whileTap={!busy && statusInfo.canClaim ? { scale: 0.99 } : {}}
        className={`glass-connect-btn ${busy || !statusInfo.canClaim ? "glass-connect-btn-disabled" : ""}`}
        style={{ marginTop: "0.5rem", opacity: busy || !statusInfo.canClaim ? 0.4 : 1, cursor: busy || !statusInfo.canClaim ? "not-allowed" : "pointer" }}
      >
        {busy ? (
          <span className="cta-loading">
            <motion.span
              className="cta-spinner"
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            />
            {step.type === "loading" ? step.message : "Confirming..."}
          </span>
        ) : (
          `Claim ${dripDisplay} test tokens`
        )}
      </motion.button>

      <p className="caption">{busy ? "Processing..." : statusInfo.reason}</p>

      <AnimatePresence mode="wait">
        {step.type === "error" && (
          <motion.div
            key="e"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="state state-err"
          >
            <span className="state-icon state-icon-err">!</span>
            <div>
              <p className="state-title">Error</p>
              <p className="state-body">{friendly(step.code, step.message)}</p>
              <button onClick={() => setStep({ type: "idle" })} className="state-link state-link-err">
                Retry
              </button>
            </div>
          </motion.div>
        )}
        {step.type === "done" && step.claim.status === ClaimStatus.CONFIRMED && (
          <motion.div
            key="s"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="state state-ok"
          >
            <span className="state-icon state-icon-ok">&#10003;</span>
            <div>
              <p className="state-title">{dripDisplay} {tokenSymbol} delivered</p>
              <p className="state-body">Transfer confirmed on-chain.</p>
              {step.claim.txHash && getExplorerUrl(`/tx/${step.claim.txHash}`) && (
                <a
                  href={getExplorerUrl(`/tx/${step.claim.txHash}`)!}
                  target="_blank"
                  rel="noreferrer"
                  className="state-link"
                >
                  Explorer
                </a>
              )}
            </div>
          </motion.div>
        )}
        {step.type === "done" && step.claim.status === ClaimStatus.FAILED_PERMANENT && (
          <motion.div
            key="f"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="state state-err"
          >
            <span className="state-icon state-icon-err">!</span>
            <div>
              <p className="state-title">Failed</p>
              <p className="state-body">{friendly(step.claim.failureCode ?? undefined, "Claim failed.")}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function FaucetPanel() {
  return (
    <Providers>
      <FaucetPanelInner />
    </Providers>
  );
}

function friendly(code: string | undefined, msg: string): string {
  const map: Record<string, string> = {
    [ErrorCode.CHALLENGE_EXPIRED]: "Challenge expired.",
    [ErrorCode.CHALLENGE_ALREADY_CONSUMED]: "Challenge already used.",
    [ErrorCode.COOLDOWN_ACTIVE]: "Cooldown active.",
    [ErrorCode.CLAIM_IN_PROGRESS]: "A claim is already being processed.",
    [ErrorCode.DUPLICATE_CLAIM]: "Already submitted.",
    [ErrorCode.INVALID_SIGNATURE]: "Signature invalid.",
    [ErrorCode.INVALID_RECIPIENT]: "Invalid wallet.",
    [ErrorCode.RATE_LIMITED]: "Rate limited.",
    [ErrorCode.FAUCET_PAUSED]: "Faucet paused.",
    [ErrorCode.FAUCET_UNAVAILABLE]: "Faucet unavailable.",
    REJECTED: "Claim failed.",
    SERVICE_BUSY: "Claim failed. Try again later.",
  };
  if (code && map[code]) return map[code];
  if (msg.includes("rejected")) return "Signature cancelled.";
  return msg;
}
