import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import * as oidc from 'openid-client';
import { ApiError, type Repository } from './store';
import { principal } from './policy';
export type AuthConfig={origin:string;issuer:string;clientId:string;clientSecret:string;cookieKey:string};
export function cookieValue(req:Request,name:string){return req.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);}
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const sessionCookie=(value:string,age=28800,secure=true)=>`${secure?'__Host-session':'local-session'}=${value}; Path=/; HttpOnly; ${secure?'Secure; ':''}SameSite=Lax; Max-Age=${age}`;
export async function authenticate(req:Request,repo:Repository,local=false){
  const token=cookieValue(req,local?'local-session':'__Host-session');
  if(!token || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401,'UNAUTHENTICATED','로그인이 필요합니다.');
  const session=await repo.session(digest(token));
  if(!session || session.expiresAt<=Date.now()) throw new ApiError(401,'SESSION_EXPIRED','세션이 만료되었습니다.');
  return {...await principal(repo,session.subject),sessionContext:digest('context:'+token)};
}
export async function issueSession(repo:Repository,subject:string,local=false,logoutHint?:string){await principal(repo,subject); const token=randomBytes(32).toString('hex'); await repo.putSession(digest(token),{subject,expiresAt:Date.now()+28800000,...(logoutHint?{logoutHint}:{})});return sessionCookie(token,28800,!local);}
function seal(value:unknown,key:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv); const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url');}
function unseal(value:string,key:string){const b=Buffer.from(value,'base64url'),decipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),b.subarray(0,12));decipher.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString());}
function validate(c:AuthConfig){if(!/^[a-fA-F0-9]{64}$/.test(c.cookieKey)||!c.clientId||!c.clientSecret||!c.issuer.startsWith('https://')||!c.origin.startsWith('https://'))throw new ApiError(503,'AUTH_NOT_CONFIGURED','인증 제공자 설정이 필요합니다.');}
const flowCookie=(value:string,age=600)=>`__Host-oidc=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
export async function login(c:AuthConfig,force=false){
  validate(c);const config=await oidc.discovery(new URL(c.issuer),c.clientId,c.clientSecret);
  const verifier=oidc.randomPKCECodeVerifier(),state=oidc.randomState(),nonce=oidc.randomNonce();
  const url=oidc.buildAuthorizationUrl(config,{redirect_uri:c.origin+'/api/auth/callback',scope:'openid',response_type:'code',code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',state,nonce});
  if(force){url.searchParams.set('prompt','login');url.searchParams.set('max_age','0');}
  return new Response(null,{status:302,headers:{location:url.href,'set-cookie':flowCookie(seal({verifier,state,nonce,expiresAt:Date.now()+600000},c.cookieKey))}});
}
export async function callback(req:Request,repo:Repository,c:AuthConfig){
  validate(c);
  let stage='FLOW';
  try {
    const flow=unseal(cookieValue(req,'__Host-oidc')??'',c.cookieKey);
    if(flow.expiresAt<=Date.now())throw new Error('expired');
    const config=await oidc.discovery(new URL(c.issuer),c.clientId,c.clientSecret);
    const callbackUrl=new URL(c.origin+'/api/auth/callback');callbackUrl.search=new URL(req.url).search;
    stage='TOKEN';
    const tokens=await oidc.authorizationCodeGrant(config,callbackUrl,{pkceCodeVerifier:flow.verifier,expectedState:flow.state,expectedNonce:flow.nonce,idTokenExpected:true});
    const sub=tokens.claims()?.sub;if(!sub)throw new Error('missing subject');
    stage='PRINCIPAL';await principal(repo,sub);stage='SESSION';
    const old=cookieValue(req,'__Host-session');if(old&&/^[a-f0-9]{64}$/.test(old))await repo.deleteSession(digest(old));
    const sid=tokens.claims()?.sid;
    const headers=new Headers({location:'/?signed_in=1', 'cache-control':'no-store'});headers.append('set-cookie',await issueSession(repo,sub,false,typeof sid==='string'&&sid.length<=1024?sid:undefined));headers.append('set-cookie',flowCookie('',0));return new Response(null,{status:302,headers});
  } catch(error) {
    const code=error instanceof ApiError?error.code:(error as {code?:unknown})?.code;
    // Never log provider descriptions, URLs, tokens, identities or credentials.
    console.warn('OIDC_CALLBACK_FAILED',stage,typeof code==='string'&&/^[A-Z_]{1,64}$/.test(code)?code:'REDACTED');
    return new Response(null,{status:302,headers:{location:'/?error=authentication_failed','set-cookie':flowCookie('',0),'cache-control':'no-store'}});
  }
}

const logoutCookie=(value:string,age=600)=>`__Host-logout=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const switchCookie=(value:string,age=120)=>`__Host-switch=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
export function checkSessionContext(req:Request,local=false,required=true){
  const token=cookieValue(req,local?'local-session':'__Host-session');
  if(!token)return;
  const actual=req.headers.get('x-session-context');
  if((required||actual)&&actual!==digest('context:'+token))throw new ApiError(409,'SESSION_CONTEXT_CHANGED','다른 탭에서 계정이 변경되었습니다. 화면을 다시 확인하세요.');
}
export async function logout(req:Request,repo:Repository,c:AuthConfig|undefined,mode:'logout'|'switch',local=false){
  const token=cookieValue(req,local?'local-session':'__Host-session');
  const previous=token?await repo.session(digest(token)):null;
  if(token){await repo.deleteSession(digest(token));if(await repo.session(digest(token)))throw new ApiError(503,'LOGOUT_FAILED','서버 세션 종료를 확인하지 못했습니다. 다시 시도하세요.');}
  const headers=new Headers({'cache-control':'no-store'});
  headers.append('set-cookie',sessionCookie('',0,!local));
  if(local)return Response.json({success:true,data:{next:'/signed-out',appSignedOut:true}},{headers});
  headers.append('set-cookie',flowCookie('',0));headers.append('set-cookie',switchCookie('',0));
  try{
    if(!c)throw Error('configuration');validate(c);
    const config=await oidc.discovery(new URL(c.issuer),c.clientId,c.clientSecret);
    const endpoint=config.serverMetadata().end_session_endpoint;
    if(!endpoint||new URL(endpoint).origin!==new URL(c.issuer).origin)throw Error('endpoint');
    const state=oidc.randomState();
    const url=oidc.buildEndSessionUrl(config,{client_id:c.clientId,post_logout_redirect_uri:c.origin+'/api/auth/logout/callback',state});
    if(previous?.logoutHint)url.searchParams.set('logout_hint',previous.logoutHint);
    headers.append('set-cookie',logoutCookie(seal({state,mode,expiresAt:Date.now()+600000},c.cookieKey)));
    return Response.json({success:true,data:{next:url.href,appSignedOut:true}},{headers});
  }catch{
    headers.append('set-cookie',logoutCookie('',0));
    return Response.json({success:true,data:{next:'/signed-out?incomplete=1',appSignedOut:true}},{headers});
  }
}
export function logoutCallback(req:Request,c:AuthConfig){
  validate(c);
  const headers=new Headers({'cache-control':'no-store',location:'/signed-out?incomplete=1'});
  headers.append('set-cookie',logoutCookie('',0));
  try{
    const flow=unseal(cookieValue(req,'__Host-logout')??'',c.cookieKey),url=new URL(req.url);
    if(flow.expiresAt<=Date.now()||url.searchParams.has('error')||!flow.state||flow.state!==url.searchParams.get('state')||!['logout','switch'].includes(flow.mode))throw Error('invalid');
    headers.set('location',flow.mode==='switch'?'/api/auth/login?mode=switch':'/signed-out');
    if(flow.mode==='switch')headers.append('set-cookie',switchCookie(seal({expiresAt:Date.now()+120000},c.cookieKey)));
  }catch{/* The app is signed out; never claim IdP completion or start authentication. */}
  return new Response(null,{status:302,headers});
}
export async function switchLogin(req:Request,c:AuthConfig){
  try{const flow=unseal(cookieValue(req,'__Host-switch')??'',c.cookieKey);if(flow.expiresAt<=Date.now())throw Error('expired');}
  catch{throw new ApiError(400,'SWITCH_FLOW_INVALID','계정 전환을 다시 시작하세요.');}
  const response=await login(c,true);response.headers.append('set-cookie',switchCookie('',0));return response;
}
