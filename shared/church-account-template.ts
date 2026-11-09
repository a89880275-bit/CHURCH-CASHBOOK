export type AccountTreatment='NORMAL'|'OPENING_BALANCE'|'REFUND_REVIEW';
const groups=[
 ['INCOME','회비',['정기회비*','특별회비','임시회비']],
 ['INCOME','교회지원',['교회재정*','특별지원금']],
 ['INCOME','헌금',['헌금*','감사헌금','목적헌금']],
 ['INCOME','후원',['개인후원금','단체후원금','선교후원금']],
 ['INCOME','사업수입',['바자회수익금*','물품판매수익','행사참가비','기타사업수입']],
 ['INCOME','기타',['이자수입','환불금','기타수입']],
 ['INCOME','이월',['전년이월*']],
 ['EXPENSE','예배·교육',['예배 및 강사비*','교육훈련비','교재구입비','찬양사역비']],
 ['EXPENSE','행사',['행사비*','수련회비','야유회비','행사물품비']],
 ['EXPENSE','식대·친교',['회의식대비*','친교식대비','다과비','접대비']],
 ['EXPENSE','홍보·행정',['홍보인쇄비*','사무용품비','통신비','수수료']],
 ['EXPENSE','경조·복지',['경조사비*','심방지원비','회원복지비','구제비']],
 ['EXPENSE','선교·봉사',['선교지원비','전도활동비','봉사활동비','장학지원비']],
 ['EXPENSE','운영·물품',['일반소모품비*','비품구입비','시설관리비','교통비','운반비']],
 ['EXPENSE','기타',['감사선물비','특별사업비','기타지출']],
] as const;
let sequence=0;
export const CHURCH_ACCOUNT_TEMPLATE=groups.flatMap(([type,majorCategory,names])=>names.map(raw=>{
 const index=++sequence,name=raw.replace(/\*$/,'');
 return {id:`10000000-0000-4000-8000-${String(index).padStart(12,'0')}`,seedKey:`junae-51-v1-${index}`,code:`${type==='INCOME'?'SI':'SE'}${String(index).padStart(6,'0')}`,name,type,majorCategory,minorCategory:'일반',isDefault:raw.endsWith('*'),treatment:(name==='전년이월'?'OPENING_BALANCE':name==='환불금'?'REFUND_REVIEW':'NORMAL') as AccountTreatment,sortOrder:index*10,status:'ACTIVE' as const};
}));
