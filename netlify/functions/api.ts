import { createApi } from '../../server/api';
import { productionRepository } from '../../server/production-store';
import { publishedProduction, type DeploymentContext } from '../../server/deployment-policy';
export default async function handler(req:Request,context?:DeploymentContext){
  try {
    // Preview/branch deploys are denied: site-scoped Blobs otherwise share production data.
    if(!publishedProduction(context))return Response.json({success:false,error:{code:'PRODUCTION_ONLY',message:'미리보기 배포에서는 운영 자료에 접근할 수 없습니다.'}},{status:503,headers:{'cache-control':'no-store'}});
    const origin=process.env.APP_ORIGIN??'';
    if(!origin.startsWith('https://'))throw new Error('configuration');
    const repo=productionRepository();
    return createApi(repo,{origin,sessionBoundary:true,auth:{origin,issuer:process.env.OIDC_ISSUER??'',clientId:process.env.OIDC_CLIENT_ID??'',clientSecret:process.env.OIDC_CLIENT_SECRET??'',cookieKey:process.env.COOKIE_KEY??''}})(req);
  }catch{return Response.json({success:false,error:{code:'NOT_CONFIGURED',message:'서버 설정을 확인해 주세요.'}},{status:503,headers:{'cache-control':'no-store'}});}
}
