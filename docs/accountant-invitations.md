# 테스트 환경 담당자 초대

2026-11-09. 실제 서비스 연결 상태와 로컬 구현을 구분한다.

## 실제 사용자 검수 완료 기록

다음은 테스트 사이트에서 사용자가 직접 수행하고 이 대화에 결과를 확인한 항목이다. 자동화 도구가 실제 브라우저 전 과정을 관찰했다는 의미는 아니다.

| 검수 항목 | 사용자 확인 결과 |
| --- | --- |
| 관리자 초대 화면 및 서버 설정 인식 | 확인 완료 |
| 신규 담당자 초대 메일 수신·본인 비밀번호 설정 | 확인 완료 |
| 담당자 로그인 및 배정 부서 표시 | 확인 완료 |
| 테스트 거래 저장·재조회 | 확인 완료 |
| 관리자 사용자 API 접근 차단 | 확인 완료 |
| 미배정 부서 거래 조회 API 접근 차단 | 확인 완료 |
| 테스트 담당자 중지 후 기존 세션의 API 접근 차단 | 확인 완료 |
| 재활성화·새 로그인·기존 테스트 거래 보존 | 확인 완료 |
| 초대 목록에서 메일 재요청 후 실제 메일 수신 | 확인 완료 |

재발송 검수에서는 새 비밀번호 설정 링크를 누르지 않도록 안내했다. 실제 실패 상황에서의 재시도·동시 요청·응답 유실 복구는 자동 테스트 결과이며 실제 외부 장애 검수와 구분한다. 사용자가 확인한 수신은 해당 메일에 대한 결과이며 기본 발송기의 전달 보장을 의미하지 않는다.

다음 운영 준비 과제는 외부 이메일 발송 서비스 연결이다. 운영 사이트/DB 분리, 운영 대상 백업·복원 및 권한 검수, 배포마다 서버 비밀값 재전달 확인이 남아 있다. Google 로그인/추가 인증 계정 연결은 별도 미완료 과제다. 아래의 미검수/다음 사용자 단계 표시는 이전 시점 기록이며 현재 완료 여부는 이 절을 우선한다. 이번 기록 갱신으로 코드·외부 설정·회계자료·배포를 변경하지 않았다.

## 후속 연결 및 테스트 배포

사용자가 Database Connection의 서버용 앱 ON을 완료했다고 확인했다. scripts/configure-auth0-invitations.mjs로 기존 로그인/DB/쿠키 값이 모두 그대로임을 검사하고 서버용 연결정보를 Git 제외된 .env.local에만 병합했다. 원본 비공개 백업을 남겼다. Management API 읽기 전용 인증/권한 검사를 다시 통과했다.

정확한 사이트 ID ec79b800-9a79-48df-ad6f-3c4015bcb4f7 및 테스트 Neon 브랜치를 다시 확인한 뒤 cool-scone-571b5f에만 배포했다. 배포 ID: 6af112448dc24563968cf506. 새 연결정보 5개는 기존 비밀값 3개와 함께 공식 --secret-env의 Functions 전용 배포 변수로 전달했다. 지속적인 All scopes 변수에 비밀값을 등록하지 않았다. 이 변수는 해당 배포에 한정되므로 이후 배포에도 재전달해야 한다. 운영 사이트/요금제/기존 회계자료는 변경하지 않았다.

직전 전체 237개 테스트 통과에 이어 이번 연결 단계의 초대/배포 경계 27개 테스트, 최신 빌드, 정적 결과물 및 ZIP 5개 항목 실제 비밀값 검사 통과. 배포 후 Auth0 PKCE 요청, 기존 쿠키 키 일치, 실제 DB 세션 조회/미등록 세션 차단, 비로그인 관리자 API 차단, 공개 출력 비밀값 미포함 확인을 통과했다. 검사에서 새 로그인 세션을 만들지 않았다. 현재 브라우저의 테스트 사이트는 로그인 화면이므로 관리자 로그인 후 초대 화면의 서버 설정 인식 확인이 다음 사용자 단계다. 신규 실제 사용자 생성/메일 수신/담당자 첫 로그인은 여전히 미검수다.

아래 ‘아직 배포하지 않음’ 등의 상태는 최초 구현 시점 기록이며, 현재 상태는 이 후속 절을 우선한다.

