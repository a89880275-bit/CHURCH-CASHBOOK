# 단계별 진행 보고

> 최신: [Diary 장부 양면 구성](diary-ledger.md) — 실제 입력/수정/삭제, 미저장 확인, 행별 잔액, Excel 다운로드. 165개 테스트 통과.

> 최신 UI: [Pastel Diary Book 대시보드](pastel-diary-theme.md) — 세 가지 테마 선택, 사용자 설정 저장, 양면 수첩·바인더·인덱스·모바일 대응. 전체 154개 테스트 통과. 다른 업무 화면의 수첩 배치는 다음 범위입니다.

> 최신: **[3단계 통계·대시보드](stage3-reports.md)** — 실제 JSON 기반 월별·계정별·연간 집계, 관리자 부서 비교, 장부 상세 이동. 전체 147개 테스트 통과. 아래 보고서는 각 구현 당시 기록입니다.

> 최신 개선: [이월금액 표시·부서별 관리 방식](carry-period-update.md). 월별/연도별 기본 조회 기간과 두 화면의 다섯 합계 카드를 연결했습니다.

> 최신: **[2단계 수입·지출 장부](stage2-ledger.md)** — 실제 거래 JSON 저장·검색·등록/수정/논리삭제·기초잔액·합계·이력 연결. 이전 보고서는 당시 상태의 기록입니다.

> 최신 후속 구현: **[현재 구현 분석·JSON 저장소 검증·1단계 기초정보 관리](stage1-review.md)**. 아래 Phase 1 내용은 초기 메모리 기반 구현 당시 기록입니다. 현재 로컬 실행은 영구 JSON을 사용하며 기초정보 API/화면이 추가되었습니다.

작성일: 2026-11-06. 요구사항: `accounting_web_codex_spec.md` v1.0.

## Phase 1 — 기반의 로컬 구현 및 검증

상태: **로컬 기반 구현 완료, 운영 인증/저장소 통합 미검증. Phase 1의 운영 완료 판정은 보류합니다.**

### 구현한 내용

- React/TypeScript/Vite/Tailwind, PC 우선 다크 UI, 모바일 메뉴 드로어, 로그인·세션·로그아웃, 부서 선택, 관리자/담당자 메뉴·화면 분리.
- OIDC Authorization Code/PKCE/state/nonce 연동 코드. 서버 전용 비밀값, HttpOnly/Secure 쿠키, opaque 서버 세션, 로그아웃 폐기. 실제 제공자 연결은 아직 하지 않음.
- 요청마다 사용자 상태·현재 배정 재평가. 사용자 조회, 배정 교체·권한 미리보기, 배정 감사 before/after. 로컬 교체 시 거래 객체를 다루는 경로 자체가 없음.
- Zod users/departments/assignments/control 및 accounts/transactions 논리 스키마.
- 비공개 Blobs strong-read 어댑터, 운영 업무 변경 차단. 로컬 전용 메모리 어댑터의 revision 충돌 검사. 미리보기 배포 운영 자료 접근 차단.
- 위험 분석, 인증/JSON 전략, API·라우트·폴더·테스트·후속 단계 계획 문서화.

### 실행 방법

`pnpm install --frozen-lockfile` → 터미널 두 개에서 각각 `pnpm server`, `pnpm dev` → `http://127.0.0.1:5173`.

`pnpm test`, `pnpm build`, `node scripts/check-dist.mjs`. 상세 운영 설정은 루트 README를 참조합니다. 로컬 서버는 재시작 시 데이터가 초기화됩니다.

