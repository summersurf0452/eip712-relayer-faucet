# Public Deploy Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Minimize information exposed through browser, public API, and infrastructure before production deployment.

**Architecture:** Three sequential commits (API → Frontend → Infra), each independently buildable. Shared types change first since both API and frontend depend on them.

**Tech Stack:** Fastify 5, Next.js 15, React 19, nginx, Docker Compose, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-03-public-deploy-hardening-design.md`

---

## Task 1: Shared Types — New API Contracts

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Add ReasonCode and PublicClaimFailureCode types, update interfaces**

```typescript
// In packages/shared/src/types.ts, replace FaucetStatusResponse and update GetClaimResponse

// After the ErrorCode block (line ~117), add:
export type ReasonCode = "COOLDOWN" | "CLAIM_IN_PROGRESS" | "PAUSED" | "UNAVAILABLE";
export type PublicClaimFailureCode = "REJECTED" | "SERVICE_BUSY";
```

Replace the existing `FaucetStatusResponse` (lines 92-101) with:

```typescript
export interface FaucetStatusResponse {
  eligible: boolean;
  reasonCode: ReasonCode | null;
  nextClaimAt: string | null;
  dripAmount: string;
}
```

In `GetClaimResponse` (lines 80-90), remove `failureMessage` and change `failureCode` type:

```typescript
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
```

- [ ] **Step 2: Update shared exports if needed**

Verify `packages/shared/src/index.ts` re-exports `ReasonCode` and `PublicClaimFailureCode`. If it uses wildcard (`export * from`), nothing to do. Otherwise add explicit exports.

---

## Task 2: API — Global Error Handler + Request Logging

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Add disableRequestLogging and error handler**

In `apps/api/src/index.ts`, change line 11 from:

```typescript
const app = Fastify({ logger: { level: "info" }, trustProxy: 1 });
```

to:

```typescript
const app = Fastify({
  logger: { level: "info" },
  disableRequestLogging: true,
  trustProxy: 1,
});
```

Then, after the rate-limit plugin registration (after line 32) and before the healthcheck routes (before line 34), add:

```typescript
// ── 전역 에러 핸들러 ─────────────────────────────────
app.setErrorHandler((error, _req, reply) => {
  app.log.error(error);
  reply.status(500).send({
    code: "INTERNAL_ERROR",
    message: "Internal server error",
  });
});
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @eip712-faucet/api build`

Expected: Clean compilation, no errors.

---

## Task 3: API — failureCode Normalization + failureMessage Removal

**Files:**
- Modify: `apps/api/src/routes/claims.ts`

- [ ] **Step 1: Add normalization function at top of file**

After the existing imports in `apps/api/src/routes/claims.ts` (after line 12), add:

```typescript
import type { PublicClaimFailureCode } from "@eip712-faucet/shared";

function normalizeFailureCode(internal: string | null): PublicClaimFailureCode | null {
  if (!internal) return null;
  switch (internal) {
    case "SIMULATION_REVERTED":
    case "TX_REVERTED":
      return "REJECTED";
    case "GAS_PRICE_TOO_HIGH":
    case "BROADCAST_TIMEOUT":
    case "TRANSIENT_ERROR":
    case "MAX_ATTEMPTS_EXCEEDED":
      return "SERVICE_BUSY";
    default:
      return null;
  }
}
```

- [ ] **Step 2: Update GET /claims/:claimId response**

In `apps/api/src/routes/claims.ts`, replace the response object in the GET handler (lines 131-141):

```typescript
    return reply.send({
      claimId: claim.id,
      status: claim.status,
      recipient: claim.recipient,
      requestId: claim.requestId,
      txHash: claim.txHash ?? null,
      failureCode: normalizeFailureCode(claim.failureCode),
      createdAt: claim.createdAt.toISOString(),
      updatedAt: claim.updatedAt.toISOString(),
    });
