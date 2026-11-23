import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,generateKeyPairSync,sign} from 'node:crypto';
import {createProjectAdministration} from '../shared/project-administration/portal.mjs';
import {clientScript} from '../shared/project-administration/view.mjs';
import {runInNewContext} from 'node:vm';
import {seal,cookie} from '../shared/sso/client.mjs';
import {ecosystemDecisionMessage} from '../shared/ecosystem-authority.mjs';
const keys=generateKeyPairSync('ed25519'),source=generateKeyPairSync('ed25519'),secret='a'.repeat(64),origin='https://chat.bittrees.org';
const env={BITTREES_ADMIN_SSO_CLIENT_SECRET:secret,ROLES_ECOSYSTEM_REQUEST_PRIVATE_KEY:source.privateKey.export({type:'pkcs8',format:'pem'}),ROLES_ECOSYSTEM_DECISION_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'})};
function session(identity){const sessionSecret=createHmac('sha256',secret).update('bittrees project administration session v1:'+origin).digest('hex');return cookie('project-admin-session',seal({project:'chat',identity,authTime:Date.now(),key:'test-session',expires:Date.now()+60000},sessionSecret),60,origin).split(';')[0];}
for(const identity of ['0x'+'1'.repeat(40),'verified@example.test'])test('Chat authority rechecks grants and revocation for '+(identity.startsWith('0x')?'wallet':'verified email'),async()=>{
 let actions=['project.admin'];
 const handler=createProjectAdministration('chat',{env,fetcher:async(url,init)=>{assert.equal(String(url),'https://roles.bittrees.org/api/authority/ecosystem-decision');const{request}=JSON.parse(init.body),now=Date.now(),decision={version:1,issuer:'https://roles.bittrees.org',audience:request.source,request,enrolled:true,authoritative:true,actions,checkedAt:now,expiresAt:now+5000,requiresPrivateOwnership:true};return Response.json({decision,signature:sign(null,Buffer.from(ecosystemDecisionMessage(decision)),keys.privateKey).toString('base64')});}});
 const read=(route='status')=>handler(new Request(origin+'/api/project-admin/'+route,{headers:{cookie:session(identity)}}));
 const active=await (await read('access')).json();
 assert.equal(active.status,'Shared staff authority verified');
 assert.equal(active.readiness.sharedAuthorityConfigured,true);
 assert.equal((await read()).status,200);actions=[];assert.equal((await read()).status,403);actions=['tier.partner'];assert.equal((await read()).status,403);
 const limited=await (await read('access')).json();
 assert.equal(limited.readiness,undefined);
 assert.equal((await handler(new Request(origin+'/api/project-admin/status'))).status,401);
});

test('administration renders one fresh decision and clears permissions on expiry with sign-out still visible',async()=>{
 const elements=new Map();
 const element=id=>{
  if(!elements.has(id))elements.set(id,{children:[],replaceChildren(){this.children=[];},append(item){this.children.push(item);},removeAttribute(key){delete this[key];}});
  return elements.get(id);
 };
 let deadline, expire;
 const reads=[];
 await runInNewContext(clientScript,{
  document:{getElementById:element,createElement:()=>({})},
  Date:{now:()=>1000},
  clearTimeout:()=>{},setTimeout:(callback,delay)=>{expire=callback;deadline=delay;},
  fetch:async url=>{reads.push(url);return Response.json({identity:'verified@example.test',access:{enrolled:true,expiresAt:5500,actions:['project.admin']},canInspect:true,canManage:true,rolesUrl:'https://roles.bittrees.org/',readiness:{sharedAuthorityConfigured:true},status:'Shared staff authority verified'});},
 });
 assert.deepEqual(reads,['/api/project-admin/access']);
 assert.equal(deadline,4500);
 assert.equal(element('permissions').children.length,1);
 assert.equal(element('manage').hidden,false);
 expire();
 assert.equal(element('permissions').children.length,0);
 assert.equal(element('manage').hidden,true);
 assert.equal(element('status').textContent,'');
 assert.equal(element('staff').hidden,false);
});
