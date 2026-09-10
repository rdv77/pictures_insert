'use client';
/* eslint-disable next/no-img-element -- Private uploaded images require the session cookie and must bypass the image optimizer. */
import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Check, ImagePlus, Layers2, LoaderCircle, Play, Shuffle, Square, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { Progress } from '@/components/ui/progress';
import { runConcurrent, editMemoryCost } from '@/lib/concurrent';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
type Asset = { id: string; name: string; kind: 'photo' | 'poster'; url: string; size?: number };
type Job = { id: string; photo: Asset; poster: Asset; status: 'pending' | 'running' | 'done' | 'error'; error?: string; result?: string };
type Snapshot = { assets: Asset[]; jobs: Job[]; config?: {model:string; mode:string; instruction:string} | null };
const labels = { pending: 'В очереди', running: 'Обработка', done: 'Готово', error: 'Ошибка' };
async function request<T = Snapshot>(action: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/studio?action=${action}`, body instanceof FormData ? { method: 'POST', body } : body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await response.json() as T & {error?: string};
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос');
  return data;
}
export default function Home() {
  const [data, setData] = useState<Snapshot>({ assets: [], jobs: [] });
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [running, setRunning] = useState(false);
  const [message, setMessage] = useState(''), [key, setKey] = useState('');
  const [model, setModel] = useState('grok-imagine-image-2.0'), [mode, setMode] = useState('balanced');
  const [instruction, setInstruction] = useState('Заменить все старые афиши на рекламной тумбе новым макетом. Сохранить окружение, форму тумбы, ракурс, освещение и тени.');
  const [selected, setSelected] = useState<string | null>(null), [exporting, setExporting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const stop = useRef(false), gate = useRef(false);
  const photos = data.assets.filter(a => a.kind === 'photo'), posters = data.assets.filter(a => a.kind === 'poster');
  const done = data.jobs.filter(j => j.status === 'done').length;
  const active = data.jobs.find(j => j.id === selected) || data.jobs.find(j => j.status === 'done');
  async function refresh() { const next = await request('state'); setData(next); if (next.config) { setModel(next.config.model); setMode(next.config.mode); setInstruction(next.config.instruction); } return next as Snapshot; }
  useEffect(() => { void request('state').then(next => { setData(next); if (next.config) { setModel(next.config.model); setMode(next.config.mode); setInstruction(next.config.instruction); } setReady(true); }).catch(e => setMessage(e.message)); }, []);
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [running]);
  async function action(fn: () => Promise<void>) {
    if (gate.current) return;
    gate.current = true; setBusy(true); setMessage('');
    try { await fn(); } catch (e) { setMessage((e as Error).message); }
    finally { await refresh().catch(() => {}); gate.current = false; setBusy(false); }
  }
  async function upload(files: FileList | File[], kind: Asset['kind']) {
    await action(async () => {
      const items = Array.from(files);
      for (let i = 0; i < items.length; i++) {
        setMessage(`Загрузка ${i + 1} из ${items.length}: ${items[i].name}`);
        const form = new FormData(); form.set('file', items[i]); form.set('kind', kind); await request('upload', form);
      }
      setMessage(`Загружено файлов: ${items.length}`);
    });
  }
  async function processBatch(single: boolean) {
    if (!key.trim()) return;
    await action(async () => {
      setRunning(true); stop.current = false;
      try {
        const queue = (await refresh()).jobs.filter(j => j.status === 'pending');
        const result = await runConcurrent(single ? queue.slice(0, 1) : queue, {
          concurrency: single ? 1 : concurrency,
          budget: 100 * 1024 * 1024,
          cost: job => editMemoryCost(job.photo.size, job.poster.size),
          shouldStop: () => stop.current,
          run: async job => {
            setSelected(job.id); setData(d => ({ ...d, jobs: d.jobs.map(j => j.id === job.id ? { ...j, status: 'running' } : j) }));
            try {
              const updated = await request<Job>('edit', { id: job.id, key });
              setData(d => ({ ...d, jobs: d.jobs.map(j => j.id === job.id ? updated : j) }));
            } catch (error) {
              setMessage(`${(error as Error).message} Новые запросы остановлены; ожидаем уже отправленные.`);
              throw error;
            }
          },
        });
        if (result.errors.length) setMessage(`${(result.errors[0] as Error).message} Очередь остановлена, уже отправленные запросы завершены. Повторов не было.`);
        else if (stop.current) setMessage('Очередь приостановлена. Все уже отправленные запросы завершены.');
      } finally { setRunning(false); }
    });
  }
  async function download() {
    setExporting(true); setMessage('Собираем ZIP-архив…');
    try {
      const response = await fetch('/api/studio?action=export');
      if (!response.ok) throw new Error('Не удалось скачать архив');
      const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a');
      a.href = url; a.download = 'afisha-results.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage('Архив скачан. Внутри — готовые фотографии и отчёт о распределении.');
    } catch (e) { setMessage((e as Error).message); } finally { setExporting(false); }
  }
  function UploadZone({ kind, count }: { kind: Asset['kind']; count: number }) {
    // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The composite drop target contains a native input, which cannot be nested in a button.
    return <div role="button" tabIndex={0} aria-label={kind === 'photo' ? 'Загрузить фотографии' : 'Загрузить новые афиши'} onClick={e => { if (e.target === e.currentTarget || !(e.target instanceof HTMLInputElement)) e.currentTarget.querySelector('input')?.click(); }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }} className={`dropzone ${busy || !ready ? 'disabled' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (ready && !busy) void upload(e.dataTransfer.files, kind); }}>
      <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || !ready} onChange={e => { if (e.target.files) void upload(e.target.files, kind); e.target.value = ''; }} />
      <span className="upload-icon">{kind === 'photo' ? <Upload size={24} /> : <ImagePlus size={24} />}</span>
      <strong>{count ? 'Добавить ещё' : kind === 'photo' ? 'Загрузить фотографии' : 'Загрузить новые афиши'}</strong>
      <span>Перетащите сюда или выберите файлы</span><small>JPG, PNG, WebP · до 10 МБ · до {kind === 'photo' ? '500 фото' : '50 макетов'}</small>
    </div>;
  }
  return <div className="studio">
    <header className="topbar"><div className="brand"><span className="brand-icon"><Layers2 size={23} /></span>афиша<span className="brand-caption">STUDIO</span></div><span className="topnote">Пакетная замена изображений</span><span className="private-dot">Личное пространство</span></header>
    <main className="workspace">
      <div className="page-heading"><div><div className="eyebrow">ФОТОГРАФИИ → НОВЫЕ АФИШИ</div><h1>Одна идея. Сотни размещений.</h1><p>Загрузите фотографии, выберите макеты и замените афиши на всей серии.</p></div><Button className="download-button" variant="outline" onClick={download} disabled={!done || exporting}>{exporting ? <LoaderCircle className="spin" /> : <ArrowDownToLine />} Скачать ZIP {done > 0 && <span className="count">{done}</span>}</Button></div>
      <div className="flow"><span><b>01</b> Исходные фотографии</span><ArrowRight /><span><b>02</b> Новые афиши</span><ArrowRight /><span><b>03</b> Замена и результат</span></div>
      {message && <output className="notice">{message}<button aria-label="Закрыть сообщение" onClick={() => setMessage('')}><X size={16} /></button></output>}
      <div className="work-grid"><section className="source-area">
        <div className="upload-grid">{(['photo', 'poster'] as const).map((kind, n) => <section className="panel" key={kind}><div className="panel-title"><h2><span>0{n + 1}</span> {kind === 'photo' ? 'Фотографии' : 'Новые афиши'}</h2><span className="count">{(kind === 'photo' ? photos : posters).length}</span></div><UploadZone kind={kind} count={(kind === 'photo' ? photos : posters).length} /><div className="asset-grid">{(kind === 'photo' ? photos : posters).map(a => <div className={`asset ${kind}`} key={a.id}><img src={a.url} alt={a.name} loading="lazy" /><button disabled={busy || data.jobs.length > 0} onClick={() => action(async () => { await request('remove', { id: a.id }); })} aria-label={`Удалить ${a.name}`}><X size={14} /></button><span title={a.name}>{a.name}</span></div>)}</div></section>)}</div>
        <section className="panel results"><div className="panel-title"><h2><span>03</span> Очередь и результаты</h2><span className="subtle">{done} / {data.jobs.length} готово</span></div>
          {data.jobs.length ? <><Progress value={done / data.jobs.length * 100} aria-label="Готовые фотографии" />
          <div className="job-list">{data.jobs.map(j => <div className={`job ${selected === j.id ? 'selected' : ''}`} key={j.id}><button aria-label={`Открыть ${j.photo.name}`} className="job-select" onClick={() => setSelected(j.id)}><img src={j.photo.url} alt="" /><span><strong>{j.photo.name}</strong><small>→ {j.poster.name}</small></span></button><span className={`status ${j.status}`}>{j.status === 'running' && <LoaderCircle size={14} className="spin" />}{j.status === 'done' && <Check size={14} />}{labels[j.status]}</span>{j.status === 'error' && <button className="text-button" disabled={busy} onClick={() => action(async () => { await request('retry', { id: j.id }); setMessage('Задание в очереди. Следующий запуск отправит новый платный запрос.'); })}>Повторить</button>}</div>)}</div>
          {active && <div className="comparison"><div className="comparison-grid"><figure><img src={active.photo.url} alt="Исходная фотография" /><figcaption>Оригинал</figcaption></figure><figure>{active.result ? <img src={active.result} alt="Фотография с заменённой афишей" /> : <div className="result-pending">{active.status === 'running' ? <LoaderCircle className="spin" /> : <Layers2 />}<span>{active.error || 'Здесь появится результат'}</span></div>}<figcaption>Результат</figcaption></figure></div>{active.status === 'running' && !running && <p className="subtle">Запрос мог продолжить работу. <button className="text-button" onClick={() => refresh().catch(e => setMessage(e.message))}>Обновить</button> · <button className="text-button" disabled={busy} onClick={() => action(async () => { await request('retry', { id: active.id }); })}>Повторить после 10 минут (платно)</button></p>}</div>}</> : <div className="empty-results"><span className="empty-icon"><Layers2 size={30} /></span><h3>Здесь появится ваша новая серия</h3><p>Добавьте фотографии и макеты, затем создайте очередь.<br />Распределение можно проверить до запуска модели.</p></div>}
        </section>
      </section><aside className="settings panel"><div className="panel-title"><h2>Настройки замены</h2><Shuffle size={18} /></div>
        <label className="field-label" htmlFor="model">Модель</label><NativeSelect id="model" value={model} disabled={busy || !!data.jobs.length} onChange={e => setModel(e.target.value)}><option value="grok-imagine-image-2.0">Grok Imagine Image 2.0</option><option value="grok-imagine-image">Grok Imagine Image</option></NativeSelect>
        <label className="field-label" htmlFor="api-key">API-ключ xAI</label><Input id="api-key" type="password" placeholder="xai-…" autoComplete="off" value={key} disabled={running} onChange={e => setKey(e.target.value)} /><p className="help">Ключ хранится только в памяти вкладки. <a href="https://console.x.ai" target="_blank" rel="noreferrer">Получить ключ ↗</a></p>
        <div className="divider" /><label className="field-label" htmlFor="mode">Распределение макетов</label><NativeSelect id="mode" value={mode} disabled={busy || !!data.jobs.length} onChange={e => setMode(e.target.value)}><option value="balanced">Случайно, поровну</option><option value="random">Полностью случайно</option><option value="sequential">По очереди</option></NativeSelect><p className="help">{mode === 'balanced' ? 'Каждый макет используется одинаково часто, с разницей не больше одной фотографии.' : mode === 'random' ? 'Независимый случайный выбор для каждой фотографии.' : 'Макеты чередуются в порядке загрузки.'}</p>
        <label className="field-label" htmlFor="concurrency">Одновременные запросы</label><NativeSelect id="concurrency" value={concurrency} disabled={busy} onChange={e => setConcurrency(Number(e.target.value))}><option value={1}>1 — последовательно</option><option value={2}>2 — рекомендуется</option><option value={3}>3 — параллельно</option><option value={4}>4 — параллельно</option></NativeSelect><p className="help">До {concurrency} фотографий одновременно. Для крупных файлов параллельность снижается автоматически. При ошибке или лимите xAI новые запросы останавливаются. Проба всегда обрабатывает одну фотографию.</p>
        <label className="field-label" htmlFor="instruction">Что заменить</label><Textarea id="instruction" value={instruction} maxLength={3000} disabled={busy || !!data.jobs.length} onChange={e => setInstruction(e.target.value)} rows={5} /><p className="help">Один новый макет на фотографию. Он применяется ко всем указанным афишам в кадре.</p>
        <div className="batch-summary"><div><span>Фотографий</span><strong>{photos.length}</strong></div><div><span>Новых макетов</span><strong>{posters.length}</strong></div></div>
        {!data.jobs.length ? <Button className="primary-action" disabled={busy || !photos.length || !posters.length || !instruction.trim()} onClick={() => action(async () => { await request('plan', { mode, model, instruction }); })}><Shuffle /> Создать очередь</Button> : <><Button className="primary-action" disabled={busy || !key.trim() || !data.jobs.some(j => j.status === 'pending')} onClick={() => processBatch(false)}><Play /> {done ? 'Продолжить обработку' : 'Запустить всю серию'}</Button><Button variant="outline" className="secondary-action" disabled={busy || !key.trim() || !data.jobs.some(j => j.status === 'pending')} onClick={() => processBatch(true)}>Проба на 1 фотографии</Button>{running && <Button variant="outline" className="secondary-action" onClick={() => { stop.current = true; setMessage('Новые запросы остановлены. Ожидаем уже отправленные фотографии.'); }}><Square size={14} /> Приостановить очередь</Button>}<Button variant="ghost" className="secondary-action" disabled={busy} onClick={() => action(async () => { await request('extend', { mode, model, instruction }); })}>Добавить новые фото в очередь</Button></>}
        <p className="help billing">Обработка оплачивается с вашего счёта xAI. Сначала проверьте одну фотографию: модель может изменить мелкий текст или детали сцены.</p><p className="help">Во время обработки держите вкладку открытой. Файлы и результаты сохраняются для этого браузера.</p>
        {data.assets.length > 0 && <Button variant="ghost" className="secondary-action" disabled={busy} onClick={() => setResetOpen(true)}>Начать новую серию</Button>}
      </aside></div><footer><span>АФИША / STUDIO</span><span>Исходники сохраняются отдельно от результатов</span></footer>
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}><AlertDialogContent><AlertDialogTitle>Начать новую серию?</AlertDialogTitle><AlertDialogDescription>Фотографии, макеты и результаты текущей серии будут удалены из приложения. Сначала скачайте нужные результаты.</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>Отмена</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => action(async () => { await request('reset', {}); setSelected(null); setResetOpen(false); })}>Очистить серию</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </main>
  </div>;
}
