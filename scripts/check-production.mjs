// Prints names/status only, never configuration values or credentials.
let failed=false;
const driver=process.env.STORAGE_DRIVER??'blobs';
const names=['APP_ORIGIN','OIDC_ISSUER','OIDC_CLIENT_ID','OIDC_CLIENT_SECRET','COOKIE_KEY',...(driver==='postgres'?['DATABASE_URL']:['BLOBS_STORE'])];
for(const name of names){
  const value=process.env[name];let valid=name==='COOKIE_KEY'?/^[a-fA-F0-9]{64}$/.test(value??''):['APP_ORIGIN','OIDC_ISSUER'].includes(name)?!!value&&value.startsWith('https://'):!!value;
  if(name==='DATABASE_URL'){try{const url=new URL(value??'');valid=['postgres:','postgresql:'].includes(url.protocol)&&!!url.hostname&&!!url.username&&!!url.password&&url.pathname.length>1;for(const [key,v]of url.searchParams)if(!((key==='sslmode'&&['require','verify-ca','verify-full'].includes(v))||(key==='channel_binding'&&v==='require')))valid=false;}catch{valid=false;}}
  console.log(`${valid?'CONFIGURED':'MISSING/INVALID'}: ${name}`);if(!valid)failed=true;
}
console.log(['postgres','blobs'].includes(driver)?`DRIVER: ${driver}`:'INVALID: STORAGE_DRIVER');
if(driver==='postgres')console.log(process.env.ACCOUNTING_WRITES_ENABLED==='true'?'WRITES ENABLED: isolated live verification still required.':'READ ONLY: ACCOUNTING_WRITES_ENABLED is not true.');
console.log('PENDING: live OIDC login, user subject provisioning and Netlify database write/restore verification are required.');
console.log('This configuration-only check never certifies production readiness. Blobs business writes remain disabled.');
process.exitCode=1;
