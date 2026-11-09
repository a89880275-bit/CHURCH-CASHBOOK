# 로그아웃 및 계정 전환 구현·검수

후속: 사용자가 Auth0 Allowed Logout URLs 등록 완료를 확인했고, 공통 계정과목 기능과 함께 테스트 사이트에 배포했다(6af129b1197e2caa33cb3b2a). 실제 Auth0 로그아웃 확인, 고정 callback/state 검증 후 새 인증 화면, 이후 일반 로그인에서도 이전 SSO 자동 재사용 없이 새 인증을 요구하는 것을 확인했다. 이전 SSO의 활성 사용자 매핑 실패는 권한 차단으로 구분했으며 식별자나 제공자 원문 대신 단계/오류 코드만 남긴다. 실제 두 계정의 자격증명을 입력하는 양방향 검수는 아직 사용자 확인이 필요하다. 아래 배포/설정 미완료 표시는 이전 단계 기록이다.

## 구현 내용

- 상단에 ‘로그아웃’과 ‘다른 계정으로 로그인’을 별도 제공한다. 로그인 실패/중지 계정 화면에서도 다른 계정으로 전환할 수 있다.
- POST 로그아웃은 Origin과 현재 쿠키에 결합된 세션 컨텍스트를 확인하고 앱 세션을 삭제·재조회 확인한 뒤 쿠키를 만료시킨다. 비활성/만료 계정은 더 이상 업무 세션을 사용할 수 없으므로 명시적 로그아웃을 계속할 수 있다.
- 이어 Auth0 discovery의 end_session_endpoint로 브라우저를 이동한다. 기존 앱 세션만 지우거나 prompt=login만으로 SSO가 종료됐다고 간주하지 않는다. 새 로그인에서 검증한 sid가 있으면 서버 세션 JSON에 선택적인 logoutHint로 저장해 사용한다. 기존 세션은 그대로 읽으며 SID가 없으면 Auth0 확인 화면이 나타날 수 있다. ID token 원문이나 비밀번호를 저장하지 않는다.
- Auth0의 복귀 주소는 APP_ORIGIN + /api/auth/logout/callback으로 고정한다. 암호화한 HttpOnly 로그아웃 흐름 쿠키와 state/만료/목적을 확인한 뒤 일반 로그아웃은 /signed-out에 도착한다. 계정 전환은 짧은 HttpOnly 전환 쿠키를 발급해 새 PKCE/state/nonce 및 prompt=login/max_age=0 인증을 시작한다. 직접 전환 URL만 입력하면 거부한다.
- Auth0 종료 경로를 준비하지 못하면 앱 종료와 SSO 종료 미확인을 구분한다. 앱 세션 삭제 실패는 성공으로 표시하지 않는다. 새 로그인에서도 기존 principal 정책으로 정확한 sub, 활성 상태, 역할 및 현재 부서 배정을 다시 확인한다.
- 사용자/세션/역할/허용 부서가 바뀌면 업무 트리를 새로 마운트한다. 부서 선택, 거래/통계/초안/사용자 목록/감사/백업 미리보기 등의 화면 메모리를 초기화한다. 서버에 저장된 테마 및 회계자료는 삭제하지 않는다.
- API 요청 취소와 세대 검사를 공통 적용하고 장부 Excel도 같은 경계를 사용한다. 과거 요청 본문이나 다운로드가 늦게 완료되면 폐기한다. 앱이 만든 임시 Object URL을 해제한다. 테마 저장처럼 읽기 후 쓰기를 연결하는 작업도 이전 세대인지 확인한다.
- 다중 탭에 민감정보 없는 계정 변경 이벤트를 전파한다. 로그인 완료와 로그아웃 모두 통지한다. 다른 탭의 자료를 숨기고 상태를 비운 뒤 /me를 재확인한다. pagehide에서 업무 화면을 숨기고 pageshow/focus에서 재확인하며, 성공 렌더링 전까지 이전 DOM을 노출하지 않는다.
- 기존 장부 저장/버림/취소 보호를 유지한다. 다른 변경 폼에도 버림/계속 작성 대화상자를 적용했다. 검색조건 변경에도 보수적으로 확인창이 나타날 수 있다.

## 검수 구분