```

The key changes: `failureCode` now goes through `normalizeFailureCode()`, and `failureMessage` line is removed entirely.

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @eip712-faucet/api build`

Expected: Clean compilation.

---

## Task 4: API — faucet/status Response Redesign

**Files:**
- Modify: `apps/api/src/routes/faucet.ts`

This is the largest single change. The evaluation logic must be completely restructured for user-first reasonCode priority.

- [ ] **Step 1: Add ReasonCode import**

At the top of `apps/api/src/routes/faucet.ts`, add to the shared import:

```typescript
import { ErrorCode } from "@eip712-faucet/shared";
```

Change to:

```typescript
import { ErrorCode, type ReasonCode } from "@eip712-faucet/shared";
```

- [ ] **Step 2: Rewrite the response logic**

Replace the entire block from `const epochBudgetRemaining` (line 71) through `return reply.send({...})` (line 108) with:

```typescript
      const epochBudgetRemaining = epochBudget > epochSpent ? epochBudget - epochSpent : 0n;

      // ── reasonCode 평가: user-first 우선순위 ──
      // CLAIM_IN_PROGRESS > COOLDOWN > PAUSED > UNAVAILABLE
      let eligible = true;
      let reasonCode: ReasonCode | null = null;
      let nextClaimAt: string | null = null;

      // 1. 개인별 blocker: active claim (recipient 필요, 독립 단계)
      if (recipient) {
        const activeClaim = await prisma.claim.findFirst({
          where: {
            recipient: recipient.toLowerCase(),
            status: { in: ["queued", "broadcasting", "broadcasted"] },
          },
        });
        if (activeClaim) {
          eligible = false;
          reasonCode = "CLAIM_IN_PROGRESS";
        }
      }

      // 2. 개인별 blocker: cooldown (recipient 필요)
      if (eligible && nextAt !== null) {
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (nextAt > now) {
          eligible = false;
          reasonCode = "COOLDOWN";
          nextClaimAt = new Date(Number(nextAt) * 1000).toISOString();
        }
      }

      // 3. 전역 상태: paused
      if (eligible && paused) {
        eligible = false;
        reasonCode = "PAUSED";
      }

      // 4. 전역 상태: budget 또는 balance 부족 (구체적 사유 미공개)
      if (eligible && (epochBudgetRemaining < dripAmount || faucetBalance < dripAmount)) {
        eligible = false;
        reasonCode = "UNAVAILABLE";
      }

      return reply.send({
        eligible,
        reasonCode,
        nextClaimAt,
        dripAmount: dripAmount.toString(),
      });
```

- [ ] **Step 3: Clean up unused variables**

The old code had `estimatedEligible`, `estimatedNextClaimAt`, `hasActiveClaim`. These are all replaced. Verify no references remain.

- [ ] **Step 4: Verify API build**

Run: `pnpm --filter @eip712-faucet/api build`

Expected: Clean compilation.

---

## Task 5: Commit 1 — API Hardening

- [ ] **Step 1: Stage and commit**

