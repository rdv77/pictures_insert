import { imageType } from './batch.ts';

const MAX_IMAGE = 10 * 1024 * 1024;
export const MAX_ARCHIVE = 500 * 1024 * 1024;
const crcTable = Array.from({length:256}, (_, n) => { for (let i=0;i<8;i++) n=n&1 ? 0xedb88320^(n>>>1) : n>>>1; return n>>>0; });
function invalid(): never { throw new Error('Повреждённый или неподдерживаемый ZIP-архив'); }
async function bytes(blob: Blob, start: number, length: number) {
  if (start < 0 || length < 0 || start + length > blob.size) invalid();
  return new Uint8Array(await blob.slice(start,start+length).arrayBuffer());
}

// Read the directory first, then stream one image at a time. Never extract paths to disk.
export async function* zipImages(archive: File, remaining: number): AsyncGenerator<File> {
  if (archive.size > MAX_ARCHIVE) throw new Error('ZIP должен быть не больше 500 МБ');
  const tail = await bytes(archive,Math.max(0,archive.size-65557),Math.min(archive.size,65557));
  const view = new DataView(tail.buffer); let end=-1;
  for (let i=tail.length-22;i>=0;i--) if (view.getUint32(i,true)===0x06054b50 && i+22+view.getUint16(i+20,true)===tail.length) { end=i; break; }
  if (end<0) invalid();
  const count=view.getUint16(end+10,true), size=view.getUint32(end+12,true), offset=view.getUint32(end+16,true);
  if (view.getUint16(end+4,true) || view.getUint16(end+6,true) || count!==view.getUint16(end+8,true) || count===65535 || offset===0xffffffff) throw new Error('ZIP64 и многотомные ZIP не поддерживаются');
  if (count>10000 || size>8*1024*1024 || offset+size>archive.size-tail.length+end) invalid();
  const directory=await bytes(archive,offset,size), dv=new DataView(directory.buffer);
  const entries: {name:string; flags:number; method:number; crc:number; compressed:number; original:number; local:number}[]=[];
  let pos=0;
  for (let i=0;i<count;i++) {
    if (pos+46>size || dv.getUint32(pos,true)!==0x02014b50) invalid();
    const length=dv.getUint16(pos+28,true), extra=dv.getUint16(pos+30,true), comment=dv.getUint16(pos+32,true);
    if (pos+46+length+extra+comment>size) invalid();
    const flags=dv.getUint16(pos+8,true);
    const name=new TextDecoder(flags&0x800 ? 'utf-8' : 'windows-1251').decode(directory.subarray(pos+46,pos+46+length)).replaceAll('\\','/');
    if (/\.(jpe?g|png|webp)$/i.test(name) && !name.split('/').some(part=>part.startsWith('.') || part==='__MACOSX')) {
      const entry={name,flags,method:dv.getUint16(pos+10,true),crc:dv.getUint32(pos+16,true),compressed:dv.getUint32(pos+20,true),original:dv.getUint32(pos+24,true),local:dv.getUint32(pos+42,true)};
      if (flags&1) throw new Error('Архив защищён паролем. Загрузите ZIP без пароля');
      if (![0,8].includes(entry.method)) throw new Error('Используйте ZIP со сжатием Deflate или без сжатия');
      if (!entry.original || entry.original>MAX_IMAGE || entry.compressed>MAX_IMAGE+65536) throw new Error(`Изображение ${name} превышает лимит 10 МБ или пустое`);
      entries.push(entry);
    }
    pos+=46+length+extra+comment;
  }
  if (!entries.length) throw new Error('В архиве нет изображений JPG, PNG или WebP');
  if (entries.length>remaining) throw new Error(`В архиве ${entries.length} изображений, доступно мест: ${remaining}`);
  for (const entry of entries) {
    const local=await bytes(archive,entry.local,30), lv=new DataView(local.buffer);
    if (lv.getUint32(0,true)!==0x04034b50 || lv.getUint16(8,true)!==entry.method || lv.getUint16(6,true)!==entry.flags) invalid();
    const start=entry.local+30+lv.getUint16(26,true)+lv.getUint16(28,true);
    if (start+entry.compressed>offset) invalid();
    const input=archive.slice(start,start+entry.compressed).stream();
    const stream=entry.method===8 ? input.pipeThrough(new DecompressionStream('deflate-raw')) : input;
    const reader=stream.getReader(); const output=new Uint8Array(entry.original); let total=0, crc=0xffffffff;
    try {
      while (true) {
        const {done,value}=await reader.read(); if (done) break;
        if (total+value.length>entry.original) invalid();
        output.set(value,total); total+=value.length;
        for (const b of value) crc=(crc>>>8)^crcTable[(crc^b)&255];
      }
    } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
    if (total!==entry.original || ((crc^0xffffffff)>>>0)!==entry.crc) invalid();
    const type=imageType(output); if (!type) throw new Error(`Файл ${entry.name} не является JPG, PNG или WebP`);
    yield new File([output],entry.name.split('/').pop()!,{type});
  }
}
