import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import WebTorrent from 'webtorrent'
import MemoryChunkStore from 'memory-chunk-store'
import mime from 'mime-types'
import { readRange } from './lib/range-reader.js'
import { playbackArgs } from './lib/playback-args.js'
import { seekPlan } from './lib/seek-plan.js'
import { cacheVictim } from './lib/cache-victim.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
const PORT = Number(process.env.TORFILMS_PORT || 18181)
const DEFAULT_MEMORY_MB = Number(process.env.TORFILMS_MEMORY_MB || 1024)
const MIN_MEMORY_MB = 128
const MAX_MEMORY_MB = 16384
const MAX_TORRENT_BYTES = 32 * 1024 * 1024
const MB = 1024 * 1024

/**
 * A chunk store compatible with WebTorrent's abstract-chunk-store API.
 * Unlike the default Node store, it never opens a file. Completed pieces are
 * kept in an LRU map and are made unverified again when evicted, so the
 * torrent engine can request them again after a seek.
 */
class BoundedMemoryStore extends MemoryChunkStore {
  constructor (chunkLength, opts = {}) {
    super(chunkLength, opts)
    this.torrent = opts.torrent
    this.maxBytes = Math.max(Number(opts.maxBytes) || DEFAULT_MEMORY_MB * MB, chunkLength)
    this.entries = new Map()
    this.usedBytes = 0
    this.hits = 0
    this.misses = 0
    this.closed = false
    this.lastEviction = null
  }

  setMaxBytes (maxBytes) {
    this.maxBytes = Math.max(Number(maxBytes) || this.chunkLength, this.chunkLength)
    this.#evict()
  }

  put (index, buf, cb = () => {}) {
    if (this.closed) return queueMicrotask(() => cb(new Error('Storage is closed')))
    const value = Buffer.from(buf)
    const previous = this.entries.get(index)
    if (previous) this.usedBytes -= previous.length
    this.entries.set(index, value)
    this.usedBytes += value.length
    this.#touch(index)
    this.#evict(index)
    queueMicrotask(() => cb(null))
  }

  get (index, opts, cb = () => {}) {
    if (typeof opts === 'function') return this.get(index, null, opts)
    if (this.closed) return queueMicrotask(() => cb(new Error('Storage is closed')))
    const entry = this.entries.get(index)
    if (!entry) {
      this.misses += 1
      const error = new Error('Chunk is not in RAM cache')
      error.notFound = true
      return queueMicrotask(() => cb(error))
    }
    this.hits += 1
    this.#touch(index)
    let result = entry
    if (opts) {
      const offset = Number(opts.offset) || 0
      const length = Number(opts.length) || entry.length - offset
      result = entry.slice(offset, offset + length)
    }
    queueMicrotask(() => cb(null, result))
  }

  close (cb = () => {}) {
    this.closed = true
    this.entries.clear()
    this.usedBytes = 0
    queueMicrotask(() => cb(null))
  }

  destroy (cb = () => {}) {
    this.close(cb)
  }

  stats () {
    return {
      usedBytes: this.usedBytes,
      maxBytes: this.maxBytes,
      pieces: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      lastEviction: this.lastEviction
    }
  }

  cachedRangesInRange (start, length) {
    const rangeStart = Math.max(0, Number(start) || 0)
    const rangeEnd = rangeStart + Math.max(0, Number(length) || 0)
    if (rangeEnd <= rangeStart) return []
    const ranges = []
    for (const [index, entry] of this.entries) {
      const pieceStart = index * this.chunkLength
      const pieceEnd = pieceStart + entry.length
      const overlapStart = Math.max(rangeStart, pieceStart)
      const overlapEnd = Math.min(rangeEnd, pieceEnd)
      if (overlapEnd > overlapStart) ranges.push([overlapStart - rangeStart, overlapEnd - rangeStart])
    }
    ranges.sort((a, b) => a[0] - b[0])
    const merged = []
    for (const range of ranges) {
      const previous = merged[merged.length - 1]
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
      else merged.push(range)
    }
    return merged
  }

  cachedBytesInRange (start, length) {
    return this.cachedRangesInRange(start, length).reduce((total, range) => total + range[1] - range[0], 0)
  }

