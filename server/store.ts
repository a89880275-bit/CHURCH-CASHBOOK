import { getStore } from '@netlify/blobs';
import { controlSchema, type Control, type Transaction, type TransactionRef } from './schema';
export class ApiError extends Error { constructor(public status:number,public code:string,message:string){super(message);} }
export type Session = { subject:string; expiresAt:number };
export interface Repository {
  readonly writable:boolean;
  control():Promise<Control>;
  session(key:string):Promise<Session|null>;
  putSession(key:string,value:Session):Promise<void>;
  deleteSession(key:string):Promise<void>;
  updateControl(expected:number, change:(value:Control)=>Control):Promise<Control>;
  readTransaction?(ref:TransactionRef):Promise<Transaction>;
  putTransaction?(value:Transaction):Promise<TransactionRef>;
  commitLedger?(change:(value:Control)=>Control|Promise<Control>):Promise<Control>;
}
// Test/local only: one process, no disk persistence and no distributed concurrency claim.
export class MemoryRepository implements Repository {
  readonly writable=true;
  private sessions=new Map<string,Session>();
  private state:Control;
  constructor(seed:Control){this.state=controlSchema.parse(seed);}
  async control(){return structuredClone(this.state);}
  async session(key:string){return this.sessions.get(key) ?? null;}
  async putSession(key:string,value:Session){this.sessions.set(key,value);}
  async deleteSession(key:string){this.sessions.delete(key);}
  async updateControl(expected:number,change:(value:Control)=>Control){
    if(this.state.revision!==expected) throw new ApiError(409,'VERSION_CONFLICT','자료가 변경되었습니다. 새로 조회해 주세요.');
    const next=controlSchema.parse(change(structuredClone(this.state)));
    this.state={...next,revision:expected+1}; return structuredClone(this.state);
  }
}
export class BlobsRepository implements Repository {
  readonly writable=false;
  private store;
  constructor(name:string){this.store=getStore({name,consistency:'strong'});}
  async control(){const value=await this.store.get('control/current.json',{type:'json'}); if(!value) throw new ApiError(503,'NOT_PROVISIONED','운영 초기 설정이 필요합니다.'); return controlSchema.parse(value);}
  async session(key:string){return await this.store.get(`sessions/${key}.json`,{type:'json'}) as Session|null;}
  async putSession(key:string,value:Session){await this.store.setJSON(`sessions/${key}.json`,value); const saved=await this.session(key); if(saved?.subject!==value.subject || saved.expiresAt!==value.expiresAt) throw new ApiError(503,'SESSION_STORE_FAILED','로그인을 완료하지 못했습니다.');}
  async deleteSession(key:string){await this.store.delete(`sessions/${key}.json`);}
  async updateControl():Promise<Control>{throw new ApiError(503,'WRITE_NOT_VERIFIED','운영 저장소의 동시성 검증 전에는 변경할 수 없습니다.');}
}
