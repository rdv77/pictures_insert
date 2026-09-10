import type { StorageBucket, StorageObject } from './storage-types.ts';
import { Buffer } from 'node:buffer';
import { assignments, imageType, filename, prompt, type Asset, type Job, type Config } from './batch.ts';
import { zipStream, type ZipEntry } from './zip.ts';

const MAX_FILE = 10 * 1024 * 1024;
class ApiError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
function fail(message: string, status = 400): never { throw new ApiError(message, status); }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const validId = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9-]{36}$/.test(s);
function session(request: Request) { return request.headers.get('cookie')?.match(/(?:^|;\s*)afisha_session=([a-f0-9]{64})(?:;|$)/)?.[1]; }
function newSession() { return crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-',''); }
function cookie(s: string, secure: boolean) { return `afisha_session=${s}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`; }
async function list(bucket: StorageBucket, prefix: string) {
  const objects: StorageObject[] = []; let cursor: string | undefined;
  do { const options = { prefix, cursor, include: ['customMetadata'], limit: 1000 }; const page = await bucket.list(options); objects.push(...page.objects); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
  return objects;
}
async function state(bucket: StorageBucket, root: string) {
  const [a, j, c] = await Promise.all([list(bucket, `${root}assets/`), list(bucket, `${root}jobs/`), bucket.get(`${root}config`)]);
  const assets = a.map(o => ({ ...JSON.parse(o.customMetadata!.asset) as Asset, size: o.size })).sort((x,y) => x.created-y.created);
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const jobs = j.map(o => { const job = JSON.parse(o.customMetadata!.job) as Job; return { ...job, photo: byId.get(job.photo.id) ?? job.photo, poster: byId.get(job.poster.id) ?? job.poster }; }).sort((x,y) => x.created-y.created);
  return { assets, jobs, config: c ? await c.json<Config>() : null };
}
async function putJob(bucket: StorageBucket, root: string, job: Job, etag?: string) {
  const result = await bucket.put(`${root}jobs/${job.id}`, JSON.stringify(job), { customMetadata: { job: JSON.stringify(job) }, onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' } });
  if (!result) fail('Задание уже изменено в другой вкладке. Обновите страницу.', 409);
  return result;
}
async function getJob(bucket: StorageBucket, root: string, id: unknown) {
  if (!validId(id)) fail('Некорректный номер задания');
  const object = await bucket.get(`${root}jobs/${id}`); if (!object) fail('Задание не найдено', 404);
  return { object, job: await object.json<Job>() };
}
async function bytesLimited(response: Request | Response, max: number) {
  if (!response.body) fail('Пустой ответ модели', 502);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > max) fail('Ответ модели превышает допустимый размер', 502); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk,offset); offset += chunk.length; } return result;
}


export async function handleStudio(request: Request, bucket: StorageBucket): Promise<Response> {
  try {

    if (!bucket) fail('Хранилище ещё не подключено. Попробуйте позже.', 503);
    const url = new URL(request.url), action = url.searchParams.get('action');
    if (request.method === 'POST' && request.headers.get('origin') !== url.origin) fail('Запрос разрешён только из приложения', 403);
    let sid = session(request); let fresh = false;
    if (!sid) { if (request.method !== 'GET' || action !== 'state') fail('Сначала откройте приложение', 401); sid = newSession(); fresh = true; }
    const root = `sessions/${sid}/`;
    if (request.method === 'GET') {
      if (action === 'state') { const result = json(await state(bucket,root)); if (fresh) result.headers.set('Set-Cookie',cookie(sid,url.protocol === 'https:')); return result; }
      if (action === 'file') {
        const id = url.searchParams.get('id'), kind = url.searchParams.get('kind');
        if (!validId(id) || !['asset','result'].includes(kind || '')) fail('Файл не найден',404);
        const object = await bucket.get(`${root}${kind === 'asset' ? 'assets' : 'results'}/${id}`);
        if (!object) fail('Файл не найден',404);
        return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (action === 'export') {
        const snapshot = await state(bucket,root); const done = snapshot.jobs.filter(j => j.status === 'done');
        if (!done.length) fail('Пока нет готовых фотографий');
        const entries: ZipEntry[] = [];
        for (const [index,j] of done.entries()) {
          const head = await bucket.head(`${root}results/${j.id}`); if (!head) fail('Один из результатов не найден', 409);
          const ext = head.httpMetadata?.contentType === 'image/png' ? 'png' : head.httpMetadata?.contentType === 'image/webp' ? 'webp' : 'jpg';
          entries.push({ name: `${String(index+1).padStart(3,'0')}_${filename(j.photo.name.replace(/\.[^.]+$/,''))}.${ext}`, open: async () => { const o = await bucket.get(`${root}results/${j.id}`); if (!o) throw new Error('Result missing'); return o.body; } });
        }
        entries.push({ name: 'report.json', open: async () => new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), jobs: snapshot.jobs.map(j => ({ photo:j.photo.name, poster:j.poster.name, status:j.status, error:j.error })) },null,2)]).stream() });
        return new Response(zipStream(entries), { headers: { 'Content-Type':'application/zip', 'Content-Disposition':'attachment; filename="afisha-results.zip"', 'Cache-Control':'no-store' } });
      }
      fail('Неизвестный запрос',404);
    }
    if (action === 'upload') {
      if (Number(request.headers.get('content-length') || 0) > MAX_FILE + 100000) fail('Файл больше 10 МБ',413);
      const form = await request.formData(); const file = form.get('file'), kind = form.get('kind');
      if (!(file instanceof File) || (kind !== 'photo' && kind !== 'poster')) fail('Выберите изображение');
      if (!file.size || file.size > MAX_FILE) fail('Размер файла должен быть от 1 байта до 10 МБ',413);
      const mime = imageType(new Uint8Array(await file.slice(0,16).arrayBuffer())); if (!mime) fail('Поддерживаются только JPG, PNG и WebP');
      const current = await state(bucket,root);
      if (current.assets.filter(a => a.kind === kind).length >= (kind === 'photo' ? 500 : 50)) fail('Достигнут лимит файлов в серии');
      const id = crypto.randomUUID(); const asset: Asset = { id, kind, size: file.size, name: filename(file.name), created:Date.now(), url:`/api/studio?action=file&kind=asset&id=${id}` };
      await bucket.put(`${root}assets/${id}`, file.stream(), { httpMetadata: { contentType:mime }, customMetadata: { asset:JSON.stringify(asset) } }); return json(asset);
    }
    if (!request.headers.get('content-type')?.includes('application/json')) fail('Ожидается JSON');
    const raw = await bytesLimited(request, 16000); const body = JSON.parse(new TextDecoder().decode(raw));
    if (action === 'reset') {
      const current = await state(bucket,root); if (current.jobs.some(j => j.status === 'running')) fail('Дождитесь завершения текущей обработки');
      const objects = await list(bucket,root); for (let i=0; i<objects.length; i+=100) await bucket.delete(objects.slice(i,i+100).map(o=>o.key));
      return json({ok:true});
    }
    if (action === 'remove') {
      if (!validId(body.id)) fail('Некорректный файл');
      const s = await state(bucket,root); if (s.jobs.some(j => j.photo.id === body.id || j.poster.id === body.id)) fail('Файл используется в очереди');
      await bucket.delete(`${root}assets/${body.id}`); return json({ok:true});
    }
    if (action === 'plan' || action === 'extend') {
      const s = await state(bucket,root); const posters = s.assets.filter(a => a.kind === 'poster');
      const photos = s.assets.filter(a => a.kind === 'photo' && !s.jobs.some(j => j.photo.id === a.id));
      if (!photos.length || !posters.length) fail('Добавьте новые фотографии и хотя бы один макет');
      if (!['balanced','random','sequential'].includes(body.mode) || !['grok-imagine-image-2.0','grok-imagine-image'].includes(body.model) || typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > 3000) fail('Проверьте настройки');
      const settings = { mode:body.mode, model:body.model, instruction:body.instruction };
      const previous = await bucket.get(`${root}config`);
      const config = previous ? await previous.json<Config>() : settings;
      if (!previous) { const saved = await bucket.put(`${root}config`, JSON.stringify(config), { onlyIf:{etagDoesNotMatch:'*'} }); if (!saved) fail('Очередь уже создаётся в другой вкладке',409); }
      const order = assignments(photos.length,posters.length,config.mode);
      for (const [i,photo] of photos.entries()) await putJob(bucket,root,{id:photo.id,photo,poster:posters[order[i]],status:'pending',created:photo.created,updated:Date.now()});
      return json({ok:true});
    }
    if (action === 'retry') {
      const {object,job} = await getJob(bucket,root,body.id);
      if (job.status === 'done' || job.status === 'pending') fail('Задание не требует повтора');
      if (job.status === 'running' && Date.now()-job.updated < 600000) fail('Подождите 10 минут с начала запроса: модель ещё может закончить работу');
      job.status = 'pending'; delete job.error; job.updated = Date.now(); await putJob(bucket,root,job,object.etag); return json({ok:true});
    }
    if (action === 'edit') {
      if (typeof body.key !== 'string' || body.key.length < 10 || body.key.length > 300 || /\s/.test(body.key)) fail('Введите корректный API-ключ xAI',401);
      const {object,job} = await getJob(bucket,root,body.id);
      if (job.status === 'done') return json(job);
      if (job.status !== 'pending') fail('Задание уже запущено. Обновите его состояние.',409);
      const configObject = await bucket.get(`${root}config`); if (!configObject) fail('Настройки очереди не найдены',409);
      const config = await configObject.json<Config>(); job.status = 'running'; job.updated = Date.now();
      const claimed = await putJob(bucket,root,job,object.etag);
      try {
        const images = [];
        for (const asset of [job.photo,job.poster]) { const file = await bucket.get(`${root}assets/${asset.id}`); if (!file) throw new ApiError('Исходное изображение не найдено',404); images.push({type:'image_url',url:`data:${file.httpMetadata?.contentType};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`}); }
        const response = await fetch('https://api.x.ai/v1/images/edits', { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${body.key}`}, body:JSON.stringify({model:config.model,prompt:prompt(config.instruction),images,n:1,response_format:'url'}), signal:AbortSignal.timeout(240000) });
        images.length = 0;
        if (!response.ok) { await response.body?.cancel(); throw new ApiError(response.status === 401 || response.status === 403 ? 'xAI отклонил ключ или доступ к модели. Проверьте ключ и разрешения.' : response.status === 429 ? 'Лимит xAI или недостаточно средств. Проверьте счёт и повторите позже.' : `xAI вернул ошибку ${response.status}. Запрос не повторялся автоматически.`,502); }
        const payload = JSON.parse(new TextDecoder().decode(await bytesLimited(response, 24*1024*1024)));
        const output = payload.data?.[0]; let bytes: Uint8Array;
        if (typeof output?.b64_json === 'string') bytes = Buffer.from(output.b64_json,'base64');
        else if (typeof output?.url === 'string') {
          const target = new URL(output.url); if (target.protocol !== 'https:' || !(target.hostname === 'x.ai' || target.hostname.endsWith('.x.ai'))) throw new ApiError('Модель вернула неподдерживаемый адрес результата',502);
          const image = await fetch(target,{redirect:'error',signal:AbortSignal.timeout(45000)}); if (!image.ok) throw new ApiError('Не удалось получить результат xAI',502); bytes = await bytesLimited(image,18*1024*1024);
        } else throw new ApiError('Модель не вернула изображение. Проверьте инструкции и попробуйте снова.',502);
        const mime = imageType(bytes); if (!mime || bytes.length > 18*1024*1024) throw new ApiError('Некорректный результат модели',502);
        await bucket.put(`${root}results/${job.id}`,bytes,{httpMetadata:{contentType:mime}});
        job.status='done'; job.result=`/api/studio?action=file&kind=result&id=${job.id}`; job.updated=Date.now(); delete job.error;
        await putJob(bucket,root,job,claimed.etag); return json(job);
      } catch (error) {
        job.status='error'; job.updated=Date.now(); job.error=error instanceof ApiError ? error.message : 'Связь с моделью прервалась. Запрос мог быть оплачен. Автоматического повтора нет.';
        await putJob(bucket,root,job,claimed.etag); return json({error:job.error},502);
      }
    }
    fail('Неизвестное действие',404);
  } catch (error) { return json({error:error instanceof ApiError ? error.message : 'Не удалось выполнить операцию. Обновите страницу и попробуйте ещё раз.'},error instanceof ApiError ? error.status : 500); }
}

