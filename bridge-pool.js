import http from 'node:http'
import { fork } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import mime from 'mime-types'
import parseTorrent from 'parse-torrent'
import { catalog } from './lib/catalog.js'
import { createLanProxy } from './lib/lan-proxy.js'
import { backendAccess, allowedOrigin } from './lib/backend-access.js'
import { accountsStore } from './lib/accounts-store.js'
import { accounts } from './lib/accounts.js'
const host = process.env.TORFILMS_BRIDGE_HOST || '127.0.0.1'
const port = Number(process.env.TORFILMS_BRIDGE_PORT || process.env.PORT || 18183)
const ram = Number(process.env.TORFILMS_BRIDGE_RAM_MB || 256)
const maximum = Number(process.env.TORFILMS_BRIDGE_WORKERS || 4)
if (!Number.isInteger(maximum) || maximum < 1 || maximum > 8 || !Number.isFinite(ram) || ram < 32 || ram > 2048) throw new Error('Invalid worker / RAM limit')
const root = fileURLToPath(new URL('./public/p2p/', import.meta.url))
const library = catalog(process.env.TORFILMS_CATALOG_DIR || fileURLToPath(new URL('./data/', import.meta.url)))
const identity = accounts(accountsStore(process.env.TORFILMS_CATALOG_DIR || fileURLToPath(new URL('./data/', import.meta.url))), library)
const workers = new Map()
const recovered = new Set()
function getWorker (hash) {
  if (workers.has(hash)) return workers.get(hash)
  if (workers.size >= maximum) throw new Error(`Лимит ${maximum} раздач. Неиспользуемые слоты освобождаются через 15 минут.`)
  const entry = { hash, active: 0, touched: Date.now(), port: null }
  workers.set(hash, entry)
  const child = fork(fileURLToPath(new URL('./bridge-worker.js', import.meta.url)), [], { env: { ...process.env, TORFILMS_BRIDGE_HOST: '127.0.0.1', TORFILMS_BRIDGE_PORT: '0', TORFILMS_BRIDGE_RAM_MB: String(ram), ...(recovered.has(hash) ? { TORFILMS_BRIDGE_NATIVE_RTC: '0' } : {}) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  entry.child = child; child.stdout.resume()
  child.stderr.on('data', b => console.error(`[${hash.slice(0, 8)}] ${b.toString().slice(0, 1000)}`))
  entry.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Процесс раздачи не запустился за 30 секунд. Повторите подключение.')) }, 30000)
    child.once('message', msg => { clearTimeout(timer); entry.port = msg.port; entry.proxy = createLanProxy(msg.port, { websocket: true }); resolve(entry) })
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Worker stopped')) })
  })
  child.once('exit', () => { if (workers.get(hash) === entry) workers.delete(hash) })
  return entry
}
async function post (entry, pathname, data) {
  await entry.ready; entry.touched = Date.now()
  const response = await fetch(`http://127.0.0.1:${entry.port}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(15000) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Worker request failed')
  return result
}
const server = http.createServer(async (req, res) => {
  const json = (code, value) => { if (!res.destroyed) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) } }
  try {
    if (!backendAccess(req, res)) return
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/healthz') return json(200, { ok: true })
    if (await identity.handle(req, res, url)) return
    if (url.pathname.startsWith('/catalog/') && !['GET', 'HEAD'].includes(req.method)) await identity.requireUser(req, ['admin', 'moderator'])
    if (await library.handle(req, res, url)) return
    if (url.pathname === '/bridge/config') return json(200, { enabled: true, multiplex: true, memoryMb: ram, maxWorkers: maximum, totalCacheLimitMb: ram * maximum })
    if (url.pathname === '/bridge/state') {
      const states = await Promise.all([...workers.values()].map(async e => {
        try { if (!e.port) return { infoHash: e.hash, ready: false, starting: true, pid: e.child.pid }; return { ...await (await fetch(`http://127.0.0.1:${e.port}/bridge/state`, { signal: AbortSignal.timeout(1500) })).json(), pid: e.child.pid } } catch { return { infoHash: e.hash, ready: false, warning: 'Раздача не отвечает', pid: e.child.pid } }
      }))
      return json(200, { workers: states, maxWorkers: maximum, totalCacheLimitMb: ram * maximum })
    }
    if (req.method === 'POST' && ['/bridge/start', '/bridge/demand'].includes(url.pathname)) {
      let body = '', length = 0
      for await (const chunk of req) { length += chunk.length; if (length > 20000) return json(413, { error: 'Request too large' }); body += chunk }
      const data = JSON.parse(body)
      if (url.pathname === '/bridge/start') {
        const saved = data.movie ? await library.resolve(data.movie, data.quality) : null
        const source = saved?.magnet || data.magnet
        if (typeof source !== 'string' || !source.startsWith('magnet:?')) return json(400, { error: 'Magnet required' })
        const { infoHash } = await parseTorrent(source)
        const entry = getWorker(infoHash)
        entry.startData = saved ? { movie: data.movie, quality: data.quality } : { magnet: source }
        await post(entry, '/bridge/start', entry.startData)
        return json(200, { ok: true, infoHash, tracker: `/tracker/${infoHash}` })
      }
      const entry = workers.get(data.infoHash)
      if (!entry) return json(409, { error: 'Раздача остановлена. Подключитесь повторно.' })
      return json(200, await post(entry, '/bridge/demand', data))
    }
    const media = /^\/bridge\/(?:raw|tracks|audio-plan|audio|metadata|piece|subtitles)\/([a-f0-9]{40})(?:\/|$)/.exec(url.pathname)
    if (media) {
      const entry = workers.get(media[1])
      if (!entry) return json(404, { error: 'Раздача не активна' })
      await entry.ready; entry.touched = Date.now(); entry.active++
      res.once('close', () => { entry.active--; entry.touched = Date.now() })
      return entry.proxy.emit('request', req, res)
    }
    if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: 'Method not allowed' })
    const relative = url.pathname === '/' || /^\/(?:film\/)?tt\d{7,10}\/?$/.test(url.pathname) ? '/index.html' : decodeURIComponent(url.pathname)
    const target = path.resolve(root, '.' + relative)
    if (!target.startsWith(root)) return json(403, { error: 'Forbidden' })
    const bytes = await readFile(target)
    res.writeHead(200, { 'Content-Type': mime.contentType(path.extname(target)) || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : bytes)
  } catch (e) { json(e.code === 'ENOENT' ? 404 : e.status || 400, { error: e.code === 'ENOENT' ? 'Not found' : e.message }) }
})
server.on('upgrade', (req, socket, head) => {
  if (!allowedOrigin(req)) return socket.destroy()
  const match = /^\/tracker\/([a-f0-9]{40})$/.exec(req.url)
  const entry = match && workers.get(match[1])
  if (!entry?.proxy) return socket.destroy()
  entry.touched = Date.now(); req.url = '/tracker'; entry.proxy.emit('upgrade', req, socket, head)
})
const idle = setInterval(() => {
  for (const entry of workers.values()) if (!entry.active && Date.now() - entry.touched > 15 * 60000) entry.child.kill()
}, 30000)
// The supervisor can see a healthy router while a native torrent worker hangs.
// Check workers independently; recover without disturbing the other streams.
const health = setInterval(() => {
  for (const entry of workers.values()) {
    if (!entry.port || entry.checking || entry.restarting) continue
    entry.checking = true
    fetch(`http://127.0.0.1:${entry.port}/bridge/state`, { signal: AbortSignal.timeout(2000) }).then(async response => {
      await response.json()
      if (!response.ok) throw new Error('Worker health failed')
      entry.failures = 0
    }).catch(() => {
      entry.failures = (entry.failures || 0) + 1
      if (entry.failures < 3 || closing || !entry.startData) return
      entry.restarting = true; recovered.add(entry.hash)
      console.error(`Worker ${entry.hash}: unresponsive; restarting with HTTPS piece transport and browser-to-browser RTC`)
      entry.child.once('exit', () => {
        if (closing) return
        const next = getWorker(entry.hash); next.startData = entry.startData
        post(next, '/bridge/start', next.startData).catch(error => console.error(`Worker recovery: ${error.message}`))
      })
      entry.child.kill()
    }).finally(() => { entry.checking = false })
  }
}, 5000)
let closing = false
function shutdown () { if (closing) return; closing = true; clearInterval(idle); clearInterval(health); for (const entry of workers.values()) entry.child.kill(); server.close(() => process.exit()); setTimeout(() => process.exit(), 2000).unref() }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
process.on('message', message => { if (message?.type === 'shutdown') shutdown() })
process.on('disconnect', shutdown)
server.listen(port, host, () => { console.log(`Torfilms Hybrid: http://${host}:${server.address().port}/ · ${maximum} workers × ${ram} MB`); process.send?.({ port: server.address().port }) })
