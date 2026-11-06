import { useEffect, useId, useRef, type ReactNode } from 'react';
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => { const element = ref.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={ref} className="modal" aria-labelledby={id} onCancel={e => { e.preventDefault(); onClose(); }}><h2 id={id}>{title}</h2>{children}</dialog>;
}
export function PageTitle({ title, description, eyebrow = 'MASTER DATA' }: { title: string; description: string; eyebrow?: string }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="muted">{description}</p></div></div>;
}
export function Feedback({ error, message }: { error: string; message: string }) {
  return <>{error && <div role="alert" className="error">{error}</div>}{message && <div role="status" className="success">{message}</div>}</>;
}
