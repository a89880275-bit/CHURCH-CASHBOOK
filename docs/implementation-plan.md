# 구현 계획 및 기술적 위험 분석

> 후속 구현: **[2단계 장부 결과](stage2-ledger.md)**. 로컬 거래별 버전 객체와 공유 커밋 잠금 검증을 완료했습니다. 원격 저장소·통계·운영 배포의 미검증 범위는 계속 분리합니다.

> 최신 로컬 저장소·기초정보 구현과 실제 검증 결과는 **[1단계 보고서](stage1-review.md)**에 기록합니다. 이 문서의 “현재 저장 어댑터” 설명은 최초 Phase 1 기준이며 원격 Blobs 업무 쓰기 차단과 장부 커밋 전략 검증 필요성은 계속 유효합니다.

기준 문서: `accounting_web_codex_spec.md` v1.0. 이 문서는 구현 방법과 미결정 사항만 정리하며 요구사항을 변경하지 않습니다. 확인일: 2026-11-06 (한국 시간).

## A. 위험·미결정 사항

| 항목 | 실패 위험 | 처리/완료 조건 |
|---|---|---|
| 단일 JSON 덮어쓰기 | 서로의 수정 유실 | 거래별 독립 객체. 원자적 확정 수단 없는 변경은 운영 차단 |
| 권한 캐싱 | 교체 후 기존 세션에 권한 잔존 | 각 요청에서 strong read한 사용자 상태·현재 배정으로 재평가. 이미 진행 중인 요청까지 취소하는 보장은 별도 커밋 직렬화 필요 |
| 마감과 거래 쓰기 경합 | 마감 뒤 거래가 커밋될 수 있음 | 같은 직렬화 경계에서 마감 확인+거래 확정 필요. 개별 거래 ETag만으로 해결되지 않음 |
| 권한·감사·배정 변경 | 부분 저장 및 감사 누락 | 한 커밋으로 확정할 설계 또는 검증된 직렬화 필요. 다중 객체 트랜잭션 가정 금지 |
| 계정코드 유일성 | 동시 생성 시 중복 | `(departmentId,code)` 유일성 판단과 커밋을 같은 경계에 두기 |
| 사용 계정 유형 변경 | 과거 통계 왜곡 | 거래 참조 검사+변경을 동일 경계로 보호 |
| Blobs SDK/일관성 | SDK 오류·오래된 읽기·운영 자료 혼합 | lockfile 고정, strong read, 장애 주입·실서비스 경쟁 쓰기·배포 지속성 검증 |
| 날짜/배정 경계 | 당일 겹침·시간대 오류 | UTC 시각, 거래일 별도. 배정 종료일 포함, 한국 날짜 기준. Phase 1은 오늘 즉시 교체만 지원 |
| 같은 날 반복 교체 | 날짜 단위로 시각 구분 불가 | 현재 배정 행은 교체하고 이전 행 전체를 감사기록 before에 보존. 정밀 시각 배정은 추가 설계 |
| 합계/용량 | JS 정수 오버플로 및 원장 전체 스캔 | 개별·총합 모두 safe integer 검사, 처리량/원장 크기 한도 확정. 캐시 잔액을 원본으로 사용하지 않기 |
| 복원/백업 | 부분 복원·민감정보 유출 | 쓰기 정지/원자적 활성 스냅샷 전환, 체크섬 검증, 별도 백업, 암호화/보존 정책 결정 |
| 사이트 범위 저장소 | preview 코드가 운영 자료 접근 | preview 차단. 독립 개발 사이트/저장소 분리 |
| 자체 인증 | 초기화·해시·세션 폐기·로그인 제한 누락 | 관리형 OIDC를 기본안으로 사용. IdP 실제 설정/계약은 미확정 |

운영자가 결정해야 할 사항: 인증 업체·요금·계정 발급/MFA/비밀번호 재설정, 실제 사용자 수와 동시 쓰기 수, 데이터 규모, 기존 Delphi 이관 형식, 최초 이월 기준일/금액, 미래 적용 배정 및 부서 전체 해제 정책, 백업 주기·별도 보관소·암호화·보존기간, 세션 수명(현재 8시간 절대 만료, 유휴 만료 미구현), 연간 마감 이후 과거 기간 수정 정책. 기본 관리자 마감 권한은 명세대로 유지합니다.

## B. 인증 및 JSON 저장 전략

