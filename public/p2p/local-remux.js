export function startLocalRemux (video, { torrent, fileIndex, track, duration, position = 0, resume = true, audioOnly = false, onMetadata, onSeek, onReady, onError }) {
  if (!globalThis.MediaSource || !globalThis.Worker) throw new Error('Браузер не поддерживает MediaSource или Web Worker')
  const worker = new Worker(new URL('./local-remux-worker.js', import.meta.url), { type: 'module' })
  const abort = new AbortController(), readers = new Set()
  let media, buffer, audioBuffer, objectUrl, initialized = false, receivedBytes = 0, failed = false
  let wantsPlay = resume
  let phase = 'запуск', lastRead = '', paceTime = 0
  const playIntent = () => { wantsPlay = true }
  const pauseIntent = () => { wantsPlay = false }
  const contains = time => Array.from({ length: video.buffered.length }, (_, i) => i).some(i => time >= video.buffered.start(i) && time < video.buffered.end(i))
  const seeking = () => { if ((initialized || Math.abs(video.currentTime - position) > 0.25) && !contains(video.currentTime)) onSeek(video.currentTime) }
  video.addEventListener('seeking', seeking)
  function destroy () {
    if (abort.signal.aborted) return
    abort.abort(); worker.terminate(); video.removeEventListener('seeking', seeking)
    video.removeEventListener('play', playIntent); video.removeEventListener('pause', pauseIntent)
    for (const reader of readers) reader.return().catch(() => {})
    readers.clear(); if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
  const fail = error => { if (!abort.signal.aborted && !failed) { failed = true; destroy(); onError(error) } }
  const waitEvent = (target, name, action) => new Promise((resolve, reject) => {
    const cleanup = () => { target.removeEventListener(name, done); target.removeEventListener('error', error); abort.signal.removeEventListener('abort', error) }
    const done = () => { cleanup(); resolve() }
    const error = () => { cleanup(); reject(new Error(video.error?.message || `Ошибка ${name}: поток остановлен или браузер отклонил данные`)) }
    target.addEventListener(name, done, { once: true }); target.addEventListener('error', error, { once: true }); abort.signal.addEventListener('abort', error, { once: true })
    try { action?.() } catch (e) { cleanup(); reject(e) }
  })
  const delay = () => new Promise(resolve => {
    const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, 150); abort.signal.addEventListener('abort', done, { once: true })
  })
  async function handle (message) {
    phase = message.type
    if (message.type === 'read') {
      const file = torrent.files[message.fileIndex]
      lastRead = `${message.fileIndex}:${message.start}-${message.end}`
      if (!file || ![fileIndex, track?.fileIndex].includes(message.fileIndex) || !Number.isSafeInteger(message.start) || !Number.isSafeInteger(message.end) || message.start < 0 || message.end > file.length || message.end <= message.start || message.end - message.start > 256 * 1024) throw new Error('Недопустимый диапазон чтения MKV')
      const reader = file[Symbol.asyncIterator]({ start: message.start, end: message.end - 1 }); readers.add(reader)
      try {
        const bytes = new Uint8Array(message.end - message.start); let offset = 0
        for await (const chunk of reader) { if (abort.signal.aborted) return; bytes.set(chunk, offset); offset += chunk.length; lastRead = `${message.fileIndex}:${message.start}-${message.end} (${offset}/${bytes.length})` }
        if (offset !== bytes.length) throw new Error('Torrent-поток оборвался до конца диапазона')
        receivedBytes += bytes.length; phase = 'read done'; return bytes
      } finally { readers.delete(reader); await reader.return() }
    }
    if (message.type === 'metadata') {
      duration = message.duration
      const selected = onMetadata(message)
      if (selected) track = selected
      return { audioIndex: track?.id?.startsWith('local:') ? Number(track.id.slice(6)) : null, audioFile: track?.external ? track.fileIndex : null, audioLength: track?.external ? torrent.files[track.fileIndex]?.length : null }
    }
    if (message.type === 'configure') {
      if (!MediaSource.isTypeSupported(message.mime)) throw new Error(`Браузер не поддерживает выбранные кодеки: ${message.mime}. Выберите другую озвучку или режим моста.`)
      if (message.audioMime && !MediaSource.isTypeSupported(message.audioMime)) throw new Error(`Браузер не поддерживает ${message.audioMime}. Выберите режим моста.`)
      media = new MediaSource(); objectUrl = URL.createObjectURL(media)
      await waitEvent(media, 'sourceopen', () => { video.pause(); video.src = objectUrl; video.load() })
      video.addEventListener('play', playIntent); video.addEventListener('pause', pauseIntent)
      buffer = media.addSourceBuffer(message.mime); buffer.timestampOffset = message.timestampOffset || 0
      if (message.audioMime) audioBuffer = media.addSourceBuffer(message.audioMime)
      media.duration = duration; position = message.position; video.currentTime = position
      return
    }
    if (message.type === 'pace') {
      paceTime = message.timestamp
      while (!abort.signal.aborted && initialized && message.timestamp > Math.max(position, video.currentTime) + 20) await delay()
      return
    }
    if (message.type === 'append' || message.type === 'appendAudio') {
      const target = message.type === 'appendAudio' ? audioBuffer : buffer
      if (video.currentTime > 30 && target.buffered.length && target.buffered.start(0) < video.currentTime - 30) await waitEvent(target, 'updateend', () => target.remove(0, video.currentTime - 20))
      // MPEG audio has no embedded timestamps. Anchor each packet to the MKV
      // presentation clock, using the SAME MediaSource/video clock as video.
      if (Number.isFinite(message.timestamp)) target.timestampOffset = message.timestamp
      await waitEvent(target, 'updateend', () => target.appendBuffer(message.bytes))
      if (!initialized && contains(position)) {
        initialized = true; video.currentTime = position; onReady()
        if (wantsPlay) video.play().catch(() => onError(new Error('Нажмите Play для начала воспроизведения')))
      }
      return
    }
    if (message.type === 'end' && media?.readyState === 'open') { media.endOfStream(); return }
  }
  worker.onmessage = async event => {
    if (abort.signal.aborted) return
    const message = event.data
    if (message.type === 'error') { fail(new Error(message.message)); return }
    try {
      const value = await handle(message)
      if (!abort.signal.aborted) worker.postMessage({ type: 'reply', id: message.id, value }, value instanceof Uint8Array ? [value.buffer] : [])
    } catch (e) { fail(e) }
  }
  worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Не удалось загрузить обработчик MKV')) }
  worker.postMessage({ type: 'start', audioOnly, fileIndex, length: torrent.files[fileIndex].length, audioIndex: track?.id?.startsWith('local:') ? Number(track.id.slice(6)) : null, audioFile: track?.external ? track.fileIndex : null, audioLength: track?.external ? torrent.files[track.fileIndex]?.length : null, duration, position })
  return { transport: 'local-remux', get receivedBytes () { return receivedBytes }, get diagnostics () { return `${phase} · пакет ${paceTime.toFixed(2)} с · чтение ${lastRead} · ${torrent.files[fileIndex]._readStatus || ''}` }, destroy }
}
