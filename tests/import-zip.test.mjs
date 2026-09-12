import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crc32,deflateRawSync} from 'node:zlib';
import {zipImages} from '../lib/import-zip.ts';
import {zipStream} from '../lib/zip.ts';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS2kAAAAASUVORK5CYII=','base64');
async function collect(file,remaining=500){const out=[];for await(const image of zipImages(file,remaining))out.push(image);return out;}
function fixture({flags=0x800,crc=crc32(png),size=png.length}={}){
 const name=Buffer.from('folder/афиша.png'),data=deflateRawSync(png);
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(flags,6);local.writeUInt16LE(8,8);local.writeUInt16LE(name.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(flags,8);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(size,24);central.writeUInt16LE(name.length,28);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+data.length,16);
 return new File([local,name,data,central,name,end],'images.zip');
}
test('Deflate ZIP reads nested Cyrillic image, exact bytes and MIME',async()=>{
 const out=await collect(fixture());assert.equal(out[0].name,'афиша.png');assert.equal(out[0].type,'image/png');assert.deepEqual(Buffer.from(await out[0].arrayBuffer()),png);
});
test('multiple stored archives, data descriptors and ignored files',async()=>{
 const archive=async()=>new File([await new Response(zipStream(['a/photo.png','b/photo.png','__MACOSX/._photo.png','readme.txt'].map(name=>({name,open:async()=>new Blob([png]).stream()})))).arrayBuffer()],'stored.zip');
 let total=0;for(const file of [await archive(),await archive()])total+=(await collect(file)).length;assert.equal(total,4);
 await assert.rejects(collect(await archive(),1),/доступно мест/);
});
test('reject password, oversized expansion, incorrect size, corrupt CRC and invalid ZIP',async()=>{
 await assert.rejects(collect(fixture({flags:0x801})),/паролем/);
 await assert.rejects(collect(fixture({size:11*1024*1024})),/10 МБ/);
 await assert.rejects(collect(fixture({size:1})),/ZIP/);
 await assert.rejects(collect(fixture({crc:0})),/ZIP/);
 await assert.rejects(collect(new File(['no zip'],'broken.zip')),/ZIP/);
});
