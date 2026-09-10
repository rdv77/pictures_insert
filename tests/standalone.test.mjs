import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {SqliteStorage} from '../server/storage.mjs';
import {startServer} from '../server/index.mjs';

async function cleanup(dir){const target=await realpath(dir);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('afisha-'));await rm(target,{recursive:true,force:true});}

test('SQLite persistence, pagination, binary bytes and compare-and-swap across connections',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'afisha-storage-'));const a=new SqliteStorage(dir),b=new SqliteStorage(dir);
  try{
    const first=await a.put('one',new Uint8Array([0,1,255]),{customMetadata:{name:'афиша'},onlyIf:{etagDoesNotMatch:'*'}});
    assert.equal(await b.put('one','duplicate',{onlyIf:{etagDoesNotMatch:'*'}}),null);
    const updated=await b.put('one','updated',{onlyIf:{etagMatches:first.etag}});assert.ok(updated);
    assert.equal(await a.put('one','stale',{onlyIf:{etagMatches:first.etag}}),null);
    await a.put('prefix/1','a');await a.put('prefix/2','b');
    const page=await a.list({prefix:'prefix/',limit:1});assert.equal(page.truncated,true);
    assert.equal((await a.list({prefix:'prefix/',cursor:page.cursor,limit:1})).objects[0].key,'prefix/2');
    assert.equal(new TextDecoder().decode(await (await b.get('one')).arrayBuffer()),'updated');
    await a.delete(['prefix/1','prefix/2']);assert.equal((await b.list({prefix:'prefix/'})).objects.length,0);
  }finally{a.close();b.close();await cleanup(dir);}
});

