// Streaming, uncompressed ZIP: bounded memory regardless of the batch size.
const encoder = new TextEncoder();
const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export type ZipEntry = { name: string; open: () => Promise<ReadableStream<Uint8Array>> };
function header(size: number) { const b = new Uint8Array(size); return { b, v: new DataView(b.buffer) }; }
export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  async function* generate() {
    const directory: Uint8Array[] = []; let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name); const local = header(30 + name.length); const start = offset;
      local.v.setUint32(0, 0x04034b50, true); local.v.setUint16(4, 20, true); local.v.setUint16(6, 0x0808, true); local.v.setUint16(12, 33, true); local.v.setUint16(26, name.length, true); local.b.set(name,30);
      yield local.b; offset += local.b.length;
      const reader = (await entry.open()).getReader(); let crc = 0xffffffff, size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; for (const b of value) crc = (crc >>> 8) ^ table[(crc ^ b) & 255]; size += value.length; offset += value.length; if (offset > 0xffffffff) throw new Error('ZIP превышает 4 ГБ'); yield value; } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = header(16); descriptor.v.setUint32(0,0x08074b50,true); descriptor.v.setUint32(4,crc,true); descriptor.v.setUint32(8,size,true); descriptor.v.setUint32(12,size,true); yield descriptor.b; offset += 16;
      const central = header(46 + name.length); central.v.setUint32(0,0x02014b50,true); central.v.setUint16(4,20,true); central.v.setUint16(6,20,true); central.v.setUint16(8,0x0808,true); central.v.setUint16(14,33,true); central.v.setUint32(16,crc,true); central.v.setUint32(20,size,true); central.v.setUint32(24,size,true); central.v.setUint16(28,name.length,true); central.v.setUint32(42,start,true); central.b.set(name,46); directory.push(central.b);
    }
    const start = offset; for (const d of directory) { yield d; offset += d.length; }
    const end = header(22); end.v.setUint32(0,0x06054b50,true); end.v.setUint16(8,entries.length,true); end.v.setUint16(10,entries.length,true); end.v.setUint32(12,offset-start,true); end.v.setUint32(16,start,true); yield end.b;
  }
  const iterator = generate();
  return new ReadableStream({ async pull(controller) { try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); } catch (e) { controller.error(e); } }, async cancel() { await iterator.return(undefined); } });
}
