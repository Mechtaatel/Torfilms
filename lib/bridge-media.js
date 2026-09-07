import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readRange } from './range-reader.js'
import { playbackArgs } from './playback-args.js'
import { seekPlan } from './seek-plan.js'
import { externalAudioFiles } from './external-audio.js'

export function bridgeMedia (getTorrent, getBase, metadata) {
  const cache = new Map()
  const children = new Set()
  const ffmpeg = process.env.TORFILMS_FFMPEG || 'ffmpeg'
  const ffprobe = process.env.TORFILMS_FFPROBE || 'ffprobe'
  const rawUrl = (hash, index) => `${getBase()}/bridge/raw/${hash}/${index}`
  async function probe (url, signal) {
    const child = spawn(ffprobe, ['-v', 'error', '-analyzeduration', '500000', '-probesize', '131072', '-show_streams', '-show_format', '-of', 'json', url], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    const cancel = () => child.kill()
    signal.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, 60000)
    let output = '', errors = ''
    child.stdout.on('data', b => { output += b; if (output.length > 1024 * 1024) child.kill() })
    child.stderr.on('data', b => { errors = (errors + b).slice(-2000) })
    try {
      const [code] = await once(child, 'close')
      if (code !== 0) throw new Error(errors || 'Не удалось определить озвучки за 60 секунд')
      const data = JSON.parse(output)
      return { duration: Number(data.format?.duration) || 0, tracks: data.streams.filter(s => s.codec_type === 'audio').map(s => ({ index: s.index, codec: s.codec_name, language: s.tags?.language, title: s.tags?.title, channels: s.channels })) }
    } finally { clearTimeout(timer); children.delete(child); signal.removeEventListener('abort', cancel) }
  }
  async function handle (req, res, url) {
    const match = /^\/bridge\/(raw|tracks|audio-plan|audio)\/([a-f0-9]{40})\/(\d+)$/.exec(url.pathname)
    if (!match) return false
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
    const torrent = getTorrent(), index = Number(match[3]), file = torrent?.files?.[index]
    if (!['GET', 'HEAD'].includes(req.method)) { json(405, { error: 'GET required' }); return true }
    if (!torrent?.ready || torrent.infoHash !== match[2] || !file) { json(404, { error: 'Файл не готов на мосте' }); return true }
    const abort = new AbortController()
    res.once('close', () => abort.abort())
    try {
      if (match[1] === 'raw') {
        let start = 0, end = file.length - 1
        const range = req.headers.range
        if (range) {
          const parts = /^bytes=(\d+)-(\d*)$/.exec(range)
          if (!parts || Number(parts[1]) >= file.length || (parts[2] && Number(parts[2]) < Number(parts[1]))) { res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }); res.end(); return true }
          start = Number(parts[1]); end = parts[2] ? Math.min(end, Number(parts[2])) : end
        }
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${file.length}` } : {}) })
        if (req.method === 'HEAD') { res.end(); return true }
        for await (const data of readRange(file, torrent, start, end, abort.signal)) {
          if (!res.write(data)) await once(res, 'drain', { signal: abort.signal })
        }
        res.end(); return true
      }
      const inputUrl = rawUrl(torrent.infoHash, index)
      const key = `${torrent.infoHash}:${index}`
      if (match[1] === 'tracks') {
        const media = cache.get(key) || await metadata?.get(torrent.infoHash, index) || await probe(inputUrl, abort.signal)
        const result = { ...media, externalTracks: externalAudioFiles(torrent.files, index) }
        cache.set(key, result); await metadata?.put(torrent.infoHash, index, result)
        json(200, result); return true
      }
      const start = Number(url.searchParams.get('start') || 0)
      if (!Number.isFinite(start) || start < 0) throw new Error('Invalid start')
      if (match[1] === 'audio-plan') {
        json(200, start ? await seekPlan(ffprobe, inputUrl, start, abort.signal) : { origin: 0, localTime: 0 }); return true
      }
      const track = Number(url.searchParams.get('track'))
      const audioFile = url.searchParams.has('audioFile') ? Number(url.searchParams.get('audioFile')) : index
      if (audioFile !== index && !externalAudioFiles(torrent.files, index).some(t => t.fileIndex === audioFile)) throw new Error('Озвучка не относится к выбранной серии')
      const audioKey = `${torrent.infoHash}:${audioFile}`
      if (!cache.has(audioKey)) cache.set(audioKey, await metadata?.get(torrent.infoHash, audioFile) || await probe(rawUrl(torrent.infoHash, audioFile), abort.signal))
      if (!cache.get(audioKey)?.tracks.some(t => t.index === track)) throw new Error('Сначала получите список озвучек и выберите дорожку')
      const codec = cache.get(audioKey).tracks.find(t => t.index === track).codec
      const copyAudio = url.searchParams.get('copy') === '1' && ['aac', 'mp3', 'opus', 'flac'].includes(codec)
      if (children.size >= 4) { json(429, { error: 'Мост занят обработкой аудио' }); return true }
      const external = audioFile !== index
      const audioSeek = external && start ? Math.max(0, (await seekPlan(ffprobe, inputUrl, start, abort.signal)).origin) : start
      const child = spawn(ffmpeg, playbackArgs({ inputUrl, seek: start, audioUrl: external ? rawUrl(torrent.infoHash, audioFile) : undefined, audioSeek, audioMap: `${external ? 1 : 0}:${track}`, copyAudio }), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      children.add(child)
      abort.signal.addEventListener('abort', () => child.kill(), { once: true })
      // Sending headers only after spawn allows missing FFmpeg to produce a clear error.
      try { await once(child, 'spawn') } catch (error) { children.delete(child); throw error }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' })
      let errors = ''
      child.stderr.on('data', b => { errors = (errors + b).slice(-2000) })
      child.once('close', code => { if (code && !abort.signal.aborted) console.error(`Audio stream failed: ${errors.replace(/https?:\/\/\S+/g, '[input]')}`) })
      child.once('close', code => { children.delete(child); if (code && !res.destroyed) res.destroy() })
      child.stdout.pipe(res)
      return true
    } catch (e) {
      if (!res.destroyed) {
        if (res.headersSent) res.destroy(e)
        else json(400, { error: e.message })
      }
      return true
    }
  }
  return { handle, close: () => { for (const child of children) child.kill() } }
}
