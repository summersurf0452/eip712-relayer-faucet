# Public Deploy Hardening — Design Specification

**Date**: 2026-04-03
**Branch**: feature/premium-web3-landing
**Scope**: API response minimization, error sanitization, infrastructure hardening

## Philosophy

> DevTools를 막는 것이 아니라 브라우저에 보내는 정보를 최소화한다.
> 코드를 읽는 것은 막을 수 없다고 전제한다.
> 봐도 얻을 게 없는 상태가 목표다.

---

## Commit 1 — API Hardening

### 1.1 Global Error Handler

**File**: `apps/api/src/index.ts`

Fastify 기본 에러 핸들러는 예상치 못한 예외에서 스택 트레이스를 응답에 포함할 수 있다. `claims.ts:114`의 `throw e` 경로가 대표적.

```typescript
app.setErrorHandler((error, _req, reply) => {
  app.log.error(error);
  reply.status(500).send({
    code: "INTERNAL_ERROR",
    message: "Internal server error",
  });
});
```

모든 미처리 예외는 generic JSON으로 응답하고, 상세 정보는 서버 로그에만 남긴다.

### 1.2 Request Logging 비활성화

**File**: `apps/api/src/index.ts:11`

현재 `logger: { level: "info" }`는 모든 HTTP 요청/응답을 자동 로그한다. `level: "warn"`으로 내리는 대신 Fastify의 `disableRequestLogging` 옵션을 사용한다.

```typescript
const app = Fastify({
  logger: { level: "info" },
  disableRequestLogging: true,
  trustProxy: 1,
});
```

이유: `app.log.info()` 앱 로그는 유지하면서 HTTP 요청 메타데이터 자동 로깅만 제거한다. `level: "warn"`보다 의도가 명확하다.

### 1.3 `GET /api/v1/claims/:claimId` — failureMessage 제거

**File**: `apps/api/src/routes/claims.ts:131-141`

현재 `failureMessage`는 worker가 기록한 raw RPC/provider 에러 문자열을 그대로 클라이언트에 전달한다. 이를 제거하고 `failureCode`만 남긴다.

현재 응답:
```json
{
  "claimId": "...",
  "status": "failed_permanent",
  "failureCode": "SIMULATION_REVERTED",
  "failureMessage": "ContractFunctionExecutionError: CooldownActive(1743724800)"
}
```

변경 후 응답:
```json
{
  "claimId": "...",
  "status": "failed_permanent",
  "failureCode": "SIMULATION_REVERTED"
}
```

`failureMessage` 필드를 응답 객체에서 완전히 제거한다.

#### failureCode 퍼블릭 계약

worker 내부 코드(`SIMULATION_REVERTED`, `GAS_PRICE_TOO_HIGH`, `BROADCAST_TIMEOUT` 등)를 그대로 클라이언트에 노출하면 브라우저 계약이 worker 내부 상태머신에 종속된다. 이는 정보 최소화 원칙에도 반한다(재시도 전략, 가스 캡 존재 등이 추론 가능).

**서버측 정규화**: API 라우트(`claims.ts`)에서 내부 `failureCode`를 퍼블릭 코드로 매핑한 후 응답한다.

| 내부 코드 | 퍼블릭 코드 | 의미 |
| --- | --- | --- |
| `SIMULATION_REVERTED`, `TX_REVERTED` | `REJECTED` | 컨트랙트가 거부 (permanent) |
| `GAS_PRICE_TOO_HIGH`, `BROADCAST_TIMEOUT`, `TRANSIENT_ERROR`, `MAX_ATTEMPTS_EXCEEDED` | `SERVICE_BUSY` | 일시적 처리 불가 (retryable) |
| `null` 또는 기타 | `null` | 알 수 없음 |

퍼블릭 응답의 `failureCode`는 `"REJECTED" | "SERVICE_BUSY" | null`만 가능하다.

프론트 표시 매핑:

| 퍼블릭 코드 | 프론트 메시지 |
| --- | --- |
| `REJECTED` | "Claim failed." |
| `SERVICE_BUSY` | "Claim failed. Try again later." |
| `null` / 기타 | "Claim failed." |

### 1.4 `GET /api/v1/faucet/status` — 응답 재설계

**File**: `apps/api/src/routes/faucet.ts`

이것은 필드 축소가 아니라 **API 계약 재설계**다. 평가 로직 자체를 재구성해야 한다.

#### 1.4.1 새 응답 계약

