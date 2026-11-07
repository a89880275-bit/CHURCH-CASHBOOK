# 현재 인증 방식과 운영 연결

2026-11-07: PostgreSQL + JSON 저장소 전환이 승인되어 어댑터와 설정 도구를 추가했습니다. [최신 Netlify/DB 연결 절차](postgres-deployment.md)를 함께 사용하세요. PostgreSQL 선택 시 `BLOBS_STORE` 대신 `STORAGE_DRIVER=postgres`, `DATABASE_URL`, `ACCOUNTING_WRITES_ENABLED`를 설정합니다. 실제 OIDC·관리형 DB 연결 검수는 아직 필요합니다.

현재 운영 코드는 이미 OIDC Authorization Code + PKCE 방식입니다. OIDC는 사용자 로그인 신원 확인에 사용하며 Netlify 배포 인증이나 Blobs 저장소 인증이 아닙니다. 로그인 결과의 `sub`를 비공개 사용자 레코드에 매핑하고, API는 매 요청마다 현재 활성 상태·역할·부서 배정을 다시 검사합니다.

`server/local.ts`의 계정 선택은 127.0.0.1에 바인딩된 비밀번호 없는 검수 도구입니다. 운영 로그인으로 사용하지 않습니다. 현재 별도의 검증된 비밀번호 인증 구현은 없으므로 이를 OIDC로 교체하는 작업도 아닙니다. Netlify 자체가 OIDC를 강제하지는 않지만 현재 운영 인증 코드를 그대로 사용하려면 OIDC 제공자가 필요합니다.

## Auth0를 사용할 경우

1. Auth0에서 tenant와 **Regular Web Application**을 생성합니다. SPA 애플리케이션이 아니라 서버가 코드를 교환하는 웹 앱입니다. [공식 설정 안내](https://auth0.com/docs/quickstart/webapp/express/index)
2. Allowed Callback URLs에 `https://실제사이트/api/auth/callback`을 정확히 등록합니다. localhost나 다른 배포 주소와 혼용하지 않습니다. [Callback 일치 규칙](https://support.auth0.com/center/s/article/Callback-URL-Mismatch-Error-Is-Not-in-the-List-of-Allowed-Callback-URLs)
3. 사용할 로그인 연결과 사용자 계정을 생성합니다. 공용 회원가입 대신 초대/관리자 발급 정책을 정하고, 인증 서비스의 로그인 시도 제한·MFA·비밀번호 복구 정책을 확인합니다. 프로젝트가 임의로 비밀번호를 저장하지 않습니다.
4. Netlify 사이트의 환경변수 설정에 아래 값을 **Functions scope / Production context**로 등록하고 재배포합니다. 비밀값을 Git, `netlify.toml`, `VITE_*` 또는 채팅에 넣지 않습니다. [Functions 환경변수](https://docs.netlify.com/build/functions/environment-variables/)
5. 인증 서비스가 발급한 각 사용자의 실제 `sub`를 비공개 제어 JSON의 사용자와 연결합니다. `local:*` subject를 운영용으로 재사용하지 않습니다. 관리자 역할은 이메일이나 클라이언트 파라미터로 자동 부여하지 않습니다.
6. 운영 저장소 초기화·거래 읽기/쓰기·세션 저장이 연결된 뒤 격리된 사이트/자료로 아래 검수를 수행합니다. 설정만 넣었다고 운영 완료가 되지는 않습니다.

| 변수 | 값/역할 |
| --- | --- |
| `APP_ORIGIN` | 사이트의 실제 HTTPS origin, 끝 `/` 없음 |
| `OIDC_ISSUER` | 예: `https://TENANT.REGION.auth0.com/` — 제공자의 실제 issuer |
| `OIDC_CLIENT_ID` | 생성한 웹 앱의 Client ID |
| `OIDC_CLIENT_SECRET` | 해당 웹 앱의 Client Secret, 서버 전용 |
| `COOKIE_KEY` | 암호학적 난수 32바이트의 64자리 hex. OIDC 흐름 쿠키 암호화용 |
| `BLOBS_STORE` | 비공개 회계 저장소 이름. 사용자 로그인용 값이 아님 |

COOKIE_KEY 생성 명령(직접 실행하고 출력값을 안전한 설정 화면으로 옮김): `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. 생성값을 소스에 기록하지 않습니다.

## 구현 코드의 보안 요소와 미검증 범위

PKCE, state, nonce, ID token 검증은 `openid-client`를 사용합니다. 흐름 쿠키는 AES-GCM으로 보호하고 만료를 확인합니다. 로그인 후에는 무작위 opaque 세션을 발급하고 서버에는 토큰 해시를 저장합니다. 운영 쿠키는 HttpOnly/Secure/SameSite=Lax이며 각 요청에서 세션 만료와 최신 권한을 검사합니다.

실제 인증 서비스 로그인/실패/만료, 잘못된 state·nonce·redirect, 중지 계정, 기존 세션 권한 회수, 로그아웃 후 앱 세션 폐기, 제공자 SSO 세션의 재로그인 정책을 검증해야 합니다. 현재 앱 로그아웃은 앱 세션을 폐기하며 인증 제공자의 전역 로그아웃까지 완료했다고 표시하지 않습니다.

Netlify 배포용 Git 연결 권한과 Blobs 실행환경 권한은 별도입니다. OIDC 로그인 성공이 원격 회계 저장의 동시성·복원 무결성을 보장하지 않습니다. 실제 사이트·OIDC 계정·서버 전용 환경변수가 준비되기 전에는 운영 검수 결과를 만들거나 임시 인증으로 우회하지 않습니다.