## 현재 상태

- Management API 전용 M2M 앱 및 read:users/create:users 권한은 사용자 설정 완료, 별도 읽기 전용 검사로 토큰 발급과 사용자 조회 성공을 확인했다.
- Database Connection 이름은 사용자가 `Username-Password-Authentication`으로 확인했다. 해당 연결에서 M2M 앱이 활성화되어 있는지는 아직 미확인이다.
- 사용자 관리 화면에 이름/이메일/담당 부서만 입력하는 초대 폼 및 상태/재시도 목록을 추가했다. 기존 사용자 수정, 수동 sub 등록, 활성/중지 기능은 보존했다.
- 계정 생성/메일 발송은 자동 테스트의 HTTP 대체 구현으로 검증한다. 실제 신규 사용자 생성, 메일 수신, 담당자 첫 로그인, 신규 코드 배포는 아직 실행하지 않았다.
- 실제 DB와 Auth0 설정을 변경하지 않았다. 입력 파일의 비밀값을 공개 환경 파일로 복사하거나 Git에 추가하지 않았다.

## API와 저장

- GET /api/admin/invitations: 관리자 전용 목록과 서버 설정 여부. sub, 작업 식별자, 토큰, 비밀번호를 반환하지 않는다.
- POST /api/admin/invitations: requestId, displayName, email, departmentId, expectedRevision. 역할이나 subject를 입력받지 않는다. 항상 ACCOUNTANT로 생성한다.
- POST /api/admin/invitations/retry: id. 생성 결과 확인/복구 또는 메일 재요청.
- control JSON에 선택적인 invitations 배열을 추가한다. 기존 schemaVersion=1 자료는 계속 읽는다. 사용자 ID, 기존 subject, 권한·거래 구조는 유지한다. 연결된 사용자와 부서 배정은 같은 저장소 트랜잭션으로 기록한다.
- Auth0 생성에는 무작위 초기 비밀번호를 전달하되 표시/기록/재사용하지 않는다. 사용자는 Auth0 비밀번호 재설정 페이지에서 직접 설정한다. 기존 OIDC 코드와 로그인 scope는 바꾸지 않는다.
- Auth0 생성 응답의 정확한 user_id와 서버 작성 app_metadata의 초대 ID/앱 origin/connection을 확인한 뒤 연결한다. 같은 이메일의 기존 사용자나 소셜 계정은 자동 연결하지 않는다.
- 각 저장 단계마다 관리자 활성 상태/권한을 재검사한다. 저장소의 검증된 revision 비교 기능으로 예약/작업 인수/결과를 기록한다. 외부 호출 중 DB 잠금은 유지하지 않는다. 작업 ID로 만료된 작업자의 결과 기록을 차단한다.

## 실패와 한계

Auth0와 PostgreSQL은 원자적 단일 트랜잭션을 지원하는 하나의 시스템이 아니다. 이 구현은 분산 원자성이나 메일 exactly-once를 보장하지 않는다.

생성 응답 유실 또는 DB 연결 저장 실패 후에는 동일 초대의 서버 메타데이터를 Auth0에서 조회해 복구한다. 결과 불명이면서 계정이 발견되지 않으면 재생성하지 않고 보류한다. 확정 실패만 재시도한다. 기존 계정 충돌은 본인 확인 절차가 필요하며 자동 복구하지 않는다. 외부에 생성된 미연결 계정을 임의 삭제하지 않는다.

메일은 Auth0 Authentication API의 POST /dbconnections/change_password를 사용한다. 티켓 생성 API만 호출하고 메일이 발송됐다고 설명하지 않는다. HTTP 성공은 요청 접수이며 실제 전달 보장이 아니다. 요청 결과 불명/응답 후 DB 기록 실패/작업 인수 시 재요청에 중복 메일이 생길 수 있다. 2분 간격, 계정별 시간당 3회, 앱 전체 분당 5회 요청 제한을 적용하되 Auth0 테넌트의 다른 발송량까지 통제하지 않는다.