  #touch (index) {
    const entry = this.entries.get(index)
    if (!entry) return
    this.entries.delete(index)
    this.entries.set(index, entry)
  }

  #evict (keepIndex = -1) {
    while (this.usedBytes > this.maxBytes && this.entries.size > 1) {
      const oldest = cacheVictim(this.entries, keepIndex, this.playbackWindow)
      if (oldest === undefined) break
      if (oldest === keepIndex) {
        this.#touch(oldest)
        continue
      }
      const old = this.entries.get(oldest)
      this.entries.delete(oldest)
      this.usedBytes -= old.length
      this.lastEviction = oldest

      // WebTorrent normally assumes a verified piece is available forever.
      // Tell it that an evicted piece must be fetched again.
      if (this.torrent && !this.torrent.destroyed && this.torrent.pieces?.[oldest] === null) {
        this.torrent._markUnverified(oldest)
        // _markUnverified selects the piece in normal WebTorrent mode. The
        // player will select it again when its byte range becomes active;
        // keep evictions from creating background/random downloads.
        this.torrent.deselect(oldest, oldest)
      }
    }
  }
}

function memoryStoreFor (torrent) {
  let store = torrent?.store
  while (store?.store) store = store.store
  return store instanceof BoundedMemoryStore ? store : null
}

const client = new WebTorrent({
  dht: true,
  lsd: true,
  tracker: true,
  natTraversal: false,
  enableWebSeeds: false
})
const sessions = new Map()
let sessionNumber = 0
let memoryMb = Number.isFinite(DEFAULT_MEMORY_MB)
  ? clamp(DEFAULT_MEMORY_MB, MIN_MEMORY_MB, MAX_MEMORY_MB)
  : 1024

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function createState (id, sourceType) {
  return {
    id,
    sourceType,
    createdAt: Date.now(),
    phase: 'metadata',
    name: 'Получение метаданных…',
    warning: null,
    error: null,
    torrent: null,
    store: null,
    activeFile: 0,
    activePosition: 0,
    playbackDemand: null,
    selectedWindow: null,
    activeTranscode: null,
    audioTracks: new Map(),
    mediaInfo: new Map(),
    audioProbePending: new Map(),
    lastActivity: Date.now()
  }
}

function attachTorrent (state, torrent) {
  state.torrent = torrent
  state.store = memoryStoreFor(torrent)

  torrent.on('metadata', () => {
    state.name = torrent.name || state.name
    state.phase = 'connecting'
    state.lastActivity = Date.now()
  })
  torrent.on('ready', () => {
    state.store = memoryStoreFor(torrent)
    state.phase = 'ready'
    state.name = torrent.name || state.name
    // Keep the initial state deterministic: no rare/random pieces are
    // selected until the player requests a concrete byte range.
    deselectAll(torrent)
  })
  torrent.on('download', () => {
    state.lastActivity = Date.now()
    if (state.phase !== 'ready' && state.phase !== 'playing') state.phase = 'ready'
  })
  torrent.on('done', () => { state.phase = 'complete' })
  torrent.on('warning', error => { state.warning = error.message || String(error) })
  torrent.on('error', error => {
    state.phase = 'error'
    state.error = error.message || String(error)
  })
  torrent.on('destroyed', () => { state.phase = 'stopped' })
}

function deselectAll (torrent) {
  if (torrent.ready && torrent.pieces?.length) torrent.deselect(0, torrent.pieces.length - 1)
}

function videoFiles (torrent, store = null) {
  if (!torrent?.files) return []
  return torrent.files
    .map((file, index) => ({
      index,
      name: file.name,
      path: file.path,
      size: file.length,
      type: file.type || mime.getType(file.name) || guessVideoMime(file.name),
      isVideo: /^video\//.test(file.type || '') || /\.(mkv|mp4|webm|avi|mov|m4v|ogv|ts|m2ts|flv)$/i.test(file.name),
      browserTranscode: /\.(mkv|avi|ts|m2ts|flv)$/i.test(file.name),
      cachedBytes: store?.cachedBytesInRange(file.offset, file.length) || 0,
      cachedRanges: store?.cachedRangesInRange(file.offset, file.length) || []
    }))
    .sort((a, b) => Number(b.isVideo) - Number(a.isVideo) || b.size - a.size)
}