이 작업 환경에는 npm이 없으므로 번들 pnpm으로 설치했고, 검증은 다음 명령을 직접 실행했습니다:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/vite/bin/vite.js build
node scripts/check-dist.mjs
```

### 테스트 결과

- TypeScript 검사: 통과.
- Vitest: **38/38 통과**. API 인증/인가·기존 세션 권한 회수·다른 부서 유지·교체 감사·권한/본문 위조·Origin·로그아웃 재사용·만료·비활성화·revision 경합 및 논리 스키마 검증.
- Vite production build: 통과.
- dist 점검: JSON/소스맵/알려진 서버 환경변수명·제어 객체 경로·가상 인증 subject/관리자 UUID 미포함. 일반적인 비밀값 전체 탐지나 침투시험을 의미하지 않음.
- 브라우저 수동 검수: 관리자 로그인, 대시보드, 390×844 모바일 KPI 및 메뉴 드로어, 부서 관리 선택, 담당자/사유 입력 → 권한 변경 미리보기, Escape로 취소 확인. 실제 권한 변경 동작은 API 테스트에서 확인.
- 대시보드 증빙: `screenshots/phase1-dashboard.png`.
- 최초 테스트 실행에서 테스트 코드 괄호 오류가 발견되어 수정 후 38개 모두 통과. Windows sandbox의 esbuild 상위 경로 탐색 제한은 허용된 검증 실행으로 해결.
- pnpm 최초 설치는 esbuild 빌드 스크립트 승인 설정이 없어 설치 완료 후 비정상 종료했으나, 이후 `pnpm-workspace.yaml`에 esbuild만 명시적으로 허용. 빌드/테스트 실행 확인.
- 최종 `pnpm install --frozen-lockfile` 재실행: 성공(exit 0), lockfile 검증 및 esbuild postinstall 완료.

### 미검증·미구현

- 실제 OIDC 제공자 설정·가입·MFA/비밀번호 재설정·로그인 제한·실제 로그인/로그아웃 왕복.
- 운영 관리자 초기 프로비저닝과 관리형 인증 subject 매핑 자동화.
- 원격 Blobs API의 실제 장애·세션 쓰기/삭제·지속성·동시성 통합 시험.
- 운영 배정 변경, 사용자/부서 생성·수정·비활성화 API 및 UI.
- 향후/과거 적용일 예약 배정, 배정 전체 해제, 전체 감사 검색. 현재는 오늘 교체·배정 감사 읽기만 제공.
- 실제 Netlify 배포, Functions 실행·rewrite 및 호스팅 헤더 검증.
- 장부, 회계 통계, 마감, Excel, 백업/복원은 아직 미구현. 안내 화면을 기능 완료로 계산하지 않음.

### 변경 파일 목록

| 구분 | 파일 |
|---|---|
| 기준 명세 | `docs/accounting_web_codex_spec.md` (첨부 원문 복사) |
| 실행·결정·보고 | `README.md`, `docs/implementation-plan.md`, `docs/progress.md` |
| 프로젝트 설정 | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore`, `.env.example`, `netlify.toml` |
| 화면 | `src/main.tsx`, `src/styles.css` |
| 서버 | `server/schema.ts`, `server/store.ts`, `server/policy.ts`, `server/auth.ts`, `server/api.ts`, `server/local.ts`, `server/seed.ts` |
| 운영 진입점 | `netlify/functions/api.ts` |
| 검증 | `tests/api.test.ts`, `scripts/check-dist.mjs`, `docs/screenshots/phase1-dashboard.png` |

`node_modules`, `.pnpm-store`, `dist`는 생성 산출물이며 버전 관리에서 제외합니다. 비밀키·실제 회계 JSON은 작성하지 않았습니다.

## Phase 2 — 핵심 장부

상태: 미착수. accounts/transactions의 기본 논리 스키마와 화면 경로만 준비했습니다. 먼저 저장 전략과 실제 경쟁 쓰기·마감/권한 경계 검증을 완료해야 합니다. 구현 뒤 실행방법·결과·변경 파일을 이 문서에 추가합니다.

## Phase 3 — 통계·마감

상태: 미착수. 화면 레이아웃만 존재하며 수치·차트·기초잔액·마감은 연결하지 않았습니다. 검증되지 않은 잔액을 표시하지 않습니다.

## Phase 4 — 운영 안정화

상태: 미착수. 백업·복원·자동 백업·배포를 수행하지 않았습니다. 관리자의 다운로드만으로 자동 백업이라고 설명하지 않습니다.
