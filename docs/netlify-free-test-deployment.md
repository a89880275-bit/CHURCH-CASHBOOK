# Netlify 무료 계정 테스트 배포와 비밀값 검증

후속: 실제 Auth0 관리자 로그인 및 승인된 사용자 세션을 확인하고, 격리된 임시 스키마의 실제 Neon 쓰기·충돌·롤백·복원을 검증했습니다. 테스트 사이트의 입력을 활성화했습니다. [최신 후속 결과](neon-remote-write-verification.md). 아래 조회 전용/실제 로그인 미완료 내용은 해당 배포 당시 기록입니다.

대상은 사용자 지정 테스트 사이트 `cool-scone-571b5f` (`ec79b800-9a79-48df-ad6f-3c4015bcb4f7`)뿐입니다. 실제 Netlify API에서 ID·이름·HTTPS 주소를 대조한 후 적용했습니다. 운영 사이트/DB 및 요금제를 변경하지 않았습니다.

## 실제 적용 방식

- 공개 설정 5개: APP_ORIGIN, STORAGE_DRIVER, OIDC_ISSUER, OIDC_CLIENT_ID, ACCOUNTING_WRITES_ENABLED. 이 테스트 사이트의 production context에만 등록하고 메모리에서 값을 대조했습니다. 현재 계정에서 허용하는 기본 All scopes입니다.
- 비밀값 3개: DATABASE_URL, OIDC_CLIENT_SECRET, COOKIE_KEY. 사이트의 All scopes 환경변수에는 등록하지 않았습니다. 공식 Netlify CLI 27.16.2의 `deploy --secret-env`가 생성하는 **배포 전용, scopes=['functions'], is_secret=true** 변수로 전달했습니다. CLI 도움말과 설치된 공식 소스에서 형식을 확인했고 실제 배포도 수락됐습니다.
- 비밀값은 **해당 배포에만 적용**됩니다. 후속 배포에도 같은 안전한 방식으로 다시 전달해야 합니다. Git 기반 자동 배포로 비밀값이 자동 승계된다고 가정하지 않습니다. 배포 실행 도구/검증 기록은 `.private/deployment`에 보관합니다.
- DB URL은 SQL로 생성한 `cashbook_runtime` 전용 역할입니다. 관리자 역할 생성 권한·DB 생성 권한·superuser·BYPASSRLS·neon_superuser 멤버십이 없습니다. cashbook 스키마의 필요한 읽기/삽입, control/sessions 갱신, sessions 삭제만 허용합니다. 거래 원본 UPDATE와 control DELETE가 거절되는지 롤백 트랜잭션 안에서 검증했습니다. 소유자 연결 URL은 로컬 설정에만 유지하고 Netlify에는 전달하지 않았습니다.
- 회계 쓰기는 false입니다. 기존 승인된 관리자/제어 JSON이 초기화 직후 자료와 정확히 같은지 확인했습니다. 부서·배정·거래는 0건입니다.

Functions 전용의 **지속적 사이트 환경변수 범위** 설정은 현재 요금제에서 403(`Upgrade your Netlify account to set specific scopes`)으로 거절됐습니다. 이어 비밀값을 is_secret=false/All scopes로 저장하는 시도는 자동 승인 검토에서 거절되어 실행되지 않았습니다. 이를 우회하지 않고, 공개 설정만 일반 변수로 등록하고 비밀값은 공식 Functions 전용 deploy secret으로 분리했습니다. [Netlify 환경변수 범위](https://docs.netlify.com/build/environment-variables/overview/), [공식 CLI 배포 옵션](https://cli.netlify.com/commands/deploy/)

## 배포 중 수정한 실제 오류

1. Netlify v2 함수는 기존 esbuild 옵션에도 NFT를 강제했습니다. Windows/pnpm 패키지 추적 결과 zod가 누락되어 실제 502가 발생했습니다. 기존 API TS 소스를 단일 ESM으로 사전 번들하고 `node_bundler=none`을 사용해 의존성 누락을 해결했습니다. `.netlify/functions-src/api.mjs`는 생성 산출물이며 Git에서 제외됩니다. 프로젝트 node_modules 밖에서도 로드되는지 검사했습니다.
2. CONTEXT는 해당 런타임에서 제공되지 않아 기존 안전 차단이 503을 반환했습니다. 이를 무조건 허용하는 대신 공식 호출 인자의 `context.deploy.context === 'production' && context.deploy.published === true`를 검사하도록 바꿨습니다. 미리보기·브랜치·미게시 배포는 계속 거절합니다. [Netlify Functions deploy 메타데이터](https://docs.netlify.com/build/functions/api/#deploy)

## 최종 검증 결과

- 전체 자동 테스트: **17개 파일, 217개 통과**.
- `npm run build`를 포함한 실제 `netlify build --context production` 성공, 함수 패키징 성공.
- 게시 상태 ready, 테스트 사이트의 production 배포 ID: `6aee8e63ef9d8ba45ebfd922`.
- 실제 `/api/auth/login`: Auth0 로그인 요청 302 및 설정된 Client ID/복귀 주소/PKCE 확인.
- 실제 서버가 발급한 암호화 흐름 쿠키를 로컬 키로 검증하여 **동일한 COOKIE_KEY를 함수가 읽었음**을 확인했습니다. 쿠키/키/nonce/state 값은 출력하지 않았습니다.
- 임의의 미발급 세션으로 `/api/me` 요청: DB 세션 조회 후 SESSION_EXPIRED 401. DB 연결 환경변수가 실제 함수에서 동작함을 확인했습니다. 인증 없는 관리자 접근 및 잘못된 callback도 차단됐습니다.
- HTML·JS/CSS·로컬 dist·배포 함수 ZIP 전 항목·공개 경로 응답에서 실제 DB URL/비밀번호/Client Secret/쿠키 키가 발견되지 않았습니다. source map은 생성하지 않습니다. 소스 ZIP 업로드도 사용하지 않았습니다.
- 테스트 함수의 최근 45분 로그를 메모리에서 검사하여 실제 비밀값이 없음을 확인했습니다. 원본 로그는 출력하거나 저장하지 않았습니다. 실제 비밀값을 VITE_* 또는 공개 프런트엔드 변수에 넣지 않았습니다.

Client Secret은 함수 설정 검사에서 존재함을 확인했으나 **실제 사용자 로그인 후 토큰 교환까지 완료됐다고 주장하지 않습니다**. 다음 검수는 사용자가 Auth0 화면에서 직접 로그인한 뒤 관리자 대시보드로 돌아오는지 확인하는 것입니다. 비밀번호·토큰·세션 쿠키를 채팅으로 요구하지 않습니다.

## 변경 파일

`scripts/build-functions.mjs`, `scripts/check-function-bundle.mjs`, `scripts/prepare-neon-runtime.ts`, `server/deployment-policy.ts`, `tests/deployment-policy.test.ts`, `netlify/functions/api.ts`, `netlify.toml`, `package.json`, `pnpm-lock.yaml` 및 이 보고서. 이전 Neon/Auth0 연결 변경은 별도 보고서를 참조하세요. 비공개 환경파일과 작업 기록은 Git에 포함하지 않습니다.
