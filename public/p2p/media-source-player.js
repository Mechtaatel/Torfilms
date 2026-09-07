// Keep the browser's native controls while exposing the whole movie timeline.
export function streamMediaSource (video, { url, duration, origin, position, audioCodec = 'mp4a.40.2', onSeek, onError }) {
  const mime = `video/mp4; codecs="avc1.640028,${audioCodec}"`
  if (!globalThis.MediaSource?.isTypeSupported(mime)) return null
  const media = new MediaSource(), abort = new AbortController()
  const objectUrl = URL.createObjectURL(media)
  let initializing = true
  const contains = time => Array.from({ length: video.buffered.length }, (_, i) => i).some(i => time >= video.buffered.start(i) && time < video.buffered.end(i))
  const seeking = () => { if (!initializing && !contains(video.currentTime)) onSeek(video.currentTime) }
  video.addEventListener('seeking', seeking)
  media.addEventListener('sourceopen', async () => {
    try {
      const buffer = media.addSourceBuffer(mime)
      buffer.timestampOffset = origin
      media.duration = duration
      video.currentTime = position
      const change = action => new Promise((resolve, reject) => {
        const cleanup = () => { buffer.removeEventListener('updateend', done); buffer.removeEventListener('error', fail); abort.signal.removeEventListener('abort', fail) }
        const done = () => { cleanup(); resolve() }
        const fail = () => { cleanup(); reject(new Error('Поток остановлен или кодек не поддерживается')) }
        buffer.addEventListener('updateend', done, { once: true }); buffer.addEventListener('error', fail, { once: true }); abort.signal.addEventListener('abort', fail, { once: true })
        try { action() } catch (e) { cleanup(); reject(e) }
      })
      const response = await fetch(url, { signal: abort.signal })
      if (!response.ok) throw new Error(`Ошибка аудиопотока: HTTP ${response.status}`)
      const reader = response.body.getReader()
      while (!abort.signal.aborted) {
        // Bound the decoder buffer; the torrent RAM cache remains separate.
        if (buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) - video.currentTime > 30) {
          await new Promise(r => setTimeout(r, 200)); continue
        }
        if (video.currentTime > 30 && buffer.buffered.length && buffer.buffered.start(0) < video.currentTime - 30) await change(() => buffer.remove(0, video.currentTime - 20))
        const { value, done } = await reader.read()
        if (done) break
        await change(() => buffer.appendBuffer(value))
        if (contains(position)) initializing = false
      }
      if (!abort.signal.aborted && media.readyState === 'open') { media.endOfStream(); media.duration = Math.max(duration, media.duration) }
    } catch (error) { if (!abort.signal.aborted) onError(error) }
  }, { once: true })
  video.src = objectUrl
  video.load()
  return { destroy () { abort.abort(); video.removeEventListener('seeking', seeking); URL.revokeObjectURL(objectUrl) } }
}
