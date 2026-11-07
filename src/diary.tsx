import { useContext } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Session } from './client';
import steelRing from './assets/diary-steel-ring.svg';
import pinkBallpoint from './assets/diary-pink-ballpoint.png';
import { House, BookOpen, Shapes, ChartColumn, ChartPie, BadgeCheck, Settings, CloudDownload } from 'lucide-react';

export function DiaryBinder(){return <div className="diary-binder" aria-hidden="true">{Array.from({length:6},(_,i)=><i key={i}><img src={steelRing} alt="" draggable={false}/></i>)}</div>;}
export function DiaryIndexTabs(){
  const {me}=useContext(Session),location=useLocation();
  const tabs=[{to:'/',label:'HOME',text:'대시보드'}, {to:'/ledger',label:'LEDGER',text:'수입·지출 장부'}, {to:'/accounts',label:'ACCOUNT',text:'계정코드'}, {to:'/reports?tab=monthly',label:'MONTH',text:'월별 통계'}, {to:'/reports?tab=accounts',label:'REPORT',text:'계정별 집계'}, ...(me.user.role==='ADMIN'?[{to:'/closings',label:'CLOSE',text:'마감 관리'},{to:'/departments',label:'ADMIN',text:'부서·담당자 관리'},{to:'/backups',label:'BACKUP',text:'백업·복원'}]:[])];
  const icons=[House,BookOpen,Shapes,ChartColumn,ChartPie,BadgeCheck,Settings,CloudDownload];
  const names=['HOME','장부','계정','월별통계','계정별집계','마감','관리','백업'];
  const selectedTab=new URLSearchParams(location.search).get('tab')??'monthly';
  return <nav className="diary-index" aria-label="다이어리 인덱스">{tabs.map((t,i)=>{const Icon=icons[i];const active=location.pathname===t.to.split('?')[0]&&(!t.to.includes('?')||selectedTab===new URLSearchParams(t.to.split('?')[1]).get('tab'));return <Link key={t.label} style={{'--tab-color':['#ef9eb5','#ffdfd5','#ffe7ad','#cce5c8','#c5e9df','#cddff8','#ded0ef','#eed6ef'][i]} as React.CSSProperties} className={active?'selected':''} aria-current={active?'page':undefined} to={t.to} title={t.text} aria-label={t.text}><Icon size={21}/><span>{names[i]}</span></Link>;})}</nav>;
}
export function DiaryDecor(){return <><div className="diary-cover-stitch" aria-hidden="true"/><div className="diary-spine-fold" aria-hidden="true"/><div className="diary-page-outline" aria-hidden="true"><i/><i/></div><div className="diary-flower" aria-hidden="true">✿<span>✿</span><b>❀</b></div><div className="diary-bookmark" aria-hidden="true">♡</div><div className="diary-pen diary-photo-pen" aria-hidden="true"><img src={pinkBallpoint} alt="" draggable={false}/></div><div className="diary-flower-bottom" aria-hidden="true">❀<span>✿</span></div><div className="diary-page-numbers" aria-hidden="true"><span>01 · FINANCIAL DIARY</span><span>기록으로 이어가는 마음 · 02</span></div></>;}