function guessVideoMime (name) {
  const extension = path.extname(name).toLowerCase()
  return ({
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.ts': 'video/mp2t',
    '.m2ts': 'video/mp2t',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.flv': 'video/x-flv'
  })[extension] || 'application/octet-stream'
}

function streamUrlFor (state, file, focusBytePosition = 0, consumer = '') {
  const base = `http://127.0.0.1:${PORT}/stream/${state.id}/${state.torrent.files.indexOf(file)}`
  const focus = Math.max(0, Math.floor(Number(focusBytePosition) || 0))
  const params = new URLSearchParams()
  if (focus > 0) params.set('focus', String(focus))
  if (consumer) params.set('consumer', consumer)
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

function probeAudioTracks (state, file) {
  const fileIndex = state.torrent.files.indexOf(file)
  if (state.mediaInfo.has(fileIndex)) return Promise.resolve(state.mediaInfo.get(fileIndex))
  if (state.audioProbePending.has(fileIndex)) return state.audioProbePending.get(fileIndex)

  const ffprobe = resolveExecutable('ffprobe')
  if (!ffprobe) return Promise.resolve({ tracks: [], duration: null, video: null })
  const promise = new Promise(resolve => {
    const args = [
      '-v', 'error',
      '-analyzeduration', '3000000', '-probesize', '3000000',
        '-show_entries', 'format=duration,bit_rate:stream=index,codec_type,codec_name,channels,start_time,duration:stream_tags=language,title',
      '-of', 'json', streamUrlFor(state, file, 0, 'probe')
    ]
    const child = spawn(ffprobe, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let output = ''
    let settled = false
    const finish = media => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const normalized = {
        tracks: media.tracks || [],
        duration: media.duration ?? null,
        bitrate: media.bitrate ?? null,
        video: media.video || null
      }
      state.audioProbePending.delete(fileIndex)
      // Do not permanently cache a failed probe. A torrent may not have the
      // header/index pieces in RAM yet; the next request should retry it.
      if (normalized.tracks.length || normalized.video || Number.isFinite(normalized.duration)) {
        state.audioTracks.set(fileIndex, normalized.tracks)
        state.mediaInfo.set(fileIndex, normalized)
      }
      resolve(normalized)
      if (!child.killed) child.kill()
    }
    const timeout = setTimeout(() => finish({ tracks: [], duration: null, video: null }), 15000)
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-20000) })
    child.once('error', () => finish({ tracks: [], duration: null, video: null }))
    child.once('close', code => {
      if (code !== 0) return finish({ tracks: [], duration: null, video: null })
      try {
        const parsed = JSON.parse(output)
        const videoStream = (parsed.streams || []).find(stream => stream.codec_type === 'video')
        const tracks = (parsed.streams || [])
          .filter(stream => stream.codec_type === 'audio')
          .map((stream, index) => ({
          index,
          streamIndex: stream.index,
          codec: stream.codec_name || 'unknown',
          channels: stream.channels || null,
          startTime: Number.isFinite(Number(stream.start_time)) ? Number(stream.start_time) : null,
          duration: Number.isFinite(Number(stream.duration)) ? Number(stream.duration) : null,
          language: stream.tags?.language || null,
          title: stream.tags?.title || null
          }))
        const duration = Number(parsed.format?.duration)
        const bitrate = Number(parsed.format?.bit_rate)
        const video = videoStream
          ? {
              streamIndex: videoStream.index,
              codec: videoStream.codec_name || 'unknown',
              startTime: Number.isFinite(Number(videoStream.start_time)) ? Number(videoStream.start_time) : null,
              duration: Number.isFinite(Number(videoStream.duration)) ? Number(videoStream.duration) : null
            }
          : null
        finish({ tracks, duration: Number.isFinite(duration) ? duration : null, bitrate: Number.isFinite(bitrate) ? bitrate : null, video })
      } catch {
        finish({ tracks: [], duration: null, video: null })
      }
    })
  })
  state.audioProbePending.set(fileIndex, promise)
  return promise
}

