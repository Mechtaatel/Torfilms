import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebTorrent from 'webtorrent'
import { Server as Tracker } from 'bittorrent-tracker'
import mime from 'mime-types'
import parseTorrent from 'parse-torrent'
import { readRange } from './lib/range-reader.js'
import { RamStore } from './public/p2p/ram-store.js'
import { bridgeMedia } from './lib/bridge-media.js'
import { catalog } from './lib/catalog.js'
import { mediaMetadata } from './lib/media-metadata.js'

const host = process.env.TORFILMS_BRIDGE_HOST || '127.0.0.1'
const port = Number(process.env.TORFILMS_BRIDGE_PORT || 18183)
const limit = Number(process.env.TORFILMS_BRIDGE_RAM_MB || 256) * 1024 ** 2
if (!Number.isFinite(limit) || limit < 32 * 1024 ** 2 || limit > 2048 * 1024 ** 2) throw new Error('Bridge RAM must be 32–2048 MB')
const root = fileURLToPath(new URL('./public/p2p/', import.meta.url))
const library = catalog(process.env.TORFILMS_CATALOG_DIR || fileURLToPath(new URL('./data/', import.meta.url)))
let switching = false
let trackerUrl
// Windows native RTC repeatedly froze this worker. Keep browser-to-browser RTC,
// but use verified HTTPS pieces for the server hop unless explicitly opted in.
const nativeRtc = (process.env.TORFILMS_BRIDGE_NATIVE_RTC ?? (process.platform === 'win32' ? '0' : '1')) !== '0'
const client = new WebTorrent({ tracker: nativeRtc ? {} : { wrtc: () => false }, dht: process.env.TORFILMS_BRIDGE_DHT !== '0', lsd: false, natTraversal: false, enableWebSeeds: false, maxConns: 30, uploadLimit: 4 * 1024 ** 2 })
let torrent, store, activeHash, warning = ''
let pieceReaders = 0
const demands = new Map()
const tracker = new Tracker({ http: false, udp: false, ws: { noServer: true }, stats: false,
  filter: (hash, params, cb) => cb(torrent?.infoHash === hash ? null : new Error('Unknown torrent')) })
