import { createApi } from '../../server/api';
import { BlobsRepository } from '../../server/store';
export default async function handler(req:Request){
  try {
    // Preview/branch deploys are denied: site-scoped Blobs otherwise share production data.
    if(process.env.CONTEXT!=='production')return Response.json({success:false,error:{code:'PRODUCTION_ONLY',message:'미리보기 배포에서는 운영 자료에 접근할 수 없습니다.'}},{status:503,headers:{'cache-control':'no-store'}});
    const origin=process.env.APP_ORIGIN??'';
    if(!origin.startsWith('https://')||!process.env.BLOBS_STORE)throw new Error('configuration');
    const repo=new BlobsRepository(process.env.BLOBS_STORE);
    return createApi(repo,{origin,auth:{origin,issuer:process.env.OIDC_ISSUER??'',clientId:process.env.OIDC_CLIENT_ID??'',clientSecret:process.env.OIDC_CLIENT_SECRET??'',cookieKey:process.env.COOKIE_KEY??''}})(req);
  }catch{return Response.json({success:false,error:{code:'NOT_CONFIGURED',message:'서버 설정을 확인해 주세요.'}},{status:503,headers:{'cache-control':'no-store'}});}
}