function selectPlaybackWindow (state, file, position = 0, { updateDemand = true } = {}) {
  const torrent = state.torrent
  if (!torrent?.ready || !torrent.pieces?.length || !file?.length) return

  const pieceLength = torrent.pieceLength
  const fileStartPiece = Math.floor(file.offset / pieceLength)
  const fileEndPiece = Math.floor((file.offset + file.length - 1) / pieceLength)
  const currentPiece = clamp(Math.floor((file.offset + position) / pieceLength), fileStartPiece, fileEndPiece)
  // Leave headroom for headers, probes and already in-flight requests.
  // Do not refill consumed data behind the reader on every window move.
  const windowPieces = Math.max(2, Math.floor((memoryMb * MB * 0.8) / pieceLength))
  const ahead = windowPieces - 1
  const start = currentPiece
  const end = clamp(currentPiece + ahead, fileStartPiece, fileEndPiece)
  const frontEnd = clamp(currentPiece + Math.max(1, Math.min(16, Math.floor(windowPieces * 0.15))), currentPiece, end)

  const fileIndex = torrent.files.indexOf(file)
  const previous = state.selectedWindow
  const farFromPrevious = !previous || previous.fileIndex !== fileIndex || Math.abs(currentPiece - previous.centerPiece) > Math.max(8, Math.floor(windowPieces * 0.5))
  if (farFromPrevious) deselectAll(torrent)
  else torrent.deselect(previous.start, previous.end)
  const store = memoryStoreFor(torrent)
  if (store) store.playbackWindow = { current: currentPiece, end }
  torrent.select(currentPiece, frontEnd, 20)
  if (frontEnd < end) torrent.select(frontEnd + 1, end, 5)
  torrent.critical(currentPiece, Math.min(currentPiece + 1, end + 1))
  state.selectedWindow = { fileIndex, start, end, centerPiece: currentPiece }
  if (updateDemand) {
    state.activeFile = fileIndex
    state.activePosition = position
    state.playbackDemand = { fileIndex, position, updatedAt: Date.now() }
  }
  state.windowPosition = position
  state.phase = 'playing'
}

function selectSupportingPieces (state, file, start, end) {
  const torrent = state.torrent
  if (!torrent?.ready || !torrent.pieces?.length || !file?.length) return
  const pieceLength = torrent.pieceLength
  const fileStartPiece = Math.floor(file.offset / pieceLength)
  const fileEndPiece = Math.floor((file.offset + file.length - 1) / pieceLength)
  const first = clamp(Math.floor((file.offset + Math.max(0, start)) / pieceLength), fileStartPiece, fileEndPiece)
  // Header/cues and an auxiliary range must not replace the active playback
  // window. Keep only a small front of the request selected; the main window
  // remains owned by the player demand and is advanced by its own stream.
  const last = clamp(Math.min(Math.floor((file.offset + Math.max(0, end)) / pieceLength), first + 15), first, fileEndPiece)
  torrent.select(first, last, 1)
}

function publicState (state) {
  const torrent = state.torrent
  const store = state.store
  const files = videoFiles(torrent, store)
  const metadata = Boolean(torrent?.metadata)
  const ready = Boolean(torrent?.ready && metadata)
  const phase = state.error
    ? 'error'
    : !metadata
      ? 'metadata'
      : !ready
        ? 'connecting'
        : state.phase
  const progress = torrent?.length ? (torrent.downloaded / torrent.length) : 0
  return {
    id: state.id,
    name: state.name,
    phase,
    sourceType: state.sourceType,
    ready,
    metadata,
    infoHash: torrent?.infoHash || null,
    progress: Number.isFinite(progress) ? progress : 0,
    downloaded: torrent?.downloaded || 0,
    length: torrent?.length || 0,
    downloadSpeed: torrent?.downloadSpeed || 0,
    uploadSpeed: torrent?.uploadSpeed || 0,
    peers: torrent?.numPeers || 0,
    files,
    activeFile: state.activeFile,
    activePosition: state.activePosition,
      memory: store?.stats() || { usedBytes: 0, maxBytes: memoryMb * MB, pieces: 0, hits: 0, misses: 0 },
    audioTracks: Object.fromEntries([...state.audioTracks.entries()].map(([index, tracks]) => [index, tracks])),
    warning: state.warning,
    error: state.error,
    ageSeconds: Math.floor((Date.now() - state.createdAt) / 1000)
  }
}

function allStates () {
  return [...sessions.values()].map(publicState).sort((a, b) => a.id.localeCompare(b.id))
}

