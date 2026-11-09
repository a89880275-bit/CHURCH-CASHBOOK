import { randomBytes } from 'node:crypto';
import { ApiError } from './store';

export type RemoteIdentity = { subject: string; invitationId?: string; application?: string; connection: string; email: string };
export interface InvitationProvider {
  find(email: string): Promise<RemoteIdentity[]>;
  create(input: { email: string; displayName: string; invitationId: string }): Promise<RemoteIdentity>;
  sendPasswordEmail(email: string): Promise<void>;
}
export type ManagementConfig = { domain: string; clientId: string; clientSecret: string; loginClientId: string; issuer: string; connection: string; application: string };

// Provider bodies can contain credentials and PII: only bounded application errors escape.
export function auth0Management(c: ManagementConfig, request: typeof fetch = fetch): InvitationProvider {
  if (!/^[a-zA-Z0-9.-]+$/.test(c.domain) || !c.domain.includes('.') || !c.clientId || !c.clientSecret || !c.loginClientId || c.clientId === c.loginClientId || c.connection !== 'Username-Password-Authentication') throw new ApiError(503, 'INVITATION_NOT_CONFIGURED', '담당자 초대 서버 설정을 확인하세요.');
  const origin = `https://${c.domain.toLowerCase()}`;
  if (new URL(c.issuer).origin !== origin || c.application !== 'https://cool-scone-571b5f.netlify.app') throw new ApiError(503, 'INVITATION_TEST_ONLY', '현재 초대 기능은 지정된 테스트 사이트에서만 사용할 수 있습니다.');
  let token: string | undefined, expires = 0;
  async function accessToken() {
    if (token && Date.now() < expires) return token;
    let response: Response;
    try { response = await request(origin + '/oauth/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret, audience: origin + '/api/v2/', scope: 'create:users read:users' }) }); }
    catch { throw new ApiError(503, 'MANAGEMENT_AUTH_FAILED', '인증 관리 서버에 연결하지 못했습니다.'); }
    if (!response.ok) throw new ApiError(503, 'MANAGEMENT_AUTH_FAILED', '인증 관리 서버의 권한·요청 제한을 확인하세요.');
    const data = await response.json();
    const scopes = new Set(String(data.scope ?? '').split(' '));
    if (typeof data.access_token !== 'string' || !scopes.has('create:users') || !scopes.has('read:users')) throw new ApiError(503, 'MANAGEMENT_AUTH_FAILED', '인증 관리 서버 권한을 확인하세요.');
    token = data.access_token; expires = Date.now() + Math.max(0, Math.min(Number(data.expires_in) || 0, 3600) - 60) * 1000;
    return token!;
  }
  function identity(data: any): RemoteIdentity {
    const identities = Array.isArray(data.identities) ? data.identities : [];
    const db = identities.find((i: any) => i.connection === c.connection && i.provider === 'auth0');
    if (!db || typeof data.user_id !== 'string' || !data.user_id.startsWith('auth0|') || typeof data.email !== 'string') throw new ApiError(502, 'REMOTE_IDENTITY_INVALID', '생성된 인증 계정을 확인하지 못했습니다.');
    return { subject: data.user_id, email: data.email, connection: db.connection, invitationId: data.app_metadata?.cashbook_invitation_id, application: data.app_metadata?.cashbook_application };
  }
  return {
    async find(email) {
      const response = await request(origin + '/api/v2/users-by-email?email=' + encodeURIComponent(email), { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${await accessToken()}` } });
      if (!response.ok) throw new ApiError(503, 'REMOTE_LOOKUP_FAILED', '기존 인증 계정을 조회하지 못했습니다.');
      const data = await response.json();
      if (!Array.isArray(data)) throw new ApiError(502, 'REMOTE_LOOKUP_FAILED', '인증 계정 조회 결과를 확인하지 못했습니다.');
      // Social identities also count as a collision; never auto-link by email.
      return data.map(item => {
        try { return identity(item); }
        catch { return { subject: '', email, connection: '', application: undefined, invitationId: undefined }; }
      });
    },
    async create(input) {
      const bearer = await accessToken();
      let response: Response;
      try {
        response = await request(origin + '/api/v2/users', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({
          connection: c.connection, email: input.email, name: input.displayName,
          password: randomBytes(48).toString('base64url') + '!aA9', email_verified: false, verify_email: false,
          app_metadata: { cashbook_invitation_id: input.invitationId, cashbook_application: c.application },
        }) });
      } catch { throw new ApiError(503, 'CREATE_UNKNOWN', 'Auth0 생성 결과를 확인하지 못했습니다. 복구 조회로 확인하세요.'); }
      if (!response.ok) {
        // A timeout/5xx may have committed upstream. Never blindly repeat creation.
        const known = [400, 401, 403, 409, 422, 429].includes(response.status);
        throw new ApiError(503, known ? 'CREATE_FAILED' : 'CREATE_UNKNOWN', 'Auth0 계정 생성에 실패했거나 결과 확인이 필요합니다.');
      }
      try { return identity(await response.json()); }
      catch { throw new ApiError(503, 'CREATE_UNKNOWN', '생성 응답 확인이 필요합니다. 복구 조회로 확인하세요.'); }
    },
    async sendPasswordEmail(email) {
      let response: Response;
      try { response = await request(origin + '/dbconnections/change_password', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: c.loginClientId, connection: c.connection, email }) }); }
      catch { throw new ApiError(503, 'MAIL_UNKNOWN', '메일 요청 결과를 확인하지 못했습니다. 중복 발송될 수 있으므로 잠시 후 확인하세요.'); }
      if (!response.ok) throw new ApiError(503, response.status >= 500 ? 'MAIL_UNKNOWN' : 'MAIL_FAILED', '비밀번호 설정 메일 요청을 완료하지 못했습니다.');
      // HTTP success is acceptance by Auth0, never proof of mailbox delivery.
    },
  };
}

let provider: InvitationProvider | undefined;
export function configuredInvitations(): InvitationProvider {
  if (process.env.AUTH0_INVITATIONS_ENABLED !== 'true') throw new ApiError(503, 'INVITATION_NOT_CONFIGURED', '담당자 초대 설정이 아직 활성화되지 않았습니다.');
  return provider ??= auth0Management({ domain: process.env.AUTH0_MGMT_DOMAIN ?? '', clientId: process.env.AUTH0_MGMT_CLIENT_ID ?? '', clientSecret: process.env.AUTH0_MGMT_CLIENT_SECRET ?? '', loginClientId: process.env.OIDC_CLIENT_ID ?? '', issuer: process.env.OIDC_ISSUER ?? '', connection: process.env.AUTH0_DATABASE_CONNECTION ?? '', application: process.env.APP_ORIGIN ?? '' });
}
