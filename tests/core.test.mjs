import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { assignments, imageType, filename } from '../lib/batch.ts';
import { zipStream } from '../lib/zip.ts';
test('100 photos use both posters exactly 50 times', () => {
  const values = assignments(100,2,'balanced'); assert.equal(values.filter(v=>v===0).length,50); assert.equal(values.filter(v=>v===1).length,50);
  for (let n=1;n<151;n++) { const a = assignments(n,7,'balanced'); const counts=Array.from({length:7},(_,i)=>a.filter(v=>v===i).length); assert.ok(Math.max(...counts)-Math.min(...counts)<=1); }
});
test('sequential and independent random assignments', () => {
  assert.deepEqual(assignments(5,2,'sequential'),[0,1,0,1,0]); assert.deepEqual(assignments(3,2,'random',()=>.9),[1,1,1]); assert.throws(()=>assignments(3,0,'balanced'));
});
test('image signatures and safe export names',()=>{ assert.equal(imageType(new Uint8Array([255,216,255])),'image/jpeg'); assert.equal(imageType(new TextEncoder().encode('<svg>')) ,null); assert.equal(filename('../a\\b.png'),'.._a_b.png'); });
test('ZIP streams UTF-8 names and multiple chunks',async()=>{
  const bytes = new Uint8Array(await new Response(zipStream([{name:'афиша.txt',open:async()=>new Blob(['первая',' вторая']).stream()},{name:'empty.txt',open:async()=>new Blob([]).stream()}])).arrayBuffer());
  assert.equal(new DataView(bytes.buffer).getUint32(0,true),0x04034b50); await mkdir('work',{recursive:true}); await writeFile('work/test.zip',bytes);
});