test('standalone HTTP: auth, upload, edit with mock xAI, ZIP, restart and session isolation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'afisha-http-'));let app;
  const originalFetch=globalThis.fetch;const origin='http://localhost:3000';
  const password='test-password-123456789';const authorization='Basic '+Buffer.from('admin:'+password).toString('base64');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS2kAAAAASUVORK5CYII=','base64');
  let providerCalls=0,providerMode='success',lastPrompt='';
  globalThis.fetch=async(input,options)=>{
    if(String(input)==='https://api.x.ai/v1/images/edits'){
      providerCalls++;const body=JSON.parse(options.body);lastPrompt=body.prompt;assert.equal(body.images.length,2);assert.equal(body.model,'grok-imagine-image-2.0');assert.equal(body.response_format,'b64_json');
      if(providerMode==='network')throw new TypeError('simulated network failure');
      if(providerMode==='invalid')return new Response('<html>upstream error</html>');
      if(providerMode==='download')return Response.json({data:[{url:'https://imgen.x.ai/test-result.png'}]});
      return Response.json({data:[{b64_json:png.toString('base64')}]});
    }
    if(String(input)==='https://imgen.x.ai/test-result.png')throw new TypeError('simulated download failure');
    return originalFetch(input,options);
  };
  try{
    app=await startServer({dataDir:dir,port:0,password,origin});let base=`http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await fetch(base+'/api/studio?action=state')).status,401);
    let r=await fetch(base+'/api/studio?action=state',{headers:{authorization}});const cookie=r.headers.get('set-cookie').split(';')[0];
    const api=async(action,body)=>{const headers={authorization,origin,cookie};const options={headers};if(body){options.method='POST';if(body instanceof FormData)options.body=body;else{headers['Content-Type']='application/json';options.body=JSON.stringify(body);}}return fetch(base+'/api/studio?action='+action,options);};
    for(const kind of ['photo','poster']){const form=new FormData();form.set('kind',kind);form.set('file',new Blob([png]),kind+'.png');assert.equal((await api('upload',form)).status,200);}
    assert.equal((await api('plan',{model:'grok-imagine-image-2.0',mode:'balanced',instruction:'Replace poster'})).status,200);
    const state=await(await api('state')).json();const id=state.jobs[0].id;
    const result=await api('edit',{id,key:'fake-test-key-12345'});assert.equal(result.status,200);assert.equal((await result.json()).status,'done');
    assert.equal((await api('edit',{id,key:'fake-test-key-12345'})).status,200);assert.equal(providerCalls,1);
    const zip=await api('export');assert.equal(zip.headers.get('content-type'),'application/zip');assert.equal(new DataView(await zip.arrayBuffer()).getUint32(0,true),0x04034b50);
    const denied=await fetch(base+'/api/studio?action=reset',{method:'POST',headers:{authorization,cookie,origin:'https://wrong.example','Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
    await app.close();app=await startServer({dataDir:dir,port:0,password,origin});base=`http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await(await api('state')).json()).jobs[0].status,'done');
    // Simulate a status write failure after the result was stored: no paid retry.
    const job=(await(await api('state')).json()).jobs[0];job.status='pending';
    await app.storage.put(`sessions/${cookie.split('=')[1]}/jobs/${id}`,JSON.stringify(job),{customMetadata:{job:JSON.stringify(job)}});
    assert.equal((await api('edit',{id,key:'fake-test-key-12345'})).status,200);assert.equal(providerCalls,1);
    const isolated=await fetch(base+'/api/studio?action=state',{headers:{authorization}});assert.equal((await isolated.json()).jobs.length,0);
    assert.equal((await api('instruction',{instruction:'Keep both posters the same size'})).status,200);
    assert.equal((await api('instruction',{instruction:'   '})).status,400);
    const changedState=await(await api('state')).json();
    assert.equal(changedState.config.instruction,'Keep both posters the same size');
    assert.equal(changedState.jobs[0].status,'done');
    assert.equal(providerCalls,1);
    const beforeRegen=(await(await api('state')).json()).jobs[0];
    const regenRequest={id,key:'fake-test-key-12345',regenerate:true,expectedUpdated:beforeRegen.updated,instruction:'Keep both posters the same size; preserve the left edge'};
    assert.equal((await api('edit',regenRequest)).status,200);assert.equal(providerCalls,2);assert.ok(lastPrompt.includes(regenRequest.instruction));
    assert.equal((await api('edit',regenRequest)).status,409);assert.equal(providerCalls,2);
    const beforeFailure=(await(await api('state')).json()).jobs[0];
    const savedKey=`sessions/${cookie.split('=')[1]}/results/${id}`;
    const oldEtag=(await app.storage.head(savedKey)).etag;
    providerMode='invalid';
    assert.equal((await api('edit',{...regenRequest,expectedUpdated:beforeFailure.updated})).status,502);
    assert.equal((await app.storage.head(savedKey)).etag,oldEtag);
    assert.equal((await(await api('state')).json()).jobs[0].needsRegeneration,true);
    await api('retry',{id});providerMode='success';const callsBeforeRetry=providerCalls;
    assert.equal((await api('edit',{id,key:'fake-test-key-12345'})).status,200);
    assert.equal(providerCalls,callsBeforeRetry+1); // Old stored image must not skip regeneration.
    assert.equal((await api('reset',{})).status,200);assert.equal((await(await api('state')).json()).assets.length,0);
    for(const [mode,stage]of [['network','request_xai'],['invalid','decode_response'],['download','download_result']]){
      providerMode=mode;
      for(const kind of ['photo','poster']){const form=new FormData();form.set('kind',kind);form.set('file',new Blob([png]),kind+'.png');await api('upload',form);}
      await api('plan',{model:'grok-imagine-image-2.0',mode:'balanced',instruction:'test'});
      const next=(await(await api('state')).json()).jobs[0];const before=providerCalls;
      const failure=await api('edit',{id:next.id,key:'fake-test-key-12345'});assert.equal(failure.status,502);
      assert.match((await failure.json()).error,new RegExp(stage));assert.equal(providerCalls,before+1);
      assert.equal((await(await api('state')).json()).jobs[0].status,'error');await api('reset',{});
    }
  }finally{globalThis.fetch=originalFetch;await app?.close();await cleanup(dir);}
});

test('public origin or bind requires a password',async()=>{
  await assert.rejects(()=>startServer({origin:'https://afisha.example.com',password:'',port:0}),/APP_PASSWORD/);
  await assert.rejects(()=>startServer({host:'0.0.0.0',password:'',port:0}),/APP_PASSWORD/);
});