```typescript
interface FaucetStatusResponse {
  eligible: boolean;
  reasonCode: ReasonCode | null;
  nextClaimAt: string | null;   // ISO 8601, COOLDOWN일 때만 값 있음
  dripAmount: string;           // wei 문자열
}

type ReasonCode =
  | "COOLDOWN"
  | "CLAIM_IN_PROGRESS"
  | "PAUSED"
  | "UNAVAILABLE";
```

제거되는 필드: `paused`, `recipient`, `estimatedEligible`, `estimatedNextClaimAt`, `hasActiveClaim`, `faucetBalance`, `epochBudgetRemaining`

#### 1.4.2 불변식

| 규칙 | 설명 |
|------|------|
| `eligible = true` → `reasonCode = null` | eligible이면 사유 없음 |
| `eligible = false` → `reasonCode != null` | ineligible이면 반드시 사유 있음 |
| `reasonCode = "CLAIM_IN_PROGRESS"` → `nextClaimAt = null` | 진행 중인 claim이면 cooldown 시간 무의미 |
| `reasonCode != "COOLDOWN"` → `nextClaimAt = null` | COOLDOWN일 때만 nextClaimAt 값 존재 |

#### 1.4.3 reasonCode 평가 알고리즘

User-first 우선순위: **CLAIM_IN_PROGRESS > COOLDOWN > PAUSED > UNAVAILABLE**

개인별 blocker를 전역 상태보다 먼저 보여주는 이유: 유저에게 더 actionable한 정보이기 때문이다.

**recipient가 있는 경우:**

```
1. DB 조회: 이 recipient에 active claim(queued/broadcasting/broadcasted)이 있는가?
   → YES: return { eligible: false, reasonCode: "CLAIM_IN_PROGRESS", nextClaimAt: null }

2. 온체인 조회: nextClaimAt(recipient) > now 인가?
   → YES: return { eligible: false, reasonCode: "COOLDOWN", nextClaimAt: <ISO string> }

3. 온체인 조회: paused() === true 인가?
   → YES: return { eligible: false, reasonCode: "PAUSED", nextClaimAt: null }

4. 온체인 조회: epochBudgetRemaining < dripAmount OR faucetBalance < dripAmount 인가?
   → YES: return { eligible: false, reasonCode: "UNAVAILABLE", nextClaimAt: null }

5. 모든 조건 통과:
   → return { eligible: true, reasonCode: null, nextClaimAt: null }
```

**recipient가 없는 경우:**

```
1. 온체인 조회: paused() === true 인가?
   → YES: return { eligible: false, reasonCode: "PAUSED", nextClaimAt: null }

2. 온체인 조회: epochBudgetRemaining < dripAmount OR faucetBalance < dripAmount 인가?
   → YES: return { eligible: false, reasonCode: "UNAVAILABLE", nextClaimAt: null }

3. 모든 조건 통과:
   → return { eligible: true, reasonCode: null, nextClaimAt: null }
```

recipient가 없으면 `CLAIM_IN_PROGRESS`와 `COOLDOWN`은 절대 반환하지 않는다.

#### 1.4.4 핵심 구현 변경: active claim 체크 재배치

현재 `faucet.ts:85-97`은 active claim 체크를 `estimatedEligible`이 true일 때만 수행한다:

```typescript
// 현재 코드 — user-first 구현 불가
if (recipient && estimatedEligible) {
  const activeClaim = await prisma.claim.findFirst({...});
}
```

이 구조에서는 `paused=true`일 때 `estimatedEligible`이 이미 false이므로 active claim 체크가 스킵된다. CLAIM_IN_PROGRESS가 PAUSED를 이길 수 없다.

**새 구조**: active claim 체크를 독립 단계로 분리하여 평가 순서 최상위에 배치한다. 온체인 데이터 fetch는 기존대로 `Promise.all`로 병렬 수행하되, 평가 로직에서 순서만 재구성한다.

#### 1.4.5 알려진 tradeoff

PAUSED 상태에서 CLAIM_IN_PROGRESS가 표시되는 경우: 컨트랙트가 pause되면 worker의 `simulateContract`가 `EnforcedPause`로 revert하여 claim을 `failed_permanent`로 전환한다. 이 전환 전 짧은 구간(worker poll interval, 기본 5초)에서 유저는 "처리 중"이라 보지만 곧 실패할 claim이다. **worker가 다운된 경우 이 구간이 길어질 수 있다.** 이것은 worker 정상 동작에 의존하는 transient state이다.

### 1.5 Shared Types 업데이트

**File**: `packages/shared/src/types.ts`