최종 실행 결과: 전체 20개 테스트 파일 / 254개 테스트 통과. TypeScript + Vite + 독립 Netlify 함수 번들 빌드 성공. 배포 결과물 5개 파일의 실제 DB 접속정보/비밀번호, OIDC 및 Management API Client Secret, 쿠키 키 미포함 검사 통과. 독립 함수 번들 로드/미설정 차단 검사 통과. git diff --check 통과. 검수용 브라우저 탭과 메모리 서버는 종료했다.

자동 테스트의 Auth0 호출은 문서화된 OIDC 계약을 대체한 구현이며 실제 Auth0 SSO 종료 증거가 아니다. 로컬 브라우저 검수 역시 실제 DB에 연결하지 않는 127.0.0.1:5180 메모리 fixture에서 수행했다. 이 fixture를 Netlify에 배포하지 않는다.

- 신규 서버/클라이언트 테스트: 양방향 역할/부서 전환, 폐기 쿠키 재사용 차단, 이전 탭의 쓰기·로그아웃 거부, Origin/외부 복귀 주소 거부, 로그아웃 상태 위조/전환 직접 호출 거부, 서버 삭제 실패 및 Auth0 연결 실패, 늦은 응답과 응답 본문 폐기, 다운로드 정리.
- 로컬 브라우저: 관리자→담당자, 담당자→관리자, 새로고침/뒤로가기 후 새 사용자 표시, 기존 관리자 목록을 열었던 다른 탭에서 목록 제거 및 관리자 전용 화면으로 전환, 로그아웃 전 변경 입력 확인창과 ‘계속 작성’ 후 입력 유지 확인.
- 로컬 fixture에는 회계 거래 읽기 구현이 없으므로 실제 장부·통계 금액을 이용한 브라우저 캐시 검수와 구분한다. 과거 회계 응답 폐기는 독립적인 지연 응답 테스트로 확인한다.
- 실제 테스트 Auth0 tenant의 공개 discovery가 동일 issuer origin의 HTTPS end_session_endpoint를 제공함을 읽기 전용 확인했다. 기존 세션·회계자료를 변경하지 않았다.
- 첫 전체 실행에서 기존 본문 없는 POST 로그아웃 테스트가 415로 실패했다. 기존 빈 POST 요청을 계속 허용하도록 수정한 뒤 해당 저장소/전환 테스트 31개를 재실행해 통과했다. Origin/세션 컨텍스트 검사는 유지한다.

## 배포 전 필요한 사용자 설정 하나

Auth0 Dashboard > Applications > Applications > 기존 회계프로그램 로그인 앱 > URLs 탭 > Allowed Logout URLs에 다음 주소를 기존 항목을 보존하면서 추가하고 저장한다.

https://cool-scone-571b5f.netlify.app/api/auth/logout/callback

M2M 사용자 관리 앱의 URL이 아니다. 로그인 Allowed Callback URLs도 변경하지 않는다. 현재 Management API 앱은 create:users/read:users 권한만 보유하므로 이 설정을 API로 변경하기 위해 권한을 확대하지 않는다.

설정 확인 후 검증된 새 번들을 기존 테스트 사이트에만 배포하고 실제 관리자/담당자 Auth0 로그인과 SSO 종료/확인 화면을 검수한다. 현재 단계에서는 이 신규 코드의 실제 Auth0 양방향 전환과 테스트 사이트 배포가 아직 완료되지 않았다. 운영 사이트/실제 회계자료는 변경하거나 삭제하지 않았다.

## 변경 파일

server/auth.ts, server/api.ts, server/store.ts, server/file-store.ts, server/postgres-store.ts, netlify/functions/api.ts, src/main.tsx, src/client.tsx, src/session-boundary.ts, src/signed-out.tsx, src/leave-guard.tsx, src/theme.tsx, src/download.ts, src/ledger.tsx, tests/account-switching.test.ts, tests/session-boundary.test.ts, 본 문서.

## 실행

pnpm exec vitest run --reporter=dot

pnpm run build

node scripts/check-invitation-build.mjs

node scripts/check-function-bundle.mjs

## 공식 근거

https://auth0.com/docs/authenticate/login/logout/log-users-out-of-auth0

이미 서버에 반영된 저장은 브라우저 요청 취소로 되돌릴 수 없다. 계정 전환은 미래의 요청/표시를 차단하는 것이며 완료된 저장을 소급 취소한다고 설명하지 않는다. 같은 프로필의 탭은 쿠키를 공유하며, 이 기능은 동시 독립 로그인 대신 계정 전환을 제공한다.
