# PostgreSQL JSON 저장소와 Netlify 연결

후속 결과: 지정된 Neon 테스트 프로젝트의 실제 연결·TLS·임시 JSON 읽기/쓰기/롤백 검증을 완료했습니다. [최신 연결 결과](neon-connection.md). 최초 앱 관리자/OIDC 연결 및 Netlify 검수는 별도입니다.

2026-11-07 사용자가 관리형 PostgreSQL + JSON 전환을 승인했습니다. 기존 JSON 논리 스키마, 업무 API, 인증/부서 권한 및 백업 파일 형식을 유지합니다. 서비스 계정 생성, 유료 자원 생성, 실제 DB 접속이나 운영 자료 이전은 실행하지 않았습니다.

## 저장 및 동시성 구조

`PostgresRepository`는 비공개 `cashbook` 스키마의 `control`, `transactions`, `snapshots`, `sessions`, `backups` 테이블을 사용합니다. JSON 데이터는 PostgreSQL `json`으로 저장합니다. JSONB 키 재배열에 의존하지 않고 앱 스키마와 SHA-256을 검증합니다. 거래는 부서/ID/버전/해시별 독립 불변 객체이며 현재 참조는 제어 JSON에 있습니다.

하나의 커넥션에서 BEGIN → control 행 SELECT FOR UPDATE → 최신 사용자/배정/마감/revision 검사 → 거래·감사·스냅샷·제어 JSON 저장 → COMMIT을 수행합니다. 중첩 저장 호출도 같은 커넥션을 사용합니다. 행 잠금은 전체 회계 쓰기를 직렬화하므로 소규모 회계 업무에 맞춘 구조이고 고빈도 처리량을 주장하지 않습니다. [PostgreSQL 행 잠금](https://www.postgresql.org/docs/current/explicit-locking.html), [node-postgres 트랜잭션](https://node-postgres.com/features/transactions)

동일 requestId 재전송은 중복 등록하지 않습니다. 수정 버전과 관리자 설정 revision 충돌은 재조회가 필요합니다. COMMIT 중 연결이 끊기면 서버가 결과를 확정할 수 없으므로 503과 재조회 안내를 반환하고 자동 재저장하지 않습니다. 이는 성공/실패가 언제나 구별된다는 보장이 아닙니다.

복원 전 회계 사본은 별도 커넥션에서 먼저 커밋합니다. 이후 복원이 실패해도 사본은 유지되고 업무 트랜잭션은 롤백됩니다. 앱 풀은 인스턴스당 최대 3개이며 복원에는 최소 2개가 필요합니다. 여러 Functions 인스턴스 전체 연결 수는 별도이므로 관리형 서비스의 연결 한도/풀러와 Netlify 함수 실행 제한을 실제로 확인해야 합니다. 복원 사본·스냅샷도 같은 DB 장애에 함께 영향받으므로 별도 위치의 JSON 백업 및 공급자의 백업/복구 정책을 추가로 준비합니다.

## 운영 환경변수

Netlify Functions / Production scope에만 설정합니다. `VITE_*`, Git, `public`, 채팅에는 비밀값을 넣지 않습니다.

| 변수 | 값 |
| --- | --- |
| STORAGE_DRIVER | postgres |
| DATABASE_URL | 공급자가 제공한 비공개 PostgreSQL 접속 URL. 런타임 전용 계정 사용 |
| DATABASE_CA_CERT | 사설 CA를 쓰는 공급자인 경우 해당 PEM. 선택 사항 |
| ACCOUNTING_WRITES_ENABLED | 처음에는 false. 격리 테스트 사이트 검수 시에만 true, 운영은 검수 통과 후 |
| APP_ORIGIN | 실제 사이트 HTTPS origin, 끝 / 없음 |
| OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET | OIDC 웹 앱 설정 |
| COOKIE_KEY | 암호학적 난수 32바이트의 64자리 hex |

PostgreSQL 선택 시 BLOBS_STORE는 사용하지 않습니다. STORAGE_DRIVER 생략 시 기존 읽기 전용 Blobs 어댑터를 유지합니다. DB 오류 시 로컬 파일이나 Blobs로 자동 대체하지 않습니다.

운영 DB 연결은 TLS 및 인증서 검증을 강제합니다. URL의 `sslmode=require/verify-ca/verify-full`은 제거한 뒤 `rejectUnauthorized:true`를 적용합니다. Neon의 `channel_binding=require` 표기는 pg의 `enableChannelBinding:true`로 처리합니다. 이는 서버가 제공할 때 SCRAM-SHA-256-PLUS를 선택하며 엄격한 require 모드 보장은 아닙니다. `sslmode=disable`, `sslcert`, 그 밖의 임의 옵션은 거절합니다. 공급자의 URL에 다른 옵션이 필요한 경우 문서를 확인해 지원 범위를 먼저 검토해야 하며 인증서 검증을 끄지 않습니다. 공급자별 전용 API는 구현하지 않았습니다.

## 최초 설정 절차

1. 별도 테스트 Netlify 사이트와 별도 관리형 PostgreSQL DB를 준비합니다. 사이트별 DB를 분리합니다. 현재 API는 production context만 허용하므로 테스트 사이트도 자체 production context로 배포합니다.
2. OIDC 웹 앱과 초기 관리자 계정을 준비합니다. 실제 사용자의 subject(sub), 로그인 ID, 표시 이름을 `.private/deployment/admin-input.json`에 작성합니다. 인증 서비스 계정을 만드는 명령이 아닙니다.

```json
{"subject":"실제 OIDC sub", "loginId":"church.admin", "displayName":"회계 관리자"}
```

3. 로컬에서 `node --import tsx scripts/prepare-production.ts .private/deployment/admin-input.json`을 실행합니다. `.private/deployment/bootstrap.json`을 새로 만들며 기존 파일을 덮어쓰지 않습니다. local:/archive: 신원과 예제 부서를 넣지 않습니다. 생성 자체가 외부 신원 소유권을 검증하는 것은 아니므로 실제 제공자 관리자 화면에서 sub를 확인해야 합니다.
4. 스키마 소유자 접속 정보를 로컬 서버 환경변수 DATABASE_URL에 안전하게 설정한 후 아래 두 명령을 **대상 DB 확인 후 직접** 실행합니다. 이 작업은 Netlify 빌드나 HTTP API에서 자동 실행되지 않습니다.

```powershell
node --import tsx scripts/provision-postgres.ts schema cashbook-v1 --apply
node --import tsx scripts/provision-postgres.ts initialize .private/deployment/bootstrap.json --apply
```

최초 초기화는 control이 이미 있으면 거절합니다. 재배포가 자료를 초기화하지 않습니다. 스키마 v1 파일은 최초 도입용이며 향후 컬럼 변경을 자동 마이그레이션하는 도구가 아닙니다.

5. 공급자 관리 화면에서 별도 런타임 계정을 생성해 스키마 USAGE, 테이블 SELECT/INSERT, control UPDATE, sessions UPDATE/DELETE만 부여합니다. 아래의 역할명은 예시이며 실제 역할 이름에 맞춰 소유자가 실행합니다. 관리자/스키마 소유자 URL을 Functions에 넣지 않습니다.

```sql
GRANT USAGE ON SCHEMA cashbook TO cashbook_runtime;
GRANT SELECT, INSERT ON cashbook.control, cashbook.transactions,
  cashbook.snapshots, cashbook.sessions, cashbook.backups TO cashbook_runtime;
GRANT UPDATE ON cashbook.control, cashbook.sessions TO cashbook_runtime;
GRANT DELETE ON cashbook.sessions TO cashbook_runtime;
```

테이블은 PUBLIC 권한을 회수합니다. PostgREST 등 자동 API에 cashbook 스키마를 노출하거나 브라우저 역할에 권한을 주지 않습니다. 부서별 권한은 기존 Netlify API에서 검사하며 브라우저는 DB에 직접 접속하지 않습니다. DB 런타임 자격증명은 서버 신뢰 경계에 속하므로 유출 시 전체 자료에 영향이 있습니다.

6. Netlify에 런타임 URL과 OIDC 환경변수를 등록하고 쓰기를 끈 상태로 배포합니다. 실제 로그인 및 부서 권한을 검수합니다. 격리 자료로 쓰기를 켠 후 동시 등록/수정, 권한 회수 경쟁, 월/연 마감, 오류, JSON 복원, Excel, 재배포 지속성을 확인합니다.
7. 실제 운영 검수 통과 후에만 운영 사이트의 쓰기를 켭니다. 기존 로컬 회계자료는 초기 관리자 설정과 별도로 재무 JSON 백업 검증/복원으로 옮기며 현재 운영 사용자 권한/배정은 복원하지 않습니다. 원본 `.private/accounting`은 이 작업에서 수정하지 않았습니다.

## 검증 범위

실행 결과: 전체 15개 파일 **209개 테스트 통과** 후 최소 런타임 권한 테스트를 추가해 PostgreSQL **17개 테스트 재통과**(기존 16개 포함). TypeScript 및 Vite 프로덕션 빌드, 정적 결과물 비공개 정보 검사 통과. Netlify 설정과 같은 pg 외부 의존성 설정의 esbuild 함수 번들 생성/로드 및 미설정 요청 503 차단도 확인했습니다. 실제 Netlify 빌드/패키징/배포 성공을 확인한 것은 아닙니다.

`tests/postgres.test.ts`는 임시 디렉터리의 실제 PostgreSQL 엔진에 루프백으로 연결하며 운영 DATABASE_URL을 읽지 않습니다. 독립된 두 연결 풀로 경쟁, JSON 원본/감사 커밋, 권한 회수, 마감 및 롤백을 검사합니다. OIDC 로그인은 이 저장소 테스트 범위가 아니며 테스트용 세션을 직접 발급합니다. 실제 Netlify 네트워크·관리형 DB TLS·공급자 풀러·장애 복구 검수와 구분합니다.

```powershell
node node_modules/vitest/vitest.mjs run tests/postgres.test.ts
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
node scripts/check-dist.mjs
node scripts/check-production.mjs
```

설정 점검 스크립트는 비밀값을 출력하지 않으며 실제 운영 준비를 인증하지 않습니다. 현재 미연결 상태에서는 계속 종료 코드 1을 반환합니다.

## 이번 단계 변경 파일

- 추가: `server/postgres-store.ts`, `server/postgres-schema.sql`, `server/production-store.ts`, `server/provisioning.ts`, `scripts/prepare-production.ts`, `scripts/provision-postgres.ts`, `tests/postgres.test.ts`, `tests/fixtures/postgres-engine.ts`, 이 안내서.
- 수정: `netlify/functions/api.ts`, `netlify.toml`(pg를 외부 런타임 의존성으로 패키징), `server/store.ts`(선택적 일괄 읽기), `server/ledger.ts`(동일 트랜잭션 내 거래 저장·잠금 내 재전송 확인), `server/backups.ts`(단일 SQL 커넥션 쿼리 직렬화), `tests/ledger.test.ts`(잠금 경계 변경에 맞춰 권한/마감 경쟁 검증 유지).
- 설정/문서: `.env.example`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `scripts/check-dist.mjs`, `scripts/check-production.mjs`, `README.md`, `docs/progress.md`, `docs/production-auth.md`, 배포 점검 보고서.

## 아직 남은 작업

관리형 PostgreSQL 서비스와 OIDC 계정 준비, 실제 서버 환경변수 등록, 최초 관리자 sub 확인/초기화, 격리된 Netlify 사이트 배포 및 원격 경쟁/장애/복원 검수가 남았습니다. 서비스 생성·과금·원격 초기화·기존 자료 이전·Git 커밋/푸시는 실행하지 않았습니다. 저장소 어댑터 구현 완료와 운영 검수 완료를 구분합니다.