```bash
git add packages/shared/src/types.ts apps/api/src/index.ts apps/api/src/routes/claims.ts apps/api/src/routes/faucet.ts
git commit -m "fix: API hardening — error handler, response minimization, failureCode normalization

- Add global Fastify error handler (generic 500 for unhandled exceptions)
- Disable automatic request logging (disableRequestLogging)
- Remove failureMessage from GET /claims/:id response
- Normalize internal failureCode to PublicClaimFailureCode (REJECTED/SERVICE_BUSY)
- Redesign GET /faucet/status with user-first reasonCode priority
- Remove faucetBalance, epochBudgetRemaining, hasActiveClaim from public response

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Frontend — getStatusInfo + failureMessage + IS_TESTNET

**Files:**
- Modify: `apps/frontend/src/app/faucet-panel.tsx`
- Modify: `apps/frontend/src/lib/chain.ts`

- [ ] **Step 1: Update faucet-panel imports**

In `apps/frontend/src/app/faucet-panel.tsx`, update the shared import (line 11):

```typescript
import { ClaimStatus, ErrorCode } from "@eip712-faucet/shared";
```

Change to:

```typescript
import { ClaimStatus, ErrorCode, type ReasonCode } from "@eip712-faucet/shared";
```

- [ ] **Step 2: Rewrite getStatusInfo()**

Replace the entire `getStatusInfo` function (lines 55-76) with:

```typescript
function getStatusInfo(
  status: FaucetStatusResponse | null,
  ready: boolean,
): { canClaim: boolean; reason: string } {
  if (!ready) return { canClaim: false, reason: "Checking faucet status\u2026" };
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
```

- [ ] **Step 3: Fix failureMessage display in failed_permanent state**

In `faucet-panel.tsx`, find the failed_permanent block (around line 270):

```typescript
<p className="state-body">{step.claim.failureMessage ?? "Unknown error"}</p>
```

Replace with:

```typescript
<p className="state-body">{friendly(step.claim.failureCode ?? undefined, "Claim failed.")}</p>
```

- [ ] **Step 4: Update friendly() to handle PublicClaimFailureCode**

The existing `friendly()` function (lines 287-303) maps `ErrorCode` values. Add mappings for the new public failure codes. After the existing `FAUCET_UNAVAILABLE` entry, the function already falls through to `return msg` for unknown codes, which handles `null`. But add explicit entries for clarity:

In the `map` object inside `friendly()`, add after the `FAUCET_UNAVAILABLE` line:

```typescript
    REJECTED: "Claim failed.",
    SERVICE_BUSY: "Claim failed. Try again later.",
```

- [ ] **Step 5: Fix dripDisplay fallback**

The current `dripDisplay` (line 107-109) uses `faucetStatus.dripAmount` which still exists in the new contract. No change needed. Verify the field name matches: `faucetStatus.dripAmount` — confirmed, still present.

- [ ] **Step 6: Fix IS_TESTNET empty string handling**

In `apps/frontend/src/lib/chain.ts`, replace lines 25-28:

```typescript
const isTestnetOverride = process.env.NEXT_PUBLIC_IS_TESTNET;
export const isTestnet = isTestnetOverride !== undefined
  ? isTestnetOverride !== "false"
  : !MAINNET_CHAIN_IDS.has(faucetChainId);
```

With:

```typescript
const rawIsTestnet = process.env.NEXT_PUBLIC_IS_TESTNET?.trim();
const isTestnetOverride = rawIsTestnet && rawIsTestnet.length > 0 ? rawIsTestnet : undefined;
export const isTestnet = isTestnetOverride !== undefined
  ? isTestnetOverride !== "false"
  : !MAINNET_CHAIN_IDS.has(faucetChainId);
```

---

## Task 7: Frontend — Source Map + Font Self-Host

**Files:**
- Modify: `apps/frontend/next.config.mjs`
- Modify: `apps/frontend/src/app/layout.tsx`
- Create: `apps/frontend/src/fonts/` (font files)

- [ ] **Step 1: Disable source maps explicitly**

In `apps/frontend/next.config.mjs`, add `productionBrowserSourceMaps: false` to the config:

```javascript
const nextConfig = {
  output: "standalone",
  productionBrowserSourceMaps: false,
  outputFileTracingRoot: path.join(__dirname, "../../"),
  transpilePackages: ["@eip712-faucet/shared"],
  // ... rest unchanged
};
```

- [ ] **Step 2: Download font files**

```bash
mkdir -p apps/frontend/src/fonts

# Inter — variable weight woff2
curl -L -o apps/frontend/src/fonts/Inter-Variable.woff2 \
  "https://github.com/rsms/inter/raw/master/docs/font-files/InterVariable.woff2"

# JetBrains Mono — variable weight woff2
curl -L -o apps/frontend/src/fonts/JetBrainsMono-Variable.woff2 \
  "https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/variable/JetBrainsMono%5Bwght%5D.woff2"
```

If network is unavailable, download manually from the font project releases and place in `apps/frontend/src/fonts/`.

- [ ] **Step 3: Rewrite layout.tsx with next/font/local**

Replace the entire `apps/frontend/src/app/layout.tsx`:

```typescript
import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const inter = localFont({
  src: "../fonts/Inter-Variable.woff2",
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = localFont({
  src: "../fonts/JetBrainsMono-Variable.woff2",
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "EIP-712 Relayer Faucet",
  description: "Claim test tokens via EIP-712 signature relay",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${jetbrainsMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
```

Key changes: Google Fonts `<link>` tags removed. `<head>` section removed (Next.js manages it). Fonts loaded from local files via CSS variables.

- [ ] **Step 4: Update globals.css font references if needed**

Check `apps/frontend/src/app/globals.css` for any `font-family: 'Inter'` or `'JetBrains Mono'` references. Update them to use the CSS variables: `font-family: var(--font-inter)` and `font-family: var(--font-mono)`.

- [ ] **Step 5: Verify frontend build**

```bash
rm -rf apps/frontend/.next
pnpm --filter @eip712-faucet/frontend build
```

Expected: Clean build, no errors. Verify no Google Fonts references in build output.

---

## Task 8: Commit 2 — Frontend Adaptation

- [ ] **Step 1: Stage and commit**

```bash
git add apps/frontend/src/app/faucet-panel.tsx \
       apps/frontend/src/lib/chain.ts \
       apps/frontend/next.config.mjs \
       apps/frontend/src/app/layout.tsx \
       apps/frontend/src/fonts/
git commit -m "fix: frontend hardening — response adaptation, font self-host, source map off

- Rewrite getStatusInfo() for new reasonCode-based API contract
- Remove failureMessage display, use PublicClaimFailureCode mapping
- Fix IS_TESTNET empty string treated as valid override
- Explicit productionBrowserSourceMaps: false
- Self-host Inter + JetBrains Mono via next/font/local (build reproducibility)
- Remove external Google Fonts dependency

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 9: Infra — nginx Hardening

**Files:**
- Modify: `infra/nginx/nginx.conf`

- [ ] **Step 1: Add server_tokens and proxy_hide_header to http block**

In `infra/nginx/nginx.conf`, after `upstream frontend { ... }` (after line 12) and before the security headers comment (before line 14), add:

```nginx
  server_tokens off;
  proxy_hide_header X-Powered-By;
  proxy_hide_header Server;
```

- [ ] **Step 2: Remove /readyz from all server blocks**

In the HTTP server block (lines 30-32), remove:

```nginx
    location /readyz {
      proxy_pass http://api;
    }
```

In the HTTPS server block (lines 69-71), remove:

```nginx
    location /readyz {
      proxy_pass http://api;
    }
```

- [ ] **Step 3: Update CSP header**

In the HTTPS server block, replace the existing CSP `add_header` (line 53) with:

```nginx
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://*.walletconnect.com wss://*.walletconnect.com wss://*.walletconnect.org https://*.infura.io; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self';" always;
```

Changes from original:
- `font-src`: removed `https://fonts.gstatic.com`, now `'self'` only
- `style-src`: removed `https://fonts.googleapis.com`
- Added: `base-uri 'none'`, `object-src 'none'`, `form-action 'self'`

---

## Task 10: Infra — Docker Compose + .env.example

**Files:**
- Modify: `infra/docker/docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: Fix NEXT_PUBLIC_RPC_URL fallback in docker-compose.yml**

In `infra/docker/docker-compose.yml`, find the frontend build args section.

Change line 75:

```yaml
        NEXT_PUBLIC_RPC_URL: ${NEXT_PUBLIC_RPC_URL:-${RPC_URL}}
```

To:

```yaml
        NEXT_PUBLIC_RPC_URL: ${NEXT_PUBLIC_RPC_URL:-}
```

- [ ] **Step 2: Fix NEXT_PUBLIC_IS_TESTNET enforcement**

Change line 77:

```yaml
        NEXT_PUBLIC_IS_TESTNET: ${NEXT_PUBLIC_IS_TESTNET:-}
```

To:

```yaml
        NEXT_PUBLIC_IS_TESTNET: ${NEXT_PUBLIC_IS_TESTNET:?Required: set to true or false}
```

- [ ] **Step 3: Update .env.example**

In `.env.example`, add after the `NEXT_PUBLIC_TOKEN_SYMBOL` line (after line 37):

```ini
# Required. Must be explicitly "true" or "false".
NEXT_PUBLIC_IS_TESTNET=true
```

- [ ] **Step 4: Verify docker-compose config parses**

```bash
cd infra/docker && NEXT_PUBLIC_IS_TESTNET=true docker compose config --quiet 2>&1; echo "exit: $?"
```

Expected: exit 0 (no errors).

```bash
cd infra/docker && unset NEXT_PUBLIC_IS_TESTNET && docker compose config --quiet 2>&1 | head -3
```

Expected: Error message containing "Required: set to true or false".

---

## Task 11: Commit 3 — Infra Hardening

- [ ] **Step 1: Stage and commit**

```bash
git add infra/nginx/nginx.conf infra/docker/docker-compose.yml .env.example
git commit -m "fix: infra hardening — nginx headers, /readyz removal, env separation

- Add server_tokens off, proxy_hide_header X-Powered-By/Server
- Remove /readyz from public nginx (no external caller in Compose setup)
- Tighten CSP: remove Google Fonts domains, add base-uri/object-src/form-action
- Remove NEXT_PUBLIC_RPC_URL fallback to private RPC_URL
- Enforce NEXT_PUBLIC_IS_TESTNET with :? syntax (fail on unset/empty)
- Update .env.example with IS_TESTNET requirement

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 12: Release Gate

No code changes. Verification only.

- [ ] **Step 1: Full build verification**

```bash
pnpm lint
pnpm -r build
```

Expected: Both pass with no errors.

- [ ] **Step 2: Contract tests**

```bash
forge test
```

Expected: All tests pass (contracts unchanged).

- [ ] **Step 3: Dependency audit (network permitting)**

```bash
pnpm audit --prod
```

Expected: No high/critical vulnerabilities. If network unavailable, defer to deploy time.

- [ ] **Step 4: Verify no source maps in build output**

```bash
find apps/frontend/.next -name "*.map" | head -5
```

Expected: No output (no .map files).

- [ ] **Step 5: Verify Google Fonts references removed from build**

```bash
grep -r "fonts.googleapis.com\|fonts.gstatic.com" apps/frontend/.next/ 2>/dev/null | head -5
```

Expected: No output.

- [ ] **Step 6: Update architecture docs**

Update `docs/architecture.md` references from Next.js 14 to 15, React 18 to 19 if not already done.

---

## File Map Summary

| File | Action | Task |
| --- | --- | --- |
| `packages/shared/src/types.ts` | Modify | 1 |
| `apps/api/src/index.ts` | Modify | 2 |
| `apps/api/src/routes/claims.ts` | Modify | 3 |
| `apps/api/src/routes/faucet.ts` | Modify | 4 |
| `apps/frontend/src/app/faucet-panel.tsx` | Modify | 6 |
| `apps/frontend/src/lib/chain.ts` | Modify | 6 |
| `apps/frontend/next.config.mjs` | Modify | 7 |
| `apps/frontend/src/app/layout.tsx` | Modify | 7 |
| `apps/frontend/src/fonts/*.woff2` | Create | 7 |
| `infra/nginx/nginx.conf` | Modify | 9 |
| `infra/docker/docker-compose.yml` | Modify | 10 |
| `.env.example` | Modify | 10 |