tracker.on('warning', e => { warning = e.message })
tracker.on('error', e => { warning = e.message })
client.on('error', e => { warning = e.message })
function select () {
  if (!torrent?.ready) return
  const now = Date.now()
  torrent.deselect(0, torrent.pieces.length - 1)
  for (const [key, demand] of demands) {
    if (now - demand.at > 15000) { demands.delete(key); continue }
    torrent.select(demand.first, demand.last, 10)
  }
}
const timer = setInterval(select, 3000)
const metadataStore = mediaMetadata(path.join(process.env.TORFILMS_CATALOG_DIR || fileURLToPath(new URL('./data/', import.meta.url)), 'media-metadata'))
const media = bridgeMedia(() => torrent, () => `http://${host}:${server.address().port}`, metadataStore)
const server = http.createServer(async (req, res) => {
  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
  try {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(403, { error: 'Cross-origin blocked' })
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (await library.handle(req, res, url)) return
    if (await media.handle(req, res, url)) return
    if (url.pathname === '/bridge/config') return json(200, { enabled: true, tracker: '/tracker', memoryMb: limit / 1024 ** 2 })
    if (url.pathname === `/bridge/metadata/${torrent?.infoHash}`) return json(200, { ready: !!torrent?.ready, ...(torrent?.ready ? { torrentBase64: Buffer.from(torrent.torrentFile).toString('base64') } : {}) })
    const pieceRoute = /^\/bridge\/piece\/([a-f0-9]{40})\/(\d+)$/.exec(url.pathname)
    if (pieceRoute) {
      if (req.method !== 'GET') return json(405, { error: 'GET required' })
      const index = Number(pieceRoute[2])
      if (!torrent?.ready || torrent.infoHash !== pieceRoute[1] || index >= torrent.pieces.length) return json(404, { error: 'Кусок не готов' })
      if (pieceReaders >= 8) return json(429, { error: 'Мост занят, повторите запрос' })
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 18000)
      res.once('close', () => abort.abort()); pieceReaders++
      try {
        const start = index * torrent.pieceLength, length = Math.min(torrent.pieceLength, torrent.length - start)
        for await (const data of readRange({ offset: 0 }, torrent, start, start + length - 1, abort.signal)) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': length, 'Cache-Control': 'no-store' }); res.end(data)
        }
      } catch { if (!res.destroyed && !res.headersSent) json(504, { error: 'Кусок ещё загружается' }) }
      finally { clearTimeout(timer); pieceReaders-- }
      return
    }
    if (url.pathname === '/bridge/state') return json(200, { infoHash: torrent?.infoHash, ready: !!torrent?.ready, ramBytes: store?.used || 0, limit, downloaded: torrent?.downloaded || 0, uploaded: torrent?.uploaded || 0, peers: torrent?.numPeers || 0, transports: (torrent?.wires || []).map(w => w.type), demands: demands.size, warning })
    if (req.method === 'POST' && url.pathname.startsWith('/bridge/')) {
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 16384) return json(413, { error: 'Too large' }) }
      const data = JSON.parse(body || '{}')
      if (url.pathname === '/bridge/start') {
        const saved = data.movie ? await library.resolve(data.movie, data.quality) : null
        if (saved) data.magnet = saved.magnet
        if (typeof data.magnet !== 'string' || !/^magnet:\?/i.test(data.magnet)) return json(400, { error: 'Magnet required' })
        const { infoHash: hash } = await parseTorrent(data.magnet)
        if (!hash) return json(400, { error: '40-character infohash required' })
        if (switching) return json(409, { error: 'Мост переключает качество. Повторите через несколько секунд.' })
        if (torrent && activeHash !== hash) {
          if (!saved || !data.replace || data.expectedHash !== torrent.infoHash) return json(409, { error: 'Мост обслуживает другую раздачу. Подтвердите переключение качества.' })
          switching = true
          try { media.close(); demands.clear(); await new Promise((resolve, reject) => torrent.destroy(e => e ? reject(e) : resolve())); torrent = null; store = null } finally { switching = false }
        }
        if (!torrent) {
          activeHash = hash
          torrent = client.add(saved?.torrentBase64 ? Buffer.from(saved.torrentBase64, 'base64') : data.magnet, { announce: [trackerUrl], deselect: true, store: RamStore, storeCacheSlots: 0, storeOpts: { limit, onStore: s => { store = s } } })
          torrent.on('warning', e => { warning = e.message })
          torrent.on('error', e => { warning = e.message })
          torrent.on('ready', select)
          torrent.on('ready', () => metadataStore.files(torrent.infoHash, torrent.files).catch(e => { warning = `Metadata: ${e.message}` }))
        }
        return json(200, { ok: true })
      }
      if (url.pathname === '/bridge/demand') {
        if (!torrent?.ready || data.infoHash !== torrent.infoHash) return json(409, { error: 'Мост получает метаданные' })
        const { first, last, viewer } = data
        if (typeof viewer !== 'string' || viewer.length > 80 || !Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last >= torrent.pieces.length || last - first >= 16) return json(400, { error: 'Invalid demand' })
        if (!demands.has(viewer) && demands.size >= 8) return json(429, { error: 'Не больше 8 активных читателей' })
        demands.set(viewer, { first, last, at: Date.now() }); select()
        return json(200, { ok: true })
      }
      return json(404, { error: 'Not found' })
    }
    if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: 'Method not allowed' })
    const target = path.resolve(root, '.' + (url.pathname === '/' || /^\/film\/tt\d{7,10}\/?$/.test(url.pathname) ? '/index.html' : decodeURIComponent(url.pathname)))
    if (!target.startsWith(root)) return json(403, { error: 'Forbidden' })
    const bytes = await readFile(target)
    res.writeHead(200, { 'Content-Type': mime.contentType(path.extname(target)) || 'application/octet-stream', 'Cache-Control': 'no-cache' })
    res.end(req.method === 'HEAD' ? undefined : bytes)
  } catch (e) { json(400, { error: e.message }) }
})
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/tracker' || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return socket.destroy()
  tracker.ws.handleUpgrade(req, socket, head, ws => tracker.ws.emit('connection', ws, req))
})
server.listen(port, host, () => {
  trackerUrl = `ws://${host}:${server.address().port}/tracker`
  console.log(`Torfilms Hybrid: http://${host}:${server.address().port}/ · RAM ${limit / 1024 ** 2} MB`)
  process.send?.({ port: server.address().port })
})
process.on('disconnect', shutdown)
let closing = false
function shutdown () { if (closing) return; closing = true; media.close(); clearInterval(timer); server.close(); tracker.close(); client.destroy(() => process.exit()); setTimeout(() => process.exit(), 2000).unref() }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
