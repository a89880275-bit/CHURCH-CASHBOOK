# Google 로그인 추가 검토 및 구현 계획

2026-11-09. 계획 문서이며 인증 코드, 외부 서비스 설정, 데이터, 배포는 변경하지 않았다.

## 소스 점검 결과

- server/auth.ts: Auth0 discovery, Authorization Code + PKCE, state, nonce, ID token 검증을 사용하는 서버 로그인이다. 비밀번호는 앱이 수집하거나 저장하지 않는다. 기본 요청 scope는 openid이며 특정 connection을 강제하지 않는다.
- server/policy.ts 및 server/schema.ts: 활성 사용자 한 명에 subject 하나가 연결되며, subject 중복을 금지한다. 권한과 부서 배정은 기존 내부 사용자 ID를 기준으로 유지된다.
- 세션은 임의 토큰의 해시를 서버에 저장한다. HttpOnly/Secure/SameSite=Lax 쿠키 및 서버 세션은 8시간 고정 만료다. 별도 유휴 만료나 로그인 유지 선택은 없다.
- server/api.ts 로그아웃은 앱 세션만 종료한다. Auth0 및 Google 로그인 세션 종료와 구분해야 한다.
- Google 인증 계정 추가 연결, 연결 승인 UI, 연결/해제 감사 이벤트는 아직 없다. 미등록 subject는 현재 앱 로그인에 실패하며 자동 권한 부여는 없다.
- Auth0 관리 API 권한이 없으므로 현재 Google connection 존재 여부, 개발 키 여부, 애플리케이션 연결 상태 및 테넌트 세션 정책은 확인되지 않았다. 소스 점검 결과와 외부 설정 확인을 구분한다.

## 권장 설계

Auth0 Universal Login에 이메일/비밀번호와 Google을 함께 제공한다. 기존 이메일 로그인을 유지한다. Google OAuth 자격증명은 Auth0 연결 설정에 보관하고 프런트엔드나 앱 DB에 저장하지 않는다. 일반 로그인에서 Google connection을 강제하지 않는다.

Auth0 계정 자체 병합 대신 회계프로그램의 인증 계정 매핑을 우선 제안한다. 기존 사용자 ID, primary subject, 부서 배정과 과거 기록을 보존하고 추가 인증 계정의 issuer + subject를 기존 사용자 ID에 연결한다. 이는 Auth0 네이티브 계정 병합과 별개다. 네이티브 병합은 요금제 제공 범위와 주 계정 선택 등을 추가 확인해야 한다.

추가 매핑에는 사용자 ID, issuer, subject, 활성 상태, 신청/승인자 및 시간 등을 기록한다. 전체 매핑과 기존 subject 사이의 중복을 금지한다. 기존 JSON은 호환성 있게 읽고, 마이그레이션 전에 백업한다. 비밀번호나 ID token 원문을 매핑에 저장하지 않는다.

사용자가 기존 로그인으로 다시 본인 인증 → Google 계정 본인 인증 → 서버가 만료 있는 일회용 연결 신청 생성 → 관리자가 대상 사용자와 계정을 확인하고 승인하는 절차를 구현한다. 신청은 인증 결과에 서버에서 결합하며 브라우저가 보낸 subject 문자열을 신뢰하지 않는다. 관리자 승인만으로 두 계정의 소유 확인을 대체하지 않는다. 이메일 일치나 verified 이메일만으로 연결하지 않는다. 미승인 Google 로그인에는 회계 데이터 권한이나 일반 사용자 세션을 부여하지 않는다.

연결/해제와 감사 기록은 동일 트랜잭션으로 저장한다. 연결 취소, 사용자 비활성화, 부서 배정 변경은 다음 API 요청부터 적용하고, 저장 트랜잭션 안에서도 현재 인증 계정 및 사용자 권한을 재검사한다. 추가 계정의 연결 해제 시 해당 계정의 세션을 폐기한다. 마지막 로그인 수단 및 마지막 관리자 보호를 포함한다.

## 순서 및 검수 기준

1. Auth0 Google 연결 현황 확인. 이어 Google Cloud OAuth 자격증명과 동의 화면을 준비한다. Google의 callback은 Auth0 도메인의 /login/callback이며 앱의 /api/auth/callback과 다르다. 업무 적용에는 Auth0 공용 개발 키 대신 자체 Google OAuth 자격증명을 사용한다.
2. 테스트 환경에서 매핑 스키마/이전 데이터 호환/관리자 API/연결 신청과 승인 UI/감사 이력을 구현한다. 기존 로그인과 세션을 회귀 검증한다.
3. Google 연결을 테스트 애플리케이션에만 활성화하고 본인 확인과 관리자 승인을 거쳐 기존 사용자로 로그인되는지 검수한다. 운영 애플리케이션은 변경하지 않는다.
4. 공용 PC 기본 정책을 구현한다. 제안 기본값은 로그인 유지 해제, 서버 유휴 만료 30분, 절대 만료 8시간이다. 입력 손실 방지와 만료 안내를 함께 설계한다. 개인 PC 로그인 유지는 별도 명시적 선택, 제한된 기간 및 토큰 교체/서버 폐기를 구현한 뒤 제공한다. Auth0 로그아웃도 연계하되 Google 전체 로그아웃을 보장하지 않는다. 브라우저 종료만을 보안 경계로 삼지 않는다.
5. 승인 없는 접근, 동일 이메일의 다른 sub, 중복/동시 연결, 재사용/만료된 신청, CSRF/state/nonce 오류, 계정 해제/정지 직후 접근, 부서 격리, 마지막 관리자 보호, 마이그레이션/복원, 모든 테마 로그인 UI를 검증한다. 테스트 배포에서 이메일 및 Google 로그인 각각 실제 브라우저 검수를 완료한 뒤 운영 적용을 별도로 결정한다.

기존 Netlify Functions와 리다이렉트 로그인을 재사용하므로 Netlify 유료 전용 기능을 요구하지 않는 계획이다. Auth0/Google 제공 범위와 계정별 한도는 별도로 확인한다. Google 연결을 위해 Netlify에 새 Google 비밀키를 배포할 필요는 없다. 기존 배포 비밀값의 서버 전용 전달 정책을 유지한다.

## 공식 근거

- Google 연결: https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/google
- 계정 연결 시 두 계정 인증 및 요금제 확인: https://auth0.com/docs/manage-users/user-accounts/user-account-linking
- 세션과 브라우저 쿠키 제한: https://auth0.com/docs/manage-users/sessions/session-lifecycle

현재 사용자 작업은 Auth0 Dashboard > Authentication > Social에서 Google 연결이 존재하는지 확인하는 것 하나다. 이 단계에서는 설정을 저장하거나 기존 로그인 연결을 끄지 않는다. 비밀정보는 공유하지 않는다.