function json (res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(body)
}

async function readBody (req, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error(`Request is larger than ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function ensureSource (source) {
  if (typeof source !== 'string' || source.length < 8 || source.length > 2 * 1024 * 1024) {
    throw new Error('Ожидается magnet-ссылка или URL .torrent')
  }
  if (!/^magnet:\?/i.test(source) && !/^https?:\/\//i.test(source)) {
    throw new Error('Разрешены только magnet-ссылки и http(s)-URL')
  }
  return source.trim()
}

function addTorrent (source, sourceType = 'magnet') {
  const id = `t${++sessionNumber}-${randomUUID().slice(0, 6)}`
  const state = createState(id, sourceType)
  sessions.set(id, state)
  try {
    const torrent = client.add(source, {
      store: BoundedMemoryStore,
      storeOpts: { maxBytes: memoryMb * MB },
      destroyStoreOnDestroy: true
    })
    attachTorrent(state, torrent)
    return state
  } catch (error) {
    state.phase = 'error'
    state.error = error.message || String(error)
    return state
  }
}

function parseRange (header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match) return null
  let start = match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match[1])
  let end = match[2] === '' ? size - 1 : Number(match[2])
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || start > end) return null
  end = Math.min(end, size - 1)
  return { start, end, partial: true }
}

async function streamFile (req, res, state, file) {
  const range = parseRange(req.headers.range, file.length)
  if (!range) {
    res.writeHead(416, { 'Content-Range': `bytes */${file.length}` })
    return res.end()
  }
  const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const focus = Number(requestUrl.searchParams.get('focus'))
  const consumer = requestUrl.searchParams.get('consumer') || 'direct'
  const fileIndex = state.torrent.files.indexOf(file)
  const pieceLength = state.torrent.pieceLength || 1024 * 1024
  const requestedPosition = range.partial
    ? range.start
    : (Number.isFinite(focus) ? clamp(focus, 0, Math.max(0, file.length - 1)) : 0)
  const demand = state.playbackDemand?.fileIndex === fileIndex ? state.playbackDemand : null
  const protectedConsumer = consumer === 'transcode' || consumer === 'probe'

  if (!protectedConsumer || !demand) {
    selectPlaybackWindow(state, file, requestedPosition)
  } else if (range.partial) {
    // FFmpeg makes auxiliary Range requests for the Matroska header/cues.
    // They need a few pieces available, but must not move the active window.
    selectSupportingPieces(state, file, range.start, range.end)
  } else {
    // A non-Range FFmpeg open still needs the Matroska header before it can
    // issue its seek to the requested playback position.
    selectSupportingPieces(state, file, 0, pieceLength * 16)
  }

  const length = range.end - range.start + 1
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': file.type || 'application/octet-stream',
    'Content-Length': length,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'X-Torfilms-Cache': 'ram-only'
  }
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.length}`
  res.writeHead(range.partial ? 206 : 200, headers)
  if (req.method === 'HEAD') return res.end()

  const abort = new AbortController()
  const stream = readRange(file, state.torrent, range.start, range.end, abort.signal)
  let closed = false
  let bytesRead = 0
  let lastWindowPosition = range.start
  const followStep = Math.max((state.torrent?.pieceLength || 1024 * 1024) * 2, 1024 * 1024)
  // Once the demuxer actually reads bytes, its exact byte position is more
  // reliable than seconds * average bitrate, especially for VBR after seek.
  const followPlaybackWindow = consumer !== 'probe'
  const close = () => {
    closed = true
    abort.abort()
  }
  req.on('aborted', close)
  res.on('close', close)

  try {
    for await (const chunk of stream) {
      if (closed) break
      bytesRead += chunk.length
      const readPosition = range.start + bytesRead
      if (followPlaybackWindow && readPosition - lastWindowPosition >= followStep) {
        selectPlaybackWindow(state, file, readPosition, { updateDemand: false })
        lastWindowPosition = readPosition
      }
      if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal })
    }
    if (!closed) res.end()
  } catch (error) {
    if (!closed) {
      console.error('[stream]', error.message)
      if (!res.headersSent) res.writeHead(500)
      res.destroy(error)
    }
  } finally {
    req.removeListener('aborted', close)
    res.removeListener('close', close)
  }
}

