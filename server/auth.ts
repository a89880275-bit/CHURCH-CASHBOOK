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
  return principal(repo,session.subject);
}
export async function issueSession(repo:Repository,subject:string,local=false){await principal(repo,subject); const token=randomBytes(32).toString('hex'); await repo.putSession(digest(token),{subject,expiresAt:Date.now()+28800000});return sessionCookie(token,28800,!local);}
function seal(value:unknown,key:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv); const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url');}
function unseal(value:string,key:string){const b=Buffer.from(value,'base64url'),decipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),b.subarray(0,12));decipher.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString());}
function validate(c:AuthConfig){if(!/^[a-fA-F0-9]{64}$/.test(c.cookieKey)||!c.clientId||!c.clientSecret||!c.issuer.startsWith('https://')||!c.origin.startsWith('https://'))throw new ApiError(503,'AUTH_NOT_CONFIGURED','인증 제공자 설정이 필요합니다.');}
const flowCookie=(value:string,age=600)=>`__Host-oidc=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
export async function login(c:AuthConfig){
  validate(c);const config=await oidc.discovery(new URL(c.issuer),c.clientId,c.clientSecret);
  const verifier=oidc.randomPKCECodeVerifier(),state=oidc.randomState(),nonce=oidc.randomNonce();
  const url=oidc.buildAuthorizationUrl(config,{redirect_uri:c.origin+'/api/auth/callback',scope:'openid',response_type:'code',code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',state,nonce});
  return new Response(null,{status:302,headers:{location:url.href,'set-cookie':flowCookie(seal({verifier,state,nonce,expiresAt:Date.now()+600000},c.cookieKey))}});
}
export async function callback(req:Request,repo:Repository,c:AuthConfig){
  validate(c);
  try {
    const flow=unseal(cookieValue(req,'__Host-oidc')??'',c.cookieKey);
    if(flow.expiresAt<=Date.now())throw new Error('expired');
    const config=await oidc.discovery(new URL(c.issuer),c.clientId,c.clientSecret);
    const callbackUrl=new URL(c.origin+'/api/auth/callback');callbackUrl.search=new URL(req.url).search;
    const tokens=await oidc.authorizationCodeGrant(config,callbackUrl,{pkceCodeVerifier:flow.verifier,expectedState:flow.state,expectedNonce:flow.nonce,idTokenExpected:true});
    const sub=tokens.claims()?.sub;if(!sub)throw new Error('missing subject');
    const headers=new Headers({location:'/', 'cache-control':'no-store'});headers.append('set-cookie',await issueSession(repo,sub));headers.append('set-cookie',flowCookie('',0));return new Response(null,{status:302,headers});
  } catch {return new Response(null,{status:302,headers:{location:'/login?error=authentication_failed','set-cookie':flowCookie('',0),'cache-control':'no-store'}});}
}