기본 이메일 발송기는 테스트용이며 전달 보장이 없고 분당 10통 초과 시 폐기될 수 있다. 운영 전에 Auth0 외부 Email Provider를 연결하고 수신 검수한다. 앱의 메일 API는 그대로 재사용할 수 있다. 운영 origin은 현재 코드에서 허용하지 않으므로 별도 운영 검수와 승인 후 확장한다.

앱 사용자 중지는 기존 세션의 다음 API 요청부터 차단한다. 부서 배정/회계자료는 보존한다. Auth0 전체 계정 block이나 Auth0 SSO 세션 폐기는 이번 구현 범위에 포함하지 않으며 update:users 권한도 요구하지 않는다.

현재 회계 백업/복원은 기존처럼 권한을 바꾸지 않는다. 초대 목록/인증 상태는 회계 백업의 복원 대상이 아니며 저장소 전체 스냅샷에 보존된다. 오래된 전체 DB 스냅샷으로 되돌릴 때는 외부 Auth0 상태와 대조가 필요하다.

## 서버 설정 (아직 활성화/배포하지 않음)

AUTH0_INVITATIONS_ENABLED=true
AUTH0_MGMT_DOMAIN=(기존 테스트 로그인과 동일 테넌트)
AUTH0_MGMT_CLIENT_ID=(전용 M2M 앱)
AUTH0_MGMT_CLIENT_SECRET=(서버 비밀값)
AUTH0_DATABASE_CONNECTION=Username-Password-Authentication

기존 OIDC_CLIENT_ID는 로그인 앱 값 그대로 둔다. VITE_ 변수를 만들지 않는다. Netlify Free 배포 시 기존 공식 --secret-env 서버 전용 전달 방식에 M2M secret을 추가하고 빌드/ZIP/로그 유출 검사를 확장해야 한다. 현재 배포 도구가 이 새 비밀값을 전달한다고 가정하지 않는다.

## 다음 사용자 설정 하나

Auth0 Dashboard > Authentication > Database > Username-Password-Authentication > Applications에서 `Junai Cashbook Test User Management` 앱을 활성화한다. 기존 로그인 앱의 활성 상태는 유지한다. 저장 버튼이 표시되는 경우 저장한다. 목록에 앱이 없다면 다른 설정을 변경하지 말고 해당 상태를 알려준다.

## 실행/검수

이번 단계 변경 파일: server/auth0-management.ts, server/invitations.ts, server/schema.ts, server/api.ts, src/invitations.tsx, src/master-data.tsx, src/operations.tsx, .env.example, tests/invitations.test.ts, scripts/check-invitation-build.mjs, 본 문서. 앞선 연결 단계의 scripts/check-auth0-management.mjs 및 비공개 입력 파일을 재사용한다.

- pnpm exec vitest run: 기존 회계/권한/저장소 및 신규 초대 테스트.
- pnpm run build: 타입 확인, Vite, 독립 서버 함수 번들.
- node scripts/check-invitation-build.mjs: 로컬 비밀값이 프런트/서버 배포 결과물에 들어가지 않았는지 검사. 비밀값을 출력하지 않는다.
- node scripts/check-auth0-management.mjs: 외부 읽기 전용 연결 검사. 사용자 생성/메일 발송을 하지 않는다.
- 신규 API 테스트는 실제 임시 JSON 저장소를 사용하고 Auth0 HTTP 호출만 대체한다. 원격 Auth0 생성과 실제 메일 수신을 대신하는 증거가 아니다.

최종 로컬 검수 결과: 전체 18개 파일 / 237개 테스트 통과(신규 초대 20개 포함). pnpm run build 성공. 독립 함수 번들 로드 검사 통과. 배포 결과물 5개 파일의 실제 로컬 DB 비밀번호, 로그인/Management Client Secret, 쿠키 키 포함 여부 검사 통과. 소스맵/환경파일 미포함 확인. 환경 제한으로 최초 테스트 실행이 차단되어 승인된 일반 실행에서 재검증했다. 원격 생성/메일/배포는 여전히 미검수다.

공식 근거:
- https://auth0.com/docs/api/management/v2/users/post-users
- https://auth0.com/docs/api/authentication/change-password/change-password
- https://support.auth0.com/center/s/article/Emails-to-Gmail-from-Auth0-never-arrive
- https://auth0.com/blog/use-terraform-to-manage-your-auth0-configuration/