function resolveExecutable (preferred) {
  const candidates = preferred === 'vlc'
    ? ['vlc.exe', 'vlc']
    : preferred === 'ffmpeg'
      ? ['ffmpeg.exe', 'ffmpeg']
      : preferred === 'ffprobe'
        ? ['ffprobe.exe', 'ffprobe']
      : ['ffplay.exe', 'ffplay']
  for (const candidate of candidates) {
    try {
      const result = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [candidate], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).split(/\r?\n/).find(Boolean)
      if (result) return result.trim()
    } catch {}
  }
  const explicit = preferred === 'vlc'
    ? process.env.TORFILMS_VLC
    : preferred === 'ffmpeg'
      ? process.env.TORFILMS_FFMPEG
      : preferred === 'ffprobe'
        ? process.env.TORFILMS_FFPROBE
      : process.env.TORFILMS_FFPLAY
  return explicit && existsSync(explicit) ? explicit : null
}

function transcodeFile (req, res, state, file, startSeconds = 0) {
  const ffmpeg = resolveExecutable('ffmpeg')
  if (!ffmpeg) {
    return json(res, 503, { error: 'Для совместимого аудио нужен ffmpeg.exe в PATH' })
  }
  const seek = Math.max(0, Number(startSeconds) || 0)
  const requestedAudio = Number(new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`).searchParams.get('audio'))
  const fileIndex = state.torrent.files.indexOf(file)
  const media = state.mediaInfo.get(fileIndex)
  const audioIndex = Number.isInteger(requestedAudio) && requestedAudio >= 0
    ? requestedAudio
    : 0
  const selectedTrack = media?.tracks?.find(track => track.index === audioIndex)
  const audioMap = Number.isInteger(selectedTrack?.streamIndex)
    ? `0:${selectedTrack.streamIndex}?`
    : `0:a:${audioIndex}?`
  const approximateBytePosition = media?.duration && seek > 0
    ? (file.length * seek / media.duration)
    : 0
  selectPlaybackWindow(state, file, approximateBytePosition)
  // AVI/XVID and several legacy codecs are not playable in a browser even
  // after their audio has been converted. Keep modern video untouched;
  // transcode incompatible video only when necessary.
  const browserVideoCodecs = new Set(['h264', 'hevc', 'vp9', 'av1'])
  const sourceVideoCodec = String(media?.video?.codec || '').toLowerCase()
  const transcodeVideo = /\.(avi|flv)$/i.test(file.name) || !browserVideoCodecs.has(sourceVideoCodec)
  // Do not cut the Matroska header off by starting the input URL at the
  // approximate media byte. FFmpeg needs the container header and cues to
  // seek correctly. The stream endpoint advertises Content-Length and
  // Accept-Ranges, so FFmpeg can request the header/index and then jump to
  // the target byte range itself; every such range still goes through the
  // RAM-only playback window selector.
  const inputUrl = streamUrlFor(state, file, 0, 'transcode')

  // MKV files frequently contain AC-3/DTS audio. Browsers often decode the
  // H.264 video but mute the unsupported audio codec. Keep video untouched
  // and convert only audio to stereo AAC; all bytes still travel through
  // pipes and remain RAM-only.
  const args = playbackArgs({ inputUrl, seek, audioMap, transcodeVideo })
  // A seek or audio-track change creates a new HTTP response. The previous
  // FFmpeg process may not receive a timely socket close from an embedded
  // browser, so explicitly stop it before starting the replacement. Without
  // this, old and new decoders compete for the same torrent pieces and RAM.
  if (state.activeTranscode && !state.activeTranscode.killed) {
    state.activeTranscode.kill()
  }
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  state.activeTranscode = child
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  let ended = false
  const stop = () => {
    if (ended) return
    ended = true
    if (state.activeTranscode === child) state.activeTranscode = null
    if (!child.killed) child.kill()
  }
  req.on('aborted', stop)
  res.on('close', stop)
  child.once('error', error => {
    if (ended) return
    ended = true
    if (state.activeTranscode === child) state.activeTranscode = null
    if (!res.headersSent) json(res, 503, { error: error.message })
    else res.destroy(error)
  })
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Torfilms-Cache': 'ram-only',
    'X-Torfilms-Audio': `aac-stereo; track=${audioIndex}`
  })
  child.stdout.pipe(res)
  child.once('close', code => {
    if (state.activeTranscode === child) state.activeTranscode = null
    if (!ended) {
      ended = true
      if (code !== 0 && stderr) console.error('[transcode]', stderr)
      if (!res.writableEnded) res.end()
    }
  })
}

function launchPlayer (state, fileIndex, preferred = 'vlc') {
  const file = state.torrent?.files?.[fileIndex]
  if (!file) throw new Error('Файл не найден')
  const streamUrl = `http://127.0.0.1:${PORT}/stream/${state.id}/${fileIndex}`
  const requested = preferred === 'ffplay' ? 'ffplay' : 'vlc'
  const executable = resolveExecutable(requested) || resolveExecutable(requested === 'vlc' ? 'ffplay' : 'vlc')
  if (!executable) throw new Error('Не найден VLC или ffplay в PATH. Установите VLC и повторите.')

  const isVlc = /vlc/i.test(path.basename(executable))
  const args = isVlc
    ? ['--no-video-title-show', '--play-and-exit', streamUrl]
    : ['-hide_banner', '-loglevel', 'warning', '-window_title', 'Torfilms', streamUrl]
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return { player: isVlc ? 'VLC' : 'ffplay', executable }
}

async function removeTorrent (state) {
  sessions.delete(state.id)
  if (state.activeTranscode && !state.activeTranscode.killed) state.activeTranscode.kill()
  state.activeTranscode = null
  if (!state.torrent) return
  await new Promise(resolve => {
    try { state.torrent.destroy(() => resolve()) } catch { resolve() }
  })
}

async function serveStatic (req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = path.resolve(PUBLIC_DIR, relative)
  if (!target.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'Forbidden' })
  try {
    const data = await readFile(target)
    res.writeHead(200, {
      'Content-Type': mime.contentType(path.extname(target)) || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    })
    res.end(data)
  } catch {
    json(res, 404, { error: 'Not found' })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const pathname = url.pathname

  try {
    if (pathname === '/api/state' && req.method === 'GET') {
      return json(res, 200, {
        app: 'Torfilms',
        version: '0.1.0',
        memoryMb,
        memoryMinMb: MIN_MEMORY_MB,
        memoryMaxMb: MAX_MEMORY_MB,
        cachePolicy: 'ram-only',
        torrents: allStates()
      })
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'))
      const requested = Number(body.memoryMb)
      if (!Number.isFinite(requested) || requested < MIN_MEMORY_MB || requested > MAX_MEMORY_MB) {
        return json(res, 400, { error: `Лимит памяти: от ${MIN_MEMORY_MB} до ${MAX_MEMORY_MB} МБ` })
      }
      memoryMb = Math.round(requested)
      for (const state of sessions.values()) {
        state.store = memoryStoreFor(state.torrent)
        state.store?.setMaxBytes(memoryMb * MB)
      }
      return json(res, 200, { memoryMb, memoryMinMb: MIN_MEMORY_MB, memoryMaxMb: MAX_MEMORY_MB })
    }

    const seekMatch = /^\/api\/seek\/([^/]+)\/(\d+)$/.exec(pathname)
    if (seekMatch && req.method === 'GET') {
      const state = sessions.get(seekMatch[1])
      const file = state?.torrent?.files?.[Number(seekMatch[2])]
      if (!file) return json(res, 404, { error: 'File not found' })
      const seconds = Number(url.searchParams.get('seconds'))
      if (!Number.isFinite(seconds) || seconds < 0) return json(res, 400, { error: 'Invalid seek time' })
      const executable = resolveExecutable('ffprobe')
      if (!executable) return json(res, 503, { error: 'ffprobe required for seeking' })
      const abort = new AbortController()
      const close = () => abort.abort()
      res.once('close', close)
      try {
        const plan = await seekPlan(executable, streamUrlFor(state, file, 0, 'probe'), seconds, abort.signal)
        if (!res.destroyed) json(res, 200, plan)
      } finally {
        res.removeListener('close', close)
      }
      return
    }

    const tracksMatch = /^\/api\/tracks\/([^/]+)\/(\d+)$/.exec(pathname)
    if (tracksMatch && req.method === 'GET') {
      const state = sessions.get(tracksMatch[1])
      const file = state?.torrent?.files?.[Number(tracksMatch[2])]
      if (!state || !file) return json(res, 404, { error: 'File not found' })
      const media = await probeAudioTracks(state, file)
      return json(res, 200, media)
    }

    if (pathname === '/api/torrents' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'))
      const source = ensureSource(body.source)
      const state = addTorrent(source, /^magnet:/i.test(source) ? 'magnet' : 'url')
      return json(res, 202, { id: state.id, torrent: publicState(state) })
    }

    if (pathname === '/api/torrents/file' && req.method === 'POST') {
      const data = await readBody(req, MAX_TORRENT_BYTES)
      if (!data.length) throw new Error('Пустой .torrent-файл')
      const state = addTorrent(data, 'file')
      return json(res, 202, { id: state.id, torrent: publicState(state) })
    }

    const removeMatch = /^\/api\/torrents\/([^/]+)$/.exec(pathname)
    if (removeMatch && req.method === 'DELETE') {
      const state = sessions.get(removeMatch[1])
      if (!state) return json(res, 404, { error: 'Torrent not found' })
      await removeTorrent(state)
      return json(res, 200, { ok: true })
    }

    const positionMatch = /^\/api\/playback-position\/([^/]+)\/(\d+)$/.exec(pathname)
    if (positionMatch && req.method === 'POST') {
      const state = sessions.get(positionMatch[1])
      const file = state?.torrent?.files?.[Number(positionMatch[2])]
      if (!state || !file) return json(res, 404, { error: 'Playback not found' })
      const body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}')
      const media = state.mediaInfo.get(Number(positionMatch[2]))
      const position = clamp(Number(body.seconds) || 0, 0, media?.duration || Number.MAX_SAFE_INTEGER)
      const bytePosition = media?.duration ? file.length * position / media.duration : 0
      const pieceStep = (state.torrent?.pieceLength || 1024 * 1024) * 2
      if (!state.activeTranscode && (state.activeFile !== Number(positionMatch[2]) || Math.abs(bytePosition - (state.windowPosition ?? -1)) >= pieceStep)) {
        selectPlaybackWindow(state, file, bytePosition)
      } else {
        state.activePosition = bytePosition
        state.playbackDemand = { fileIndex: Number(positionMatch[2]), position: bytePosition, updatedAt: Date.now() }
      }
      return json(res, 200, { ok: true, seconds: position, bytePosition })
    }

    const playerMatch = /^\/api\/player\/([^/]+)\/(\d+)$/.exec(pathname)
    if (playerMatch && req.method === 'POST') {
      const state = sessions.get(playerMatch[1])
      if (!state) return json(res, 404, { error: 'Torrent not found' })
      const body = req.headers['content-length'] ? JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}') : {}
      const launched = launchPlayer(state, Number(playerMatch[2]), body.player)
      return json(res, 200, { ok: true, ...launched })
    }

    const streamMatch = /^\/stream\/([^/]+)\/(\d+)$/.exec(pathname)
    if (streamMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const state = sessions.get(streamMatch[1])
      const file = state?.torrent?.files?.[Number(streamMatch[2])]
      if (!state || !file) return json(res, 404, { error: 'Stream not found' })
      return streamFile(req, res, state, file)
    }

    const playbackMatch = /^\/playback\/([^/]+)\/(\d+)$/.exec(pathname)
    if (playbackMatch && req.method === 'GET') {
      const state = sessions.get(playbackMatch[1])
      const file = state?.torrent?.files?.[Number(playbackMatch[2])]
      if (!state || !file) return json(res, 404, { error: 'Playback not found' })
      return transcodeFile(req, res, state, file, url.searchParams.get('start'))
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'API route not found' })
    return serveStatic(req, res, pathname)
  } catch (error) {
    json(res, 400, { error: error.message || 'Request failed' })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Torfilms is ready at http://127.0.0.1:${server.address().port}`)
  console.log(`RAM cache: ${memoryMb} MB · video data is never written to disk`)
})

function shutdown () {
  for (const state of sessions.values()) {
    if (state.activeTranscode && !state.activeTranscode.killed) state.activeTranscode.kill()
  }
  server.close()
  client.destroy(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
