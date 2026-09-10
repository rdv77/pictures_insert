import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3000';
let cookie='';
async function call(action,body,otherCookie=cookie) {
  const options={headers:{Origin:base,Cookie:otherCookie}};
  if(body){options.method='POST'; if(body instanceof FormData) options.body=body; else {options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}}
  const r=await fetch(`${base}/api/studio?action=${action}`,options); if(r.headers.get('set-cookie')) cookie=r.headers.get('set-cookie').split(';')[0];
  return {status:r.status,data:await r.json()};
}
const first=await call('state'); assert.equal(first.status,200); assert.equal(first.data.assets.length,0);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS2kAAAAASUVORK5CYII=','base64');
for (let i=0;i<12;i++){const f=new FormData();f.set('kind',i<10?'photo':'poster');f.set('file',new Blob([png],{type:'image/png'}),`test-${i}.png`); const r=await call('upload',f);assert.equal(r.status,200,JSON.stringify(r.data));}
const invalid=new FormData();invalid.set('kind','photo');invalid.set('file',new Blob(['bad']),'bad.png');assert.equal((await call('upload',invalid)).status,400);
assert.equal((await call('plan',{mode:'balanced',model:'grok-imagine-image-2.0',instruction:'Replace posters.'})).status,200);
const s=await call('state');assert.equal(s.data.jobs.length,10);const counts={};for(const j of s.data.jobs)counts[j.poster.id]=(counts[j.poster.id]||0)+1;assert.deepEqual(Object.values(counts),[5,5]);
const id=s.data.jobs[0].id;assert.equal((await call('edit',{id,key:''})).status,401);assert.equal((await call('state')).data.jobs[0].status,'pending');
assert.equal((await call('remove',{id})).status,400);assert.equal((await call('export')).status,400);
const saved=cookie;const isolated=await call('state',null,'');assert.equal(isolated.data.assets.length,0);cookie=saved;
const blocked=await fetch(`${base}/api/studio?action=reset`,{method:'POST',headers:{Origin:'https://example.com',Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(blocked.status,403);
assert.equal((await call('reset',{})).status,200);assert.equal((await call('state')).data.assets.length,0);
console.log('PASS: uploads, format validation, balanced plan, saved state, missing-key guard, session isolation, origin guard, reset. No model calls made.');
