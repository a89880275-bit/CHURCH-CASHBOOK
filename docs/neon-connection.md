# Neon 테스트 프로젝트 연결 결과

2026-11-07. 테스트 대상: `withered-flower-37879263`, 브랜치 `production` (`br-fancy-bird-azmi6jh6`), 조직 `org-weathered-silence-29673843`. `production`은 사용자가 지정한 테스트 프로젝트 내부의 브랜치 이름입니다. 별도 운영 사이트/DB에는 접속하지 않았습니다.

## 수행 결과

- 공식 Neon CLI 9.1.0 전역 설치 후 사용자가 브라우저 로그인을 완료했습니다.
- `neon config plan`에서 지정 프로젝트/브랜치를 실제 확인했고, 적용 변경이 없음을 확인했습니다.
- `neon deploy` 성공: `No changes — branch production already matches the policy.` 및 `Pulled 5 Neon variables into .env.local`.
- `.env.local`의 DB 접속정보, `.neon` 연결 정보는 Git에서 제외합니다. 접속 URL과 비밀번호는 보고서에 기록하지 않습니다.
- 기존 테이블 목록이 비어 있음을 확인한 후 기존 `server/postgres-schema.sql`을 직접 연결 URL로 적용했습니다. `cashbook`의 control/transactions/snapshots/sessions/backups 5개 테이블만 생성했습니다. 사용자/부서/거래 자료를 생성하거나 기존 로컬 `.private/accounting` 자료를 옮기지 않았습니다.
- 실제 Neon 접속, 인증서 검증이 완료된 클라이언트 TLS, SELECT 1 및 임시 JSON 쓰기/수정/조회/롤백을 확인했습니다. 임시 테이블은 롤백 후 존재하지 않습니다.

## 연결 코드 변경

기존 `pg` 드라이버와 `PostgresRepository`를 유지했습니다. `server/production-store.ts`는 Neon URL의 `channel_binding=require`를 지원하도록 조정하고 공식 pg 옵션 `enableChannelBinding:true`를 사용합니다. pg는 서버가 제공할 때 SCRAM-SHA-256-PLUS를 선택하지만 이 옵션만으로 엄격한 require 모드를 보장하는 것은 아닙니다. TLS 인증서 검증은 `rejectUnauthorized:true`를 유지하며 URL로 해제할 수 없습니다. [pg 공식 SSL/채널 바인딩 안내](https://node-postgres.com/features/ssl)

스키마 설정 도구는 `DATABASE_URL_UNPOOLED`가 있으면 직접 연결을 사용합니다. 앱의 일반 조회는 pooled `DATABASE_URL`을 사용합니다. `.env.local`에는 `STORAGE_DRIVER=postgres`, `ACCOUNTING_WRITES_ENABLED=false`를 추가했습니다. Neon 계정에 로그인한 것과 회계담당자의 앱 로그인을 연동한 것은 별개입니다.

`neon.ts`, 공식 `@neon/config`/`@neon/env` 의존성을 추가했습니다. 초기 init에서 편집기 플러그인 설치 실패와 pnpm 저장소 경로 충돌이 있었습니다. 후자는 기존 `.pnpm-store`를 명시해 해결했습니다. 이미 프로젝트 스킬이 있으므로 실패한 편집기 플러그인 설치는 반복하지 않았고, Postgres plan/deploy에는 영향을 주지 않았습니다.

## 재검증 명령

이번 실행 결과: 전체 15개 파일 210개 테스트 통과, `npm run build` 성공(`✓ built in 6.25s`), `check-dist.mjs` 통과. 실제 Neon 검사 출력은 다음과 같습니다.

```text
PASS: live PostgreSQL SELECT 1 and certificate-verified TLS.
PASS: live JSON insert/update/read and transaction rollback; temporary table removed.
PENDING: initial application administrator; empty store was not seeded.
PASS: application API denies anonymous access (401); no temporary login bypass.
```

이는 실제 DB 연결과 JSON SQL 흐름, 앱 어댑터의 초기화/인증 경계를 검사한 결과입니다. 사용자 로그인 후 화면에서 거래를 등록하는 전체 흐름 검수는 아직 아닙니다.

```powershell
node --env-file=.env.local --import tsx scripts/check-neon-postgres.ts br-fancy-bird-azmi6jh6
npm run build
node node_modules/vitest/vitest.mjs run
node scripts/check-dist.mjs
```

진단 스크립트는 브랜치 ID 일치를 검사하고, DB 비밀값/금융 데이터는 출력하지 않습니다. TLS의 경우 PgBouncer 뒤의 `pg_stat_ssl`이 내부 DB 링크를 나타낼 수 있어 실제 클라이언트 TLS 소켓을 검사합니다. 기존 테이블에는 쓰지 않고 임시 테이블만 롤백합니다.

## 아직 미완료

회계 사용자용 OIDC 제공자 연결과 실제 관리자 sub 매핑/최초 초기화가 남았습니다. 따라서 로그인 후 장부 저장까지의 전체 사용자 흐름은 아직 검수하지 않았습니다. 가짜 관리자나 임시 로그인 우회로 초기화하지 않았고 회계 쓰기도 차단 상태입니다. 운영용 런타임 DB 계정 최소 권한 설정과 Netlify 실환경 검수도 운영 전에 필요합니다. 이번 작업에서 Netlify 배포, 회계자료 이전, Git 푸시는 수행하지 않았습니다.
