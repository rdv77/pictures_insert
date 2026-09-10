import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { runConcurrent, editMemoryCost } from '../lib/concurrent.ts';

function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }

test('100 independent jobs run once with at most four requests and preserve IDs', async () => {
  let active=0, peak=0; const done=[];
  const result=await runConcurrent(Array.from({length:100},(_,i)=>i),{concurrency:4,budget:100,cost:()=>1,shouldStop:()=>false,run:async id=>{active++;peak=Math.max(peak,active);await tick();done.push(id);active--;}});
  assert.equal(peak,4);assert.equal(result.completed,100);assert.equal(new Set(done).size,100);assert.deepEqual(result.errors,[]);
});
test('first error stops new dispatch and waits for in-flight successes', async () => {
  const a=deferred(), b=deferred(); const starts=[];let finished=false;
  const run=runConcurrent([0,1,2,3],{concurrency:2,budget:100,cost:()=>1,shouldStop:()=>false,run:id=>{starts.push(id);return id===0?a.promise:b.promise;}}).then(r=>{finished=true;return r;});
  await tick();a.reject(new Error('429'));await tick();assert.deepEqual(starts,[0,1]);assert.equal(finished,false);
  b.resolve();const result=await run;assert.equal(result.completed,1);assert.equal(result.errors.length,1);assert.equal(result.started,2);
});
test('pause drains active requests without starting the rest', async () => {
  let stop=false; const a=deferred();const starts=[];
  const run=runConcurrent([0,1,2],{concurrency:2,budget:100,cost:()=>1,shouldStop:()=>stop,run:async id=>{starts.push(id);await a.promise;}});
  await tick();stop=true;a.resolve();const result=await run;assert.deepEqual(starts,[0,1]);assert.equal(result.completed,2);
});
test('memory budget reduces concurrency for large and legacy assets', async () => {
  let active=0,peak=0;
  const result=await runConcurrent([0,1,2],{concurrency:4,budget:100*1024*1024,cost:()=>editMemoryCost(),shouldStop:()=>false,run:async()=>{active++;peak=Math.max(peak,active);await tick();active--;}});
  assert.equal(peak,1);assert.equal(result.completed,3);
});
test('one-item test run and pre-paused queue do not send additional requests', async()=>{
  let sent=0;const options={concurrency:4,budget:100,cost:()=>1,shouldStop:()=>false,run:async()=>{sent++;}};
  await runConcurrent([1],options);assert.equal(sent,1);
  await runConcurrent([2,3],{...options,shouldStop:()=>true});assert.equal(sent,1);
});
