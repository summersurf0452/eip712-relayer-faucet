# Architecture

## Overview

EIP-712 Relayer Faucet is a full-stack system that distributes test tokens on an EVM chain selected by configuration. Users prove wallet ownership via EIP-712 typed data signature; a backend relayer submits the on-chain transaction on their behalf.

```
User Wallet (MetaMask, etc.)
  │  EIP-712 typed signature
  ▼
Frontend  ─── Next.js App Router + wagmi + viem
  │  REST API
  ▼
API  ─────────── Fastify + TypeScript + Prisma
  │  claim queue (PostgreSQL)
  ▼
Worker  ──────── Node.js + TypeScript + viem
  │  drip(recipient, requestId)
  ▼
Faucet Contract ─ Solidity 0.8.27 + OpenZeppelin v5
  │  safeTransfer
  ▼
TestToken  ────── ERC-20, fixed supply
```

## Design Principles

1. **Separation of concerns** — API validates and queues; Worker holds the private key and broadcasts. API never touches the relayer key.
2. **Defense in depth** — off-chain policy (route-level rate limit, challenge TTL, signature verification) + on-chain invariants (requestId idempotency, cooldown, epoch budget). On-chain is the final source of truth.
3. **Minimal relayer authority** — relayer can only call `drip()`. Cannot pause, withdraw, or change config.
4. **Failure is a first-class citizen** — DB state machine + lease-based recovery handles crashes, dropped transactions, receipt lag, and partial failures.
5. **Single source of chain metadata** — API, Worker, and Frontend all derive chain/explorer behavior from `CHAIN_ID` plus optional explorer override.

## Data Flow

```
1.  User connects wallet
2.  Frontend  →  API     POST /api/v1/claim-challenges { recipient }
3.  API       →  DB      INSERT challenge (status: issued, TTL 5 min)
4.  API       →  Frontend  { challengeId, deadline, domain, types, message }
5.  Frontend  →  Wallet  signTypedData(domain, types, message)
6.  Wallet    →  Frontend  signature
7.  Frontend  →  API     POST /api/v1/claims { challengeId, signature }
8.  API           ecrecover → verify signer == recipient, challenge valid
9.  API       →  DB      TX: challenge → consumed, claim → queued
10. API       →  Frontend  { claimId, status: "queued" }
11. Worker        SELECT queued claim FOR UPDATE SKIP LOCKED
12. Worker        simulateContract(drip) — preflight revert check
13. Worker        sign + broadcast tx
14. Worker    →  DB      update claim → broadcasted, txHash recorded
15. Worker        poll receipt → wait for required confirmations, then mark confirmed / retryable / permanent failure
16. Frontend      GET /api/v1/claims/:id polling every 3s → status update
```

## Contract Design

### TestToken (`contracts/src/TestToken.sol`)
- Standard ERC-20, fixed supply minted to deployer at construction
- No mint function — supply is permanently fixed

### Faucet (`contracts/src/Faucet.sol`)

**Role separation (OpenZeppelin AccessControl)**

| Role | Permissions |
|------|-------------|
| `DEFAULT_ADMIN_ROLE` | Grant/revoke roles, emergency withdrawal (paused only) |
| `RELAYER_ROLE` | `drip()` only |
| `PAUSER_ROLE` | `pause()` / `unpause()` |

**`drip()` guards (in order)**

1. `recipient != address(0)`
2. `requestId` not previously processed
3. Cooldown elapsed since last claim by recipient
4. Epoch rollover if needed
5. Epoch budget not exhausted
6. Faucet token balance sufficient

Follows Checks-Effects-Interactions pattern.

**Immutable vs mutable state**

| Immutable (set at deploy) | Mutable (changes at runtime) |
|--------------------------|------------------------------|
| `token`, `dripAmount` | `nextClaimAt[recipient]` |
| `cooldown`, `epochBudget` | `processedRequestIds[requestId]` |
| `epochDuration` | `epochStart`, `epochSpent` |

## Database Schema

Three core tables with a state machine per claim:

```
claim_challenges  ──┐
                    │ 1:1
claims  ────────────┘
  │ 1:N
tx_attempts
```

**Claim status transitions**

```
queued → broadcasting → broadcasted → confirmed
                    └──────────────→ failed_retryable
                                   → failed_permanent
```

Worker uses `FOR UPDATE SKIP LOCKED` on the `claims` table to safely process claims across multiple instances without double-processing.

## Runtime Configuration

| Variable | Purpose |
|----------|---------|
| `CHAIN_ID` | Shared chain identity for EIP-712 domain, worker wallet client, and frontend wallet/explorer UI |
| `RPC_URL` | RPC endpoint used by API status reads and worker broadcasting/reconciliation |
| `NEXT_PUBLIC_RPC_EXPLORER_BASE_URL` | Optional frontend explorer override; if blank, frontend derives the explorer from `CHAIN_ID` metadata |
| `RATE_LIMIT_WINDOW_SECONDS` | Shared window for challenge/claim API throttling |
| `RATE_LIMIT_MAX_CHALLENGE` | Max challenge requests per window |
| `RATE_LIMIT_MAX_CLAIM` | Max claim submissions per window |
| `CONFIRMATIONS_REQUIRED` | Receipt confirmations before the worker finalizes a successful transaction |
| `BROADCAST_TIMEOUT_SECONDS` | Time after which a missing tx receipt is treated as dropped and retried |
| `LEASE_DURATION_SECONDS` | How long a worker lease stays valid before another worker may recover it |

## Key Constants

| Constant | Value |
|----------|-------|
| `dripAmount` | `10e18` (10 TTK) |
| `cooldown` | 86400s (24h) |
| `epochBudget` | `100e18` (100 TTK / epoch) |
| `epochDuration` | 86400s |
| Challenge TTL | 300s (5 min) |
| EIP-712 domain name | `"eip712-relayer-faucet"` |
| EIP-712 domain version | `"1"` |

## Intentional Scope Exclusions

| Feature | Reason excluded |
|---------|----------------|
| EIP-1271 (smart contract wallets) | Complexity vs. scope tradeoff |
| Automatic tx replacement (gas bump) | Nonce management complexity; dropped tx handling currently falls back to timeout + retry |
| Multi-relayer | Nonce collision handling; correctness-first |
| Redis / RabbitMQ | PostgreSQL-based queue is sufficient |
| Admin dashboard | Operational scripts suffice |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart contracts | Foundry · Solidity 0.8.27 · OpenZeppelin v5 |
| API | Fastify · TypeScript · Prisma |
| Worker | Node.js · TypeScript · viem |
| Frontend | Next.js 15 App Router · React 19 · wagmi · RainbowKit · viem |
| Database | PostgreSQL 16 · Prisma Migrate |
| Monorepo | pnpm workspaces |
| Infrastructure | Docker Compose · nginx |
| Module system | ESM throughout (`"type": "module"`, NodeNext) |
