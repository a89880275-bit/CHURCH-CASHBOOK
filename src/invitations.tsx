import { useCallback, useContext, useEffect, useState, type FormEvent } from 'react';
import { api, Session } from './client';
import { Feedback } from './components';

type Invitation = { id: string; email: string; displayName: string; departmentId: string; status: string; nextRetryAt: number; errorCode?: string };
type Data = { configured: boolean; invitations: Invitation[]; revision: number };
const labels: Record<string, string> = { CREATING: '계정 생성 중 / 복구 조회 필요', CREATE_FAILED: '계정 생성 실패', REVIEW_REQUIRED: '기존 계정 본인 확인 필요', ACCOUNT_READY: '계정 등록됨 · 메일 미요청', MAIL_REQUESTING: '메일 요청 중 / 결과 확인 필요', MAIL_ACCEPTED: '메일 요청 접수 · 수신 미확인', MAIL_FAILED: '메일 요청 실패 / 결과 불명' };

export function InvitationsManagement() {
  const { me, refresh } = useContext(Session);
  const [data, setData] = useState<Data>(), [name, setName] = useState(''), [email, setEmail] = useState(''), [department, setDepartment] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [clock, setClock] = useState(Date.now());
  const load = useCallback(async () => { setData(await api<Data>('/admin/invitations')); }, []);
  useEffect(() => { void load().catch(e => setError(e.message)); const timer = window.setInterval(() => setClock(Date.now()), 10000); return () => clearInterval(timer); }, [load]);
  async function act(id?: string) {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<{ message: string }>(id ? '/admin/invitations/retry' : '/admin/invitations', id ? { id } : { requestId, displayName: name, email, departmentId: department, expectedRevision: data!.revision });
      setMessage(result.message);
      if (!id) { setName(''); setEmail(''); setRequestId(crypto.randomUUID()); }
    } catch (e) { setError((e as Error).message); }
    finally {
      try { await load(); await refresh(); window.dispatchEvent(new Event('users-changed')); } catch { setError('상태를 새로 조회하지 못했습니다. 등록 버튼을 반복해서 누르지 말고 다시 조회하세요.'); }
      setBusy(false);
    }
  }
  function submit(e: FormEvent) { e.preventDefault(); void act(); }
  return <section className="panel" style={{ padding: 24, marginBottom: 24 }}>
    <h2>회계담당자 초대</h2>
    <p className="muted">이름·이메일·담당 부서를 입력하면 담당자가 직접 비밀번호를 설정할 수 있도록 메일을 요청합니다. 신규 계정은 회계담당자로 등록됩니다.</p>
    <Feedback error={error} message={message} />
    {data && !data.configured && <p role="status">초대 서버 설정이 아직 활성화되지 않았습니다. 기존 로그인과 사용자 관리는 계속 사용할 수 있습니다.</p>}
    <form onSubmit={submit}><fieldset disabled={busy || !me.writable || !data?.configured}>
      <div className="form-grid">
        <label className="field">담당자 이름<input required maxLength={80} value={name} onChange={e => { setName(e.target.value); setRequestId(crypto.randomUUID()); }} autoComplete="off" /></label>
        <label className="field">이메일<input required type="email" maxLength={254} value={email} onChange={e => { setEmail(e.target.value); setRequestId(crypto.randomUUID()); }} autoComplete="off" /></label>
        <label className="field">담당 부서<select required value={department} onChange={e => { setDepartment(e.target.value); setRequestId(crypto.randomUUID()); }}><option value="">부서를 선택하세요</option>{me.departments.filter(d => d.status === 'ACTIVE').map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      </div><button type="submit" className="primary">{busy ? '처리 중…' : '담당자 등록 및 메일 요청'}</button>
    </fieldset></form>
    <p className="muted small">테스트용 기본 이메일 발송기는 전달을 보장하지 않습니다. 스팸함도 확인하세요. 재요청은 2분 간격, 계정별 시간당 3회로 제한됩니다. 기존 이메일 계정은 자동 연결하지 않습니다.</p>
    <button disabled={busy} onClick={() => void load().catch(e => setError(e.message))}>초대 상태 새로 조회</button>
    <div className="table-scroll"><table><thead><tr><th>담당자 / 이메일</th><th>부서</th><th>초대 상태</th><th>재시도</th></tr></thead><tbody>{data?.invitations.map(i => <tr key={i.id}>
      <td>{i.displayName}<small className="cell-sub">{i.email}</small></td><td>{me.departments.find(d => d.id === i.departmentId)?.name ?? '사용 중지 / 조회 불가'}</td>
      <td>{labels[i.status] ?? i.status}{i.errorCode === 'MAIL_UNKNOWN' && <small className="cell-sub">이전 요청이 접수됐을 수도 있어 재요청 시 중복 메일이 올 수 있습니다.</small>}</td>
      <td><button disabled={busy || !me.writable || !data.configured || i.status === 'REVIEW_REQUIRED' || i.nextRetryAt > clock} onClick={() => { if (window.confirm('메일 요청이 중복될 수 있습니다. 초대 처리 또는 메일 요청을 다시 진행할까요?')) void act(i.id); }}>{i.status.startsWith('MAIL') ? '메일 재요청' : '처리 재시도'}</button></td>
    </tr>)}</tbody></table></div>
  </section>;
}
