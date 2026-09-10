import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { SqliteStorage } from './storage.mjs';
import { handleStudio } from '../lib/studio.ts';

export async function startServer(options={}) {
  const directory=resolve(options.dataDir||process.env.DATA_DIR||'data');
  const host=options.host||process.env.HOST||'127.0.0.1';
  const port=options.port??Number(process.env.PORT||3000);
  const password=options.password??process.env.APP_PASSWORD??'';
  const origin=new URL(options.origin||process.env.APP_ORIGIN||`http://localhost:${port}`).origin;
  const localHosts=['127.0.0.1','localhost','::1','[::1]'];
  if (!password && (!localHosts.includes(host)||!localHosts.includes(new URL(origin).hostname))) throw new Error('APP_PASSWORD is required outside localhost');
  if(password && password.length<16)throw new Error('APP_PASSWORD must have at least 16 characters');
  const hash=value=>createHash('sha256').update(value).digest();
  const storage=new SqliteStorage(directory);
  const web=resolve('dist/web');
  const vite=options.dev ? await (await import('vite')).createServer({server:{middlewareMode:true},appType:'spa'}) : null;
  let active=0;const maxActive=Number(process.env.MAX_ACTIVE_EDITS||4);
  if(!Number.isInteger(maxActive)||maxActive<1||maxActive>16)throw new Error('MAX_ACTIVE_EDITS must be between 1 and 16');
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url||'/',origin);
      if(url.origin!==origin){res.writeHead(400);res.end('Invalid origin');return;}
      if(url.pathname==='/healthz'){res.writeHead(200,{'Content-Type':'text/plain'});res.end('ok');return;}
      if(password){
        const auth=req.headers.authorization||'';let supplied='';
        if(auth.startsWith('Basic ')){const credentials=Buffer.from(auth.slice(6),'base64').toString();supplied=credentials.slice(credentials.indexOf(':')+1);}
        if(!timingSafeEqual(hash(supplied),hash(password))){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Afisha Studio", charset="UTF-8"','Cache-Control':'no-store'});res.end('Authentication required');return;}
      }
      if(url.pathname==='/api/studio'){
        if(!['GET','POST'].includes(req.method)){res.writeHead(405);res.end();return;}
        // Bound incoming bodies even for chunked transfers, before decoding multipart.
        let body;
        if(req.method==='POST'){
          const max=url.searchParams.get('action')==='upload'?10*1024*1024+100000:16000;
          const chunks=[];let length=0;
          for await(const chunk of req){length+=chunk.length;if(length>max){res.writeHead(413,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Слишком большой запрос'}));return;}chunks.push(chunk);}
          body=Buffer.concat(chunks);
        }
        const editing=req.method==='POST'&&url.searchParams.get('action')==='edit';
        if(editing&&active>=maxActive){res.writeHead(429,{'Content-Type':'application/json','Retry-After':'10'});res.end(JSON.stringify({error:'Сервер занят обработкой. Повторите запуск позже.'}));return;}
        if(editing)active++;
        try {
          const headers=new Headers();for(const [name,value]of Object.entries(req.headers)){if(Array.isArray(value))headers.set(name,value.join(', '));else if(value)headers.set(name,value);}
          const response=await handleStudio(new Request(url,{method:req.method,headers,body}),storage);
          res.writeHead(response.status,Object.fromEntries(response.headers));
          if(response.body)await pipeline(Readable.fromWeb(response.body),res);else res.end();
        }finally{if(editing)active--;}
        return;
      }
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
      if(vite){vite.middlewares(req,res);return;}
      let path=resolve(web,'.'+decodeURIComponent(url.pathname));
      if(path!==web&&!path.startsWith(web+sep)){res.writeHead(404);res.end();return;}
      if(url.pathname==='/')path=resolve(web,'index.html');
      const info=await stat(path).catch(()=>null);
      if(!info?.isFile()){res.writeHead(404);res.end('Not found');return;}
      const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'};
      res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Content-Length':info.size,'X-Content-Type-Options':'nosniff','Cache-Control':extname(path)==='.html'?'no-cache':'public, max-age=3600'});
      if(req.method==='HEAD')res.end();else await pipeline(createReadStream(path),res);
    }catch(error){if(!res.headersSent){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Ошибка сервера'}));}else res.destroy();console.error('Request failed:',error.name);}
  });
  server.requestTimeout=300000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return {server,storage,close:async()=>{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await vite?.close();storage.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv.includes('--dev')&&!existsSync('dist/web/index.html'))throw new Error('Run npm run build before npm start');
  const app=await startServer({dev:process.argv.includes('--dev')});
  console.log(`Afisha Studio: ${process.env.APP_ORIGIN||'http://localhost:3000'}`);
  let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(stopping)return;stopping=true;void app.close().then(()=>process.exit(0));});
}