### 인증: 관리형 OIDC + 서버 세션

기존 서비스가 없다는 운영자 답변에 따라 **Auth0 Regular Web Application + Universal Login**을 우선 연결 후보로 제안합니다. 서버의 issuer/client ID/client secret 설정으로 연결하고 앱의 callback URI를 정확히 등록합니다. 계정 생성·요금제 선택은 수행하지 않았고 비용·데이터 처리 지역·제공자 정책 검토가 남아 있습니다. 특정 업체의 비공개 API나 임의 인증 엔드포인트는 구현하지 않았습니다. [Auth0 공식 웹앱 설정 안내](https://auth0.com/docs/quickstart/webapp/express/index)

- `openid-client` v6 Authorization Code + PKCE S256, state·nonce 및 ID token 검증 사용.
- 10분 인증 흐름은 AES-256-GCM 암호화 HttpOnly/Secure/SameSite=Lax 쿠키로 전달합니다. 인증 코드 재사용은 제공자가 거부해야 합니다.
- 성공한 `sub`만 서버 비공개 users에 매핑합니다. 자동 회원가입·이메일 기반 관리자 승격 없음.
- 세션은 32바이트 무작위 토큰. 쿠키는 `__Host-session`, HttpOnly, Secure, Path=/, SameSite=Lax. 저장소 키는 SHA-256(token), 값은 subject/만료시각. 토큰은 JSON 본문·로그·브라우저 localStorage에 저장하지 않습니다.
- 권한/부서/사용자 활성 상태는 세션에 고정하지 않고 요청마다 읽습니다. 로그아웃은 세션 객체 삭제. 변조·만료 세션은 401, 비인가 부서는 403.
- 변경 API는 정확한 Origin 검사, JSON content-type, 엄격한 Zod 스키마를 사용합니다. OIDC callback은 state/nonce/PKCE로 검증합니다.
- 인증 제공자 장애, discovery/token 오류 또는 미프로비저닝 상태는 접근을 차단합니다. 비밀값을 오류에 노출하지 않습니다.
- 인증 업체 가입과 실제 OIDC 왕복, MFA·비밀번호 재설정·로그인 제한·제공자 logout/SSO 종료는 검증하지 않았습니다. 현재 logout은 이 앱 세션만 종료합니다. 만료 세션 객체 정리 스케줄도 미구현입니다.

### 현재 저장 어댑터: Netlify Blobs (운영 업무 변경 차단)

최신 공식 문서에는 `onlyIfMatch`, `onlyIfNew` 및 strong consistency가 존재합니다. 그러나 개별 객체 조건부 쓰기는 배정·마감·거래·감사를 한 번에 확정하지 않습니다. Netlify의 2026-08-31 공식 안내는 transactional/relational 데이터와 잔액·read-modify-write에는 DB 사용을 권고합니다. 따라서 **Blobs만으로 회계 무결성이 확보되었다고 판단하지 않습니다.**

- `BlobsRepository`: 비공개 `control/current.json` strong read, 독립적인 session 객체 생성/삭제. 사용자·배정 변경은 503 `WRITE_NOT_VERIFIED`.
- `MemoryRepository`: 한 Node 프로세스에서 synchronous compare-and-update 수행, API 테스트와 로컬 검수용. 서버리스 분산 환경으로 확대할 수 없고 영구 저장·백업도 아닙니다.
- 운영 연동 정보가 없어 실제 Blobs 경쟁 요청/장애/배포 간 지속성을 검증하지 않았습니다.

### 다음 저장 대안 제안: 검증 가능한 CAS 제공자의 비공개 JSON

DB 서버 설치 없이 JSON 조건을 유지하려면 Azure Blob 같은 **ETag 조건부 쓰기를 공식 제공하는 객체 저장소**를 후보로 검토합니다. Azure 공식 문서는 `If-Match` 불일치 시 412를 명시합니다. 아래는 아직 구현·실증하지 않은 설계안입니다.

1. 거래 버전은 `transactions/{departmentId}/{transactionId}/{versionId}.json`에 불변 객체로 생성합니다. 거래에 departmentId·createdBy를 유지합니다.
2. 제어·계정·마감·감사 이벤트·거래 참조의 불변 스냅샷을 작성합니다. 집계는 커밋된 거래 참조만 읽으며 list 결과를 원장으로 사용하지 않습니다.
3. 단 하나의 커밋 manifest를 ETag `If-Match`로 교체하여 활성 스냅샷을 전환합니다. 모든 쓰기가 같은 manifest의 권한·마감 상태를 검증해야 합니다. 이 전환 성공 전 새 객체는 미커밋 상태입니다.
4. 경쟁 변경은 412 → 409. 자동 무조건 덮어쓰기 금지. timeout으로 성공 여부가 불명확한 경우 idempotency key/커밋 ID 재조회. 실패 시 고아 객체 정리는 충분한 보존기간 뒤 별도 수행합니다.
5. 거래 수정·마감·권한 변경이 모두 manifest 경계에 들어가야 교차 객체 불변식을 지킬 수 있습니다. 단순한 거래별 CAS나 인메모리 잠금만으로는 부족합니다.

제약: 전역 경합, manifest 크기와 요청 수 증가, 매번 최신 커밋 확인 비용, 고아 객체·복구 복잡성. 배정 변경의 즉시 효력은 이후 커밋/요청에 정의하며 이미 반환한 응답을 회수할 수 없습니다. 실서비스 CAS 원자성·조건부 생성·read-after-write·장애 응답·접근제어를 재현 테스트하고 데이터 규모 한도를 정하기 전 쓰기를 켜지 않습니다. 이 방식이 요구 처리량을 충족하지 않으면 관리형 DB 전환을 별도 승인 안건으로 제시합니다. DB로 임의 전환하지 않습니다.

### 공식 근거

- [Netlify Blobs API·일관성·제한](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)
- [Netlify 공식 저장소 용도 안내](https://www.netlify.com/knowledge-base/how-to-store-files-and-objects-with-netlify-blobs/)
- [Azure Blob 동시성: If-Match/412](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage)
- [openid-client: discovery·PKCE·authorizationCodeGrant](https://github.com/panva/openid-client)

## C. 폴더·타입·API·라우트·테스트

```text
docs/                 원본 명세, 구현 결정, 단계 보고
src/main.tsx          라우팅, 세션 UI, 대시보드, 관리 화면
src/styles.css        Tailwind 진입점, 다크 디자인, 반응형
server/schema.ts      Zod 논리 JSON 스키마
server/policy.ts      현재 사용자/관리자/부서 인가
server/auth.ts        OIDC, 암호화 흐름 쿠키, 서버 세션
server/store.ts       Repository, Blobs, Memory 어댑터
server/api.ts         표준 오류·검증·Origin 검사·API 라우터
server/local.ts       루프백 전용 로컬 API
server/seed.ts        가상 사용자·부서 (운영 진입점에서 미참조)
netlify/functions/    운영 API 진입점
tests/                API 권한·세션·스키마 테스트
scripts/              빌드 결과 검사
```

스키마: UUID 불변 ID, UTC ISO 시각, 한국 기준 회계일 `YYYY-MM-DD`, 양수 safe integer 원화. users(인증 subject의 유일한 매핑), departments, assignments, control(revision·현재 권한·배정 감사). account/transaction 논리 스키마도 정의했으나 현재 거래 저장 API는 없습니다. 참조·유일성 검증은 실제 쓰기 원자 경계에서 추가해야 하며 Zod 단독으로 보장하지 않습니다. 다음 단계에 closings, opening-balances, 전체 audit, backup manifest 스키마를 추가합니다.

| 현재 API | 동작 |
|---|---|
| GET/POST `/api/auth/login` | OIDC 인증 시작. 미설정이면 503 |
| GET `/api/auth/callback` | PKCE·state·nonce 검증 후 서버 세션 |
| POST `/api/auth/logout` | 세션 삭제·쿠키 만료 |
| GET `/api/me` | 활성 사용자·현재 접근 부서·revision |
| GET `/api/departments` | 허용 부서만 |
| GET `/api/department-context?departmentId=UUID` | 부서 권한 검사 경로 |
| GET `/api/admin/users` | 관리자만, subject 제외 |
| GET/POST `/api/admin/assignments` | 조회/오늘 즉시 교체. 운영 POST 503 |
| GET `/api/admin/audit-logs` | 관리자만, 배정 변경 감사 |
| POST `/api/auth/local` | 로컬 진입점에만 존재, 가상 로그인 |

다음 API는 명세 §10을 그대로 따릅니다: accounts, transactions, reports/monthly, reports/account-monthly, reports/annual, admin/departments, admin/users 변경, admin/closings, admin/backups/export·restore. 미구현 경로는 성공처럼 응답하지 않습니다. 관리자 접두사 경로는 구현 여부와 무관하게 먼저 관리자 검사를 합니다.

배정 POST: `{ departmentId, userIds, effectiveDate, reason, expectedRevision }`. 사용자 본문의 role/userId/actor/createdBy를 신뢰하지 않습니다. 모르는 필드는 422, 충돌은 409, 비인증 401, 권한 없음 403, 운영 변경 미검증 503. 실패 형식은 명세의 `{success:false,error:{code,message}}`입니다. 성공은 `{success:true,data}`입니다.

| 화면 경로 | 상태 |
|---|---|
| `/login` 또는 비인증 경로 | 관리형 로그인 및 로컬 가상 계정 |
| `/` | 대시보드 레이아웃·권한 범위, 회계 KPI는 미연결 표시 |
| `/departments` | 관리자 부서 목록·교체·미리보기 |
| `/users` | 관리자 사용자 읽기 전용 |
| `/audit` | 관리자 배정 감사 before/after |
| `/profile` | 내 정보·허용 부서 |
| `/ledger`, `/accounts` | Phase 2 준비 안내 |
| `/reports`, `/closings` | Phase 3 준비 안내 |
| `/backups` | Phase 4 준비 안내 |

1440px PC 기준 240px 사이드바, 650px 이하 메뉴 드로어·2열 KPI·테이블 가로 스크롤. 명세의 다크 색상·수입 초록·지출 주황을 적용합니다. 빈 자료를 실제 0원 잔액으로 표시하지 않습니다.

### 테스트 계획 및 단계 게이트

- Phase 1: anonymous 401, 범위 밖 403, 관리자 전체·담당자 배정만, 관리자 API 거부, 위조 헤더/본문 거부, 교체 후 동일 세션의 접근 회수와 후임 접근, 다른 배정 유지, 로그아웃 재사용·만료·비활성화·역할 변경, Origin 검사, revision 충돌, 스키마 유일성·참조·정수 검사. 테스트 가상값만 사용.
- Phase 2: 부서별 코드 중복·다른 부서 계정 거부·타입 일치·createdBy 유지·논리삭제·감사, 다른 거래 동시 저장 보존·같은 거래 409·저장 후 timeout 재시도. 실제 원격 저장소 테스트는 별도 격리 저장소 사용.
- Phase 3: 연말/윤년/이월 시작일/누락 기초잔액·합계 오버플로·부서 전체 중복 합산·거래/월별/계정별/연간 합계 일치, 마감과 거래 경합, 관리자도 마감 거래 쓰기 거절, 해제 사유·감사. Excel 파일 재읽기 검증.
- Phase 4: 잘못된 참조·중복 ID·버전·체크섬·권한 없는 복원 차단, 실패 시 기존 데이터 보존, 복원 전 백업·복원 후 건수/금액/이력 일치. 다른 장애 영역의 백업·복원 리허설. 배포 지속성·preview 격리·정적 번들 비밀값 검사, PC/모바일 E2E와 키보드 접근성 확인.
- 원격 OIDC/Blobs, Netlify rewrite·Functions 번들, 동시성·복구 테스트는 배포 환경에서 별도로 통과해야 합니다. 로컬 단위 테스트는 외부 서비스 보장을 대체하지 않습니다.

## D. 단계별 구현 순서

1. Phase 1: 현재 기반 구현 → OIDC 업체 확정/프로비저닝 → 격리 Netlify 사이트 통합시험. 운영 업무 변경 차단 유지.
2. Phase 2: 저장소 선택·검증 → commit/권한 직렬화 → 계정코드·거래·감사·검색·인수인계. 교체 작업은 거래 객체를 변경하지 않는 것으로 검증.
3. Phase 3: 기초잔액·기간 집계 → 통계/드릴다운 → 마감/해제 동시성 → Excel. 모든 계산은 원본 거래 기준.
4. Phase 4: 백업 포맷/정합성 → 복원 미리보기·백업·활성 전환 → 운영 감사/장애 주입 → Netlify 배포 → 실제 통합 검수. 자동 백업은 실행 수단·보존 정책 확정 후 별도 구현.

각 단계의 실행법·검증·변경 파일은 `progress.md`에 기록합니다. 다음 단계의 화면 안내를 해당 업무 기능의 완료로 계산하지 않습니다.