```typescript
// 변경 전
export interface FaucetStatusResponse {
  paused: boolean;
  recipient: string | null;
  estimatedEligible: boolean;
  estimatedNextClaimAt: string | null;
  hasActiveClaim: boolean;
  faucetBalance: string;
  dripAmount: string;
  epochBudgetRemaining: string;
}

// 변경 후
export type ReasonCode = "COOLDOWN" | "CLAIM_IN_PROGRESS" | "PAUSED" | "UNAVAILABLE";

export interface FaucetStatusResponse {
  eligible: boolean;
  reasonCode: ReasonCode | null;
  nextClaimAt: string | null;
  dripAmount: string;
}

// 퍼블릭 claim 실패 코드 — 서버가 내부 코드를 정규화하여 이 값만 클라이언트에 전달
export type PublicClaimFailureCode = "REJECTED" | "SERVICE_BUSY";

// GetClaimResponse에서 failureMessage 제거, failureCode를 퍼블릭 타입으로 제한
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

---

## Commit 2 — Frontend Adaptation

### 2.1 `getStatusInfo()` 재작성

**File**: `apps/frontend/src/app/faucet-panel.tsx:55-76`

현재 `getStatusInfo()`는 `paused`, `estimatedEligible`, `estimatedNextClaimAt`, `hasActiveClaim`, `faucetBalance`, `epochBudgetRemaining` 6개 필드를 조합한다. 새 계약에서는 `eligible`과 `reasonCode`만 읽으면 된다.

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
  return { canClaim: false, reason: messages[status.reasonCode!] };
}
```

### 2.2 failureMessage 표시 제거

**File**: `apps/frontend/src/app/faucet-panel.tsx:270`

현재: `{step.claim.failureMessage ?? "Unknown error"}`
변경: `failureCode`를 `friendly()` 함수에 매핑하여 사용자용 문구 표시.

```typescript
// 변경 후
<p className="state-body">{friendly(step.claim.failureCode, "Claim failed.")}</p>
```

### 2.3 Source Map 명시 비활성화

**File**: `apps/frontend/next.config.mjs`

Next.js 15는 기본적으로 production source map을 생성하지 않지만, 회귀 방지를 위해 명시한다.

```javascript
const nextConfig = {
  output: "standalone",
  productionBrowserSourceMaps: false,
  // ... 기존 설정
};
```

### 2.4 Google Fonts Self-Host (next/font/local)

**File**: `apps/frontend/src/app/layout.tsx`

`next/font/google` 대신 `next/font/local`을 사용한다. 이유는 보안이 아니라 **빌드 재현성**이다. 이 프로젝트에서 npm registry 네트워크 장애를 겪었으며, Google Fonts CDN 의존을 빌드에서 제거하면 오프라인 빌드가 가능해진다.

작업:
1. Inter(400,500,600,700)과 JetBrains Mono(400,500) woff2 파일을 다운로드
2. `apps/frontend/src/fonts/`에 배치 (`next/font/local`은 소스 트리 상대 경로에서 import하는 것이 관례)
3. `next/font/local`로 폰트 선언 (src 상대 경로 사용)
4. `layout.tsx`에서 Google Fonts `<link>` 태그 제거
5. 폰트 CSS 변수를 `<body>`에 적용

---

## Commit 3 — Infrastructure Hardening

### 3.1 nginx 보안 강화

**File**: `infra/nginx/nginx.conf`

| 변경 | 위치 | 설명 |
|------|------|------|
| `server_tokens off;` | `http` 블록 (line 5 이후) | nginx 버전 헤더 제거 |
| `proxy_hide_header X-Powered-By;` | `http` 블록 | upstream 서버 식별 제거 |
| `proxy_hide_header Server;` | `http` 블록 | Fastify 서버 헤더 제거 |
| `/readyz` 제거 | 모든 server 블록 | 현재 Docker Compose 환경에서 외부 호출 주체 없음. 완전 제거 |
| CSP 업데이트 | HTTPS server 블록 | 아래 참조 |

CSP 변경:
- 제거: `https://fonts.googleapis.com` (style-src), `https://fonts.gstatic.com` (font-src)
- 추가: `font-src 'self';` (self-hosted 폰트)
- 추가: `base-uri 'none';`, `object-src 'none';`, `form-action 'self';`

### 3.2 Docker Compose 환경변수 정리

**File**: `infra/docker/docker-compose.yml`

| 변경 | 현재 | 변경 후 |
|------|------|---------|
| `NEXT_PUBLIC_RPC_URL` build arg | `${NEXT_PUBLIC_RPC_URL:-${RPC_URL}}` | `${NEXT_PUBLIC_RPC_URL:-}` |
| `NEXT_PUBLIC_IS_TESTNET` build arg | `${NEXT_PUBLIC_IS_TESTNET:-}` | `${NEXT_PUBLIC_IS_TESTNET:?Required: set to true or false}` (Docker Compose의 `:?` 문법으로 unset/빈 문자열 모두 에러 발생시킴) |

