import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** SQLite transactions preserve compare-and-swap semantics across processes. */
export class SqliteStorage {
  constructor(directory) {
    mkdirSync(directory, {recursive:true,mode:0o700});
    this.db = new DatabaseSync(join(directory,'afisha.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS objects (
        key TEXT PRIMARY KEY, etag TEXT NOT NULL, size INTEGER NOT NULL,
        metadata TEXT NOT NULL, http TEXT NOT NULL, data BLOB NOT NULL
      ); PRAGMA user_version=1;`);
  }
  object(row) { return row ? {key:row.key,etag:row.etag,size:row.size,customMetadata:JSON.parse(row.metadata),httpMetadata:JSON.parse(row.http)} : null; }
  async head(key) { return this.object(this.db.prepare('SELECT key,etag,size,metadata,http FROM objects WHERE key=?').get(key)); }
  async get(key) {
    const row=this.db.prepare('SELECT * FROM objects WHERE key=?').get(key);
    if (!row) return null;
    const blob=new Blob([row.data]);
    return {...this.object(row),get body(){return blob.stream();},arrayBuffer:()=>blob.arrayBuffer(),json:async()=>JSON.parse(await blob.text())};
  }
  async put(key,value,options={}) {
    const bytes=typeof value==='string' ? Buffer.from(value) : value instanceof Uint8Array ? value : Buffer.from(await new Response(value).arrayBuffer());
    const etag=randomUUID(); this.db.exec('BEGIN IMMEDIATE');
    try {
      const current=this.db.prepare('SELECT etag FROM objects WHERE key=?').get(key);
      const condition=options.onlyIf;
      if ((condition?.etagMatches && current?.etag!==condition.etagMatches) || (condition?.etagDoesNotMatch && current && (condition.etagDoesNotMatch==='*' || current.etag===condition.etagDoesNotMatch))) {
        this.db.exec('ROLLBACK'); return null;
      }
      this.db.prepare('INSERT INTO objects(key,etag,size,metadata,http,data) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET etag=excluded.etag,size=excluded.size,metadata=excluded.metadata,http=excluded.http,data=excluded.data').run(key,etag,bytes.length,JSON.stringify(options.customMetadata||{}),JSON.stringify(options.httpMetadata||{}),bytes);
      this.db.exec('COMMIT');
      return {key,etag,size:bytes.length,customMetadata:options.customMetadata||{},httpMetadata:options.httpMetadata||{}};
    } catch(error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  async delete(keys) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const remove=this.db.prepare('DELETE FROM objects WHERE key=?');for(const key of typeof keys==='string'?[keys]:keys)remove.run(key);this.db.exec('COMMIT');}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  async list({prefix,cursor='',limit=1000}) {
    const rows=this.db.prepare('SELECT key,etag,size,metadata,http FROM objects WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?').all(prefix.length,prefix,cursor,limit+1);
    const truncated=rows.length>limit;const page=rows.slice(0,limit);
    return {objects:page.map(row=>this.object(row)),truncated,cursor:truncated?page.at(-1).key:undefined};
  }
  close(){this.db.close();}
}
