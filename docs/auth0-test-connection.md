# Auth0 테스트 연결 진행 결과

최신: 사용자가 실제 관리자 로그인을 완료했고 승인된 subject의 유효한 관리자 세션을 테스트 DB에서 확인했습니다. [원격 로그인/쓰기 검수 후속 결과](neon-remote-write-verification.md)를 우선 참조하세요. 아래의 로그인 미완료 표시는 당시 기록입니다.

후속 진행: 사용자가 정확한 Auth0 subject를 확인하고 관리자 등록을 명시적으로 승인했습니다. 지정된 Neon 테스트 DB가 비어 있음을 재확인한 후 최초 활성 관리자 1명을 등록했고, JSON/체크섬·정확한 subject·ADMIN 권한·미등록 subject 401 차단을 확인했습니다. 개인 식별정보와 승인 기록은 `.private/deployment`에만 보관합니다. 부서/배정/거래는 0건이고 회계 쓰기는 계속 비활성입니다. 아래 미완료 목록 중 최초 관리자 연결은 완료됐으며 실제 브라우저 로그인/토큰 교환·테스트 사이트 API 배포 검수는 아직 남아 있습니다.

테스트 사이트: `https://cool-scone-571b5f.netlify.app`. 지정한 Neon 테스트 브랜치만 사용하며 기존 운영 환경은 변경하지 않았습니다.

## 완료

- 비공개 `auth0-input.env`의 값을 `.env.local`의 OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET에 연결했습니다. 원본 DB 변수는 보존하고 변경 전 환경파일 사본도 `.private/deployment`에 보관합니다.
- APP_ORIGIN은 테스트 사이트로 제한하고 COOKIE_KEY는 암호학적 난수로 생성합니다. 기존 유효한 키가 있으면 재사용합니다. 회계 쓰기는 false 상태를 요구합니다.
- 다른 Neon 브랜치·운영 사이트 origin·활성화된 회계 쓰기 환경에는 이 설정 도구를 적용할 수 없습니다.
- 기존 server/auth.ts의 Authorization Code + PKCE, state, nonce, 보안 흐름 쿠키를 그대로 사용합니다. 인증 제공자 변경이나 임시 로그인 우회는 없습니다.
- 실제 Auth0 OIDC 검색 및 공개 로그인 요청을 확인했습니다. Auth0가 Client ID와 등록된 복귀 주소를 수락하고 Universal Login으로 302 리다이렉트했습니다. 비밀번호 또는 Client Secret을 이 공개 authorize 요청에 보내지 않습니다.
- 환경 병합/보안 경계 테스트 10개 통과. 실제 로그인 토큰 교환 검증과 구분합니다.
- `npm run build` 성공(`✓ built in 10.84s`). 정적 결과물 검사와 실제 설정된 비밀값의 정적 파일 포함 여부 검사도 통과했습니다. 환경변수 테스트의 선택적 값에 관한 TypeScript 오류를 수정한 뒤 다시 빌드했습니다.

```text
PASS: live Auth0 OIDC discovery; existing login route creates Authorization Code + PKCE, state, nonce and secure flow cookie.
PASS: Auth0 accepted the public client/callback request and redirected to Universal Login.
PENDING: real user sign-in, Client Secret token exchange, initial administrator mapping and deployed callback verification. No application session issued.
```

## 명령

```powershell
node --import tsx scripts/configure-auth0-test.ts
node --env-file=.env.local --import tsx scripts/check-auth0.ts
node node_modules/vitest/vitest.mjs run tests/auth0-setup.test.ts tests/production-boundaries.test.ts
npm run build
```

스크립트는 비밀값을 출력하지 않습니다. `.env.local`, 입력파일, 변경 전 사본은 Git에서 제외합니다. Client Secret을 채팅이나 보고서에 적지 않습니다.

## 아직 미완료

- Auth0에 실제 회계 사용자 생성 및 검증된 subject(sub)를 최초 관리자와 연결하는 작업.
- 사용자 로그인 후 authorization code를 토큰으로 교환하는 과정. 현재 Client Secret 값이 유효하다고 판정하지 않았습니다.
- 테스트 사이트의 실제 서버/API 환경변수 등록 및 배포된 callback 검수. 현재 사이트는 안내 페이지만 존재하고 Netlify 자체 로그인 보호도 관찰됐습니다.
- 운영용 런타임 DB 최소 권한 계정과 실제 회계 쓰기 검수.

이번 작업에서는 외부 사용자를 만들거나 관리자 권한을 자동 부여하지 않았고, Netlify 코드 배포·운영 자료 변경·Git 푸시도 하지 않았습니다. 다음 사용자 작업은 Auth0 User Management에서 테스트 로그인 사용자를 생성하는 것입니다. Auth0 관리 화면의 가입 계정과 앱 사용자는 별개입니다.

## 추가 파일

`server/auth0-setup.ts`, `scripts/configure-auth0-test.ts`, `scripts/check-auth0.ts`, `tests/auth0-setup.test.ts`, 이 보고서. 기존 서버 인증 로직은 변경하지 않았습니다.