`RPC_URL`은 API/worker 전용 private RPC다. 프론트에 fallback으로 전달하면 private RPC URL이 JS 번들에 bake-in된다.

### 3.3 .env.example 업데이트

**File**: `.env.example`

추가할 항목:

```ini
# Required. Must be explicitly "true" or "false".
NEXT_PUBLIC_IS_TESTNET=true
```

**프론트 파서 방어** (`apps/frontend/src/lib/chain.ts`): 현재 코드는 빈 문자열을 유효한 override로 취급한다 (`"" !== undefined`이므로 override 분기 진입, `"" !== "false"`이므로 `isTestnet = true`). Commit 2에서 빈 문자열을 invalid로 처리하도록 수정한다:

```typescript
const raw = process.env.NEXT_PUBLIC_IS_TESTNET?.trim();
const isTestnetOverride = raw && raw.length > 0 ? raw : undefined;
```

---

## Release Gate (커밋 아님)

코드 변경 없음. 검증만 수행한다.

### 빌드 검증
- `pnpm lint` — 통과
- `pnpm -r build` — 통과
- `forge test` — 통과
- `pnpm audit --prod` — high/critical 없음 (네트워크 안정 시 실행)

### 헤더 검증
`curl -I https://<domain>`으로 확인:
- `Strict-Transport-Security` 있음
- `Content-Security-Policy` 있음 (Google Fonts 도메인 없음)
- `X-Frame-Options: DENY` 있음
- `X-Content-Type-Options: nosniff` 있음
- `Server` 헤더에 버전 정보 없음 (표준 nginx Alpine 이미지는 `server_tokens off;`로 버전만 제거 가능. `Server: nginx`는 남을 수 있으며, 완전 제거는 `headers-more-nginx-module` 필요 — 현재 범위 외)
- `X-Powered-By` 헤더 없음

### 엔드포인트 검증
- `GET /readyz` → 404 (외부에서 접근 불가)
- `GET /healthz` → `{ ok: true }` (내부 상태 미노출)
- `GET /api/v1/faucet/status` → `eligible`, `reasonCode`, `nextClaimAt`, `dripAmount`만 있음
- `GET /api/v1/claims/:id` → `failureMessage` 필드 없음

### DevTools 검증
- Sources 탭: `.map` 파일 없음
- Network 탭: private RPC URL, relayer key, DB 정보, 내부 호스트명 없음
- Console: 애플리케이션 작성 console output 없음 (브라우저 확장, 지갑, WalletConnect/RainbowKit 등 서드파티 로그는 통제 범위 외)

### 기능 스모크 테스트
- 지갑 연결 → challenge 발급 → 서명 → claim 생성 → 상태 폴링 → tx explorer 링크
- Cooldown 상태 표시 확인
- Paused 상태 표시 확인
- Claim in progress 상태 표시 확인

---

## 운영 설정 체크리스트 (코드 외)

- [ ] TLS 인증서: `infra/nginx/certs/fullchain.pem`, `privkey.pem`
- [ ] `IP_HMAC_SECRET`: `openssl rand -hex 32` 이상
- [ ] `POSTGRES_PASSWORD`: 32자 이상 랜덤
- [ ] `RELAYER_PRIVATE_KEY`: Docker secret 또는 host secret manager 권장
- [ ] `FRONTEND_URL`: 정확한 `https://<domain>` (CORS allowlist 일치)
- [ ] `NEXT_PUBLIC_RPC_URL`: public/read-only endpoint만 (private RPC 절대 금지)
- [ ] `NEXT_PUBLIC_IS_TESTNET`: 반드시 `true` 또는 `false` 명시
- [ ] `NEXT_PUBLIC_RPC_EXPLORER_BASE_URL`: 실제 운영값
- [ ] `WALLETCONNECT_PROJECT_ID`: 실제 운영값

---

## 명시적 제외

다음은 이 설계의 범위에 포함하지 않는다:

- DevTools 감지로 화면을 깨거나 동작을 막는 것
- `debugger` 루프, 우클릭 차단, 키보드 단축키 차단
- Terser 수준을 초과하는 JavaScript 난독화
- "보안처럼 보이는" 클라이언트 방해 장치
- 수평 확장, 멀티 리전, 다중 relayer (후속 단계)
- API 버전 v2 도입 (소비자가 자체 프론트엔드 1개뿐)

---

## 문서 갱신 대상

구현 완료 후 `docs/architecture.md`의 Next.js 14 → 15, React 18 → 19 버전 정보를 갱신한다.
