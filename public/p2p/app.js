import { RamStore, installReader } from './ram-store.js'
import WebTorrent from './webtorrent.min.js'
import { videoFiles } from './catalog-model.js'
import { createPieceFallback } from './piece-fallback.js'
import { ramLimitBytes } from './ram-limits.js'
import { streamMediaSource } from './media-source-player.js'
import { readProgress, writeProgress } from './watch-progress.js'
export function mountPlayer (root, { movie: initialMovie, quality: initialQuality, compact = false } = {}) {
const $ = s => root.querySelector(s)
const updateRamLabel = () => { if ($('#ram-value')) $('#ram-value').textContent = `${$('#ram').value} МБ` }
$('#ram').oninput = updateRamLabel
updateRamLabel()
let disposed = false
let client, torrent, store, generation = 0
let bridge = false
let httpBytes = 0
let catalogueSelection = null
let joinQueue = Promise.resolve(), joinRequest = 0, catalogueRequest = 0, joining = false
let selectedFile = null, audioMedia = null, audioOffset = 0, audioActive = false, audioRequest = 0, audioTimer
let trackScan = 0, trackRetry
let mediaStream = null
let resumeTime = null, lastProgress = 0, subtitleAbort, subtitleUrl, subtitleElement, watchSource
function saveProgress () {
  if (!selectedFile || !torrent || !watchSource || timelineTarget !== null || resumeTime !== null) return
  const time = $('video').currentTime + (audioActive ? audioOffset : 0)
  if (!Number.isFinite(time) || time < 1) return
  const index = torrent.files.indexOf(selectedFile)
  writeProgress(watchSource.movie, { hash: torrent.infoHash, quality: watchSource.quality, index, time: Math.floor(time), season: watchSource.episodes?.find(e => e.index === index)?.season ?? watchSource.season ?? 1 })
}
function clearSubtitles () {
  subtitleAbort?.abort(); subtitleElement?.remove(); subtitleElement = null
  if (subtitleUrl) URL.revokeObjectURL(subtitleUrl)
  subtitleUrl = null
}
async function applySubtitles () {
  clearSubtitles()
  const id = $('#subtitle-track')?.value
  if (!id || !audioMedia) return
  const controller = subtitleAbort = new AbortController()
  try {
    $('#subtitle-status').textContent = 'Загружаю субтитры…'
    const response = await fetch(`/bridge/subtitles/${audioMedia.hash}/${audioMedia.index}?file=${id}`, { signal: controller.signal })
    if (!response.ok) throw new Error((await response.json()).error || 'Ошибка субтитров')
    const text = await response.text()
    if (controller.signal.aborted) return
    subtitleUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }))
    const track = subtitleElement = document.createElement('track')
    track.kind = 'subtitles'; track.label = 'Субтитры'; track.srclang = 'ru'; track.src = subtitleUrl; track.default = true
    track.onload = () => { for (const cue of Array.from(track.track.cues || [])) { cue.startTime = Math.max(0, cue.startTime - (audioActive ? audioOffset : 0)); cue.endTime = Math.max(cue.startTime, cue.endTime - (audioActive ? audioOffset : 0)) }; track.track.mode = 'showing'; $('#subtitle-status').textContent = 'Субтитры включены (WebVTT)' }
    track.onerror = () => { $('#subtitle-status').textContent = 'Браузер не смог прочитать субтитры' }
    $('video').append(track); track.track.mode = 'showing'
  } catch (e) { if (!controller.signal.aborted) $('#subtitle-status').textContent = e.message }
}
if ($('#subtitle-track')) $('#subtitle-track').onchange = applySubtitles
let timelineDragging = false, timelineTarget = null
const clockText = seconds => {
  const n = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(n / 3600) ? `${Math.floor(n / 3600)}:` : ''}${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}
function renderTimeline () {
  const duration = audioMedia?.duration || 0
  const time = timelineDragging ? Number($('#audio-seek').value) : timelineTarget ?? ($('video').currentTime + (audioActive ? audioOffset : 0))
  $('#audio-seek').max = String(duration)
  $('#audio-seek').disabled = !(duration > 0)
  if (!timelineDragging) $('#audio-seek').value = String(Math.min(duration, time || 0))
  $('#audio-time').textContent = duration > 0 ? `${clockText(time)} / ${clockText(duration)}` : 'Длительность уточняется…'
}
const audioTypes = { aac: 'audio/mp4; codecs="mp4a.40.2"', mp3: 'audio/mp4; codecs="mp4a.6B"', opus: 'audio/mp4; codecs="opus"', flac: 'audio/mp4; codecs="fLaC"' }
async function mediaJson (route) {
  const response = await fetch(route)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Ошибка аудиопотока')
  return data
}
async function chooseFile (file, value) {
  saveProgress(); clearSubtitles()
  if ($('#subtitle-track')) { $('#subtitle-track').replaceChildren(new Option('Выключены', '')); $('#subtitle-status').textContent = '' }
  mediaStream?.destroy(); mediaStream = null
  ++audioRequest; ++trackScan; clearTimeout(trackRetry)
  clearTimeout(audioTimer)
  selectedFile = file; audioMedia = null; audioActive = false; audioOffset = 0
  watchSource = catalogueSelection
  timelineDragging = false; timelineTarget = null; renderTimeline()
  if ($('#episode')) $('#episode').value = String(value.files.indexOf(file))
  $('#audio-panel').hidden = true
  file.streamTo($('video'))
  $('video').play().catch(() => status('Нажмите Play'))
  if (!bridge) return
  await refreshTracks(true)
}
async function refreshTracks (initial = false) {
  if (!bridge || !selectedFile || !torrent || disposed) return
  clearTimeout(trackRetry)
  const file = selectedFile, value = torrent, scan = ++trackScan
  const previous = $('#audio-track').value
  $('#audio-panel').hidden = false
  if (!audioMedia) $('#audio-track').disabled = true
  $('#audio-mode').textContent = 'Получаю список озвучек… Видео продолжает играть.'
  try {
    const index = value.files.indexOf(file)
    const saved = initial && catalogueSelection?.infoHash === value.infoHash ? catalogueSelection.audioMetadata?.[index] : null
    const data = saved ? JSON.parse(JSON.stringify(saved)) : await mediaJson(`/bridge/tracks/${value.infoHash}/${index}`)
    if (disposed || scan !== trackScan || selectedFile !== file) return
    data.tracks = [...data.tracks.map(t => ({ ...t, id: String(t.index) })), ...(data.externalTracks || []).map(t => ({ ...t, id: `file:${t.fileIndex}` }))]
    audioMedia = { ...data, index, hash: value.infoHash }
    if ($('#subtitle-track')) {
      const current = $('#subtitle-track').value
      $('#subtitle-track').replaceChildren(new Option('Выключены', ''))
      for (const sub of data.subtitles || []) $('#subtitle-track').append(new Option(sub.title, String(sub.fileIndex)))
      if ([...$('#subtitle-track').options].some(o => o.value === current)) $('#subtitle-track').value = current
    }
    renderTimeline()
    $('#audio-track').replaceChildren()
    for (const track of data.tracks) {
      const option = document.createElement('option')
      option.value = track.id
      option.textContent = [catalogueSelection?.audioLabels?.[track.external ? `file:${track.fileIndex}` : `${index}:${track.index}`] || track.title || `Дорожка ${track.index}`, track.external ? 'Внешняя озвучка' : '', track.language, track.codec, track.channels ? `${track.channels} ch` : ''].filter(Boolean).join(' · ')
      $('#audio-track').append(option)
    }
    if (data.tracks.some(t => t.id === previous)) $('#audio-track').value = previous
    $('#audio-track').disabled = !data.tracks.length
    $('#audio-seek').max = String(data.duration)
    $('#audio-mode').textContent = data.tracks.length ? 'Список озвучек обновлён. Выберите нужную дорожку.' : 'Озвучки не найдены. Можно повторить поиск без перезапуска видео.'
    if (!data.pending && resumeTime !== null && data.tracks.length) { const target = Math.min(resumeTime, Math.max(0, data.duration - 1)); resumeTime = null; await applyAudio(target, true) }
    else if (data.pending) trackRetry = setTimeout(() => refreshTracks(), 1000)
    else if (initial && !audioActive && data.tracks.length && !supportsAudio(data.tracks[0])) await applyAudio()
  } catch (e) {
    if (disposed || scan !== trackScan || selectedFile !== file) return
    $('#audio-mode').textContent = `Не удалось получить озвучки: ${e.message}. Повторю через 5 секунд без перезапуска видео.`
    trackRetry = setTimeout(() => refreshTracks(initial), 5000)
  }
}
if ($('#audio-refresh')) $('#audio-refresh').onclick = () => refreshTracks()
function supportsAudio (track) { return Boolean(audioTypes[track.codec] && $('video').canPlayType(audioTypes[track.codec])) }
async function applyAudio (position, resume) {
  if (!audioMedia) return
  const request = ++audioRequest
  clearTimeout(audioTimer)
  const video = $('video')
  position ??= video.currentTime + (audioActive ? audioOffset : 0)
  resume ??= !video.paused
  let track = audioMedia.tracks.find(t => t.id === $('#audio-track').value)
  if (!track) return
  timelineTarget = position; renderTimeline()
  $('#audio-mode').textContent = 'Подготавливаю выбранную дорожку…'
  try {
    if (track.external) {
      const external = await mediaJson(`/bridge/tracks/${audioMedia.hash}/${track.fileIndex}`)
      if (request !== audioRequest) return
      if (!external.tracks.length) throw new Error('Во внешнем файле нет аудиодорожки')
      track = { ...track, ...external.tracks[0] }
    }
    const copy = supportsAudio(track)
    const base = `${audioMedia.hash}/${audioMedia.index}`
    const plan = await mediaJson(`/bridge/audio-plan/${base}?start=${position}`)
    if (request !== audioRequest) return
    video.pause()
    mediaStream?.destroy(); mediaStream = null
    const url = `/bridge/audio/${base}?track=${track.index}&copy=${copy ? 1 : 0}&start=${position}${track.external ? `&audioFile=${track.fileIndex}` : ''}`
    mediaStream = streamMediaSource(video, { url, duration: audioMedia.duration, origin: plan.origin, position, audioCodec: copy ? ({ aac: 'mp4a.40.2', mp3: 'mp4a.6B', opus: 'opus', flac: 'fLaC' }[track.codec]) : 'mp4a.40.2',
      onSeek: time => applyAudio(time), onError: error => { if (request === audioRequest) $('#audio-mode').textContent = error.message }
    })
    audioOffset = mediaStream ? 0 : plan.origin; audioActive = true
    if (!mediaStream) { video.src = url; video.load() }
    if ($('#subtitle-track')?.value) applySubtitles()
    let positioned = !!mediaStream || plan.localTime === 0
    const wait = () => {
      if (request !== audioRequest) return
      if (video.error) { $('#audio-mode').textContent = `Не удалось запустить выбранную озвучку: ${video.error.message || video.error.code}`; return }
      if (!positioned) for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= plan.localTime && video.buffered.end(i) > plan.localTime) { video.currentTime = plan.localTime; positioned = true; break }
      }
      if (positioned && !video.seeking && video.readyState >= 2) {
        timelineTarget = null; renderTimeline()
        if (resume) video.play().catch(() => status('Нажмите Play'))
        return
      }
      audioTimer = setTimeout(wait, 200)
    }
    wait()
    $('#audio-mode').textContent = copy ? 'Аудио и видео без перекодирования; выбранная озвучка в MP4-потоке с моста по HTTPS (не P2P).' : 'Звук → AAC стерео, видео без перекодирования. Поток с моста по HTTPS (не P2P).'
  } catch (e) { if (request === audioRequest) { timelineTarget = null; renderTimeline(); $('#audio-mode').textContent = `Озвучка не применена: ${e.message}. Исходный поток не изменён.`; status(e.message) } }
}
$('#audio-track').onchange = () => applyAudio()
$('#audio-original').onclick = () => { mediaStream?.destroy(); mediaStream = null; ++audioRequest; clearTimeout(audioTimer); audioActive = false; audioOffset = 0; selectedFile?.streamTo($('video')); $('#audio-mode').textContent = 'Исходный P2P-поток с начала. Кодеки не изменяются.' }
$('#audio-seek').oninput = () => { timelineDragging = true; renderTimeline() }
$('#audio-seek').onchange = () => {
  const target = Number($('#audio-seek').value)
  timelineDragging = false
  if (audioActive) applyAudio(target)
  else { timelineTarget = target; $('video').currentTime = target; renderTimeline() }
}
$('video').addEventListener('seeked', () => { if (!audioActive) timelineTarget = null; renderTimeline() })
$('video').addEventListener('timeupdate', renderTimeline)
$('video').addEventListener('timeupdate', () => { if (Date.now() - lastProgress > 5000) { saveProgress(); lastProgress = Date.now() } })
$('video').addEventListener('pause', saveProgress)
globalThis.addEventListener?.('pagehide', saveProgress)
const viewer = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
async function bridgePost (route, data) {
  const response = await fetch(`/bridge/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Bridge error')
  return result
}
const trackers = ['wss://tracker.openwebtorrent.com', 'wss://tracker.btorrent.xyz']
const status = text => { if (!disposed) $('#status').textContent = text }
$('video').addEventListener('playing', () => status('Воспроизведение'))
async function stop () {
  saveProgress(); clearSubtitles()
  mediaStream?.destroy(); mediaStream = null
  ++trackScan; clearTimeout(trackRetry)
  ++audioRequest; clearTimeout(audioTimer); audioMedia = null; selectedFile = null; $('#audio-panel').hidden = true
  generation++
  $('video').pause(); $('video').removeAttribute('src'); $('video').load()
  $('#files').replaceChildren()
  if ($('#episode')) { $('#episode').replaceChildren(); $('#episode').disabled = true }
  const old = client; client = torrent = store = null
  httpBytes = 0
  if (old) await new Promise(r => old.destroy(r))
  status('Остановлено. RAM-кеш очищен.')
}
async function prepare () {
  // Validate independently of HTML attributes, before stopping a working player.
  const limit = ramLimitBytes($('#ram').value)
  const rate = Number($('#upload').value)
  if (!Number.isFinite(rate) || rate < 1 || rate > 10240) throw new Error('Отдача: 1–10240 КиБ/с')
  await stop()
  if (!isSecureContext || !('serviceWorker' in navigator)) throw new Error('Нужен HTTPS (на компьютере также подходит localhost). Домашний HTTP-адрес не поддерживает этот режим.')
  if (!WebTorrent.WEBRTC_SUPPORT) throw new Error('WebRTC не поддерживается этим браузером')
  client = new WebTorrent({ dht: false, lsd: false, maxConns: 12, downloadLimit: -1, uploadLimit: rate * 1024, tracker: true })
  client.on('error', error => status(error.message))
  const registration = await navigator.serviceWorker.register(new URL('./sw.min.js', import.meta.url).href, { scope: new URL('./', import.meta.url).pathname })
  const worker = registration.active || registration.installing || registration.waiting
  if (worker.state !== 'activated') await new Promise(resolve => worker.addEventListener('statechange', () => { if (worker.state === 'activated') resolve() }))
  client.createServer({ controller: registration })
  bridge = false
  try { bridge = (await (await fetch('/bridge/config')).json()).enabled === true } catch {}
  if (bridge) status(compact ? 'Подключаю раздачу…' : 'Hybrid-мост включён: его RAM-кеш находится на компьютере-сервере, ваш кеш — в этом браузере.')
  const announce = bridge ? [`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/tracker`] : trackers
  return { limit, options: { announce, store: RamStore, storeCacheSlots: 0, deselect: true, storeOpts: { limit, onStore: value => { store = value } } } }
}
function ready (value, limit) {
  torrent = value
  status(compact ? 'Подключено' : 'Подключено. Выберите видео; полученные куски автоматически доступны другим зрителям.')
  $('#magnet').value = value.magnetURI
  value.on('error', error => status(error.message))
  const fallback = bridge ? createPieceFallback(value, limit, count => { httpBytes += count }) : null
  for (const file of value.files) {
    installReader(file, value, limit, bridge ? (first, last) => {
      bridgePost('demand', { infoHash: value.infoHash, first, last, viewer }).catch(e => { if (value === torrent && $('video').readyState < 2) status(e.message) })
    } : null, fallback)
    const entry = videoFiles(value.files, catalogueSelection?.episodes).find(e => e.file === file)
    if (!entry) continue
    const button = document.createElement('button')
    button.textContent = entry.title
    button.onclick = () => chooseFile(file, value)
    $('#files').append(button)
  }
  const episodes = $('#episode')
  if (episodes) {
    episodes.replaceChildren()
    for (const { title, index } of videoFiles(value.files, catalogueSelection?.episodes)) { const option = document.createElement('option'); option.value = String(index); option.textContent = title; episodes.append(option) }
    episodes.disabled = !episodes.options.length
    episodes.onchange = () => chooseFile(value.files[Number(episodes.value)], value)
  }
}
async function connect (source, selection, request) {
  if (request !== joinRequest) return
  joining = true
  $('#seed').disabled = true
  try {
    const { limit, options } = await prepare()
    if (request !== joinRequest) return
    let metadata = selection?.torrentBase64
    if (bridge) {
      const started = await bridgePost('start', selection ? { movie: selection.movie, quality: selection.quality } : { magnet: source })
      if (request !== joinRequest) return
      options.announce = [`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${started.tracker || '/tracker'}`]
      // Fetch metadata before joining RTC: a bridge that connected before metadata
      // arrived may not advertise its new metadata size to an existing RTC peer.
      const deadline = Date.now() + 90000
      status('Получаю список видео от моста…')
      while (!metadata) {
        const info = await mediaJson(`/bridge/metadata/${started.infoHash}`)
        if (request !== joinRequest) return
        if (info.ready) { metadata = info.torrentBase64; break }
        if (Date.now() > deadline) throw new Error('Мост не получил метаданные за 90 секунд. Проверьте доступность раздачи или добавьте .torrent-файл.')
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
    const id = generation
    status(compact ? 'Загружаю видео…' : 'Ищу WebRTC-пиров. Если их нет, обычные torrent-пиры не смогут передать видео браузеру.')
    const input = metadata ? Uint8Array.from(atob(metadata), c => c.charCodeAt(0)) : source
    const value = client.add(input, options, value => {
      if (id !== generation || request !== joinRequest) return
      ready(value, limit)
      if (selection) {
        const videos = videoFiles(value.files, selection.episodes)
        const progress = readProgress(selection.movie)
        const remembered = progress?.hash === value.infoHash && progress.quality === selection.quality ? videos.find(f => f.index === progress.index) : null
        const chosen = remembered || videos.find(f => f.index === selection.fileIndex) || videos[0]
        resumeTime = remembered ? progress.time : null
        if (chosen) chooseFile(chosen.file, value)
        else status('В раздаче не найдено видео. Выберите другую раздачу.')
      }
    })
    torrent = value
    value.on('warning', error => { if (id === generation && !value.ready && !/Unsupported tracker protocol/.test(error.message)) status(`Поиск пиров: ${error.message}`) })
  } catch (error) { if (request === joinRequest) status(error.message) }
  finally { joining = false; $('#seed').disabled = false }
}
$('#join').onsubmit = event => {
  event.preventDefault()
  const source = $('#magnet').value.trim()
  if (!source.startsWith('magnet:?')) return status('Введите magnet-ссылку')
  const selection = catalogueSelection, request = ++joinRequest
  joinQueue = joinQueue.catch(() => {}).then(() => connect(source, selection, request))
}
$('#magnet').oninput = () => { catalogueSelection = null; catalogueRequest++ }
$('#seed').onchange = async event => {
  const file = event.target.files[0]
  if (!file) return
  if (joining) return status('Дождитесь завершения подключения.')
  try {
    const { limit, options } = await prepare()
    if (file.size > limit / 2) throw new Error('Для первой раздачи выберите файл не больше половины RAM-лимита.')
    bridge = false
    options.announce = trackers
    const id = generation
    status('Читаю локальное видео и создаю раздачу…')
    client.seed(file, options, value => { if (id === generation) ready(value, limit) })
  } catch (error) { status(error.message) }
  event.target.value = ''
}
$('#stop').onclick = () => { ++joinRequest; ++catalogueRequest; joinQueue = joinQueue.catch(() => {}).then(stop) }
$('video').onerror = () => status('Браузер не воспроизводит этот кодек или поток. Обработка тяжёлых форматов пока не реализована.')
const statsTimer = setInterval(() => {
  $('#stats').textContent = `WebRTC-пиры: ${torrent?.numPeers || 0}\nПриём P2P: ${Math.round((torrent?.downloadSpeed || 0) / 1024)} КиБ/с · Отдача: ${Math.round((torrent?.uploadSpeed || 0) / 1024)} КиБ/с\nРезерв HTTPS → RAM: ${(httpBytes / 1024 ** 2).toFixed(1)} МБ\nОтдано: ${((torrent?.uploaded || 0) / 1024 ** 2).toFixed(1)} МБ\nRAM-куски: ${((store?.used || 0) / 1024 ** 2).toFixed(1)} МБ`
}, 1000)
if (!isSecureContext) status('Откройте по HTTPS: Service Worker недоступен на обычном HTTP-адресе домашней сети.')
fetch('/bridge/config').then(r => r.json()).then(config => {
  if (!config.enabled || compact || disposed) return
  $('h1').textContent = 'Torfilms · Hybrid-мост'
  $('.warning').textContent = `Мост получает данные от TCP/uTP-пиров и передаёт браузерам через WebRTC. До ${config.maxWorkers || 1} независимых раздач, кеш каждой — ${config.memoryMb} МБ. RAM браузера задаётся ниже. IP-адрес виден пирам.`
}).catch(() => {})
async function catalogueQuality (movie, quality) {
  const request = ++catalogueRequest
  try {
    const saved = await mediaJson(`/catalog/source/${movie}/${quality}`)
    if (request !== catalogueRequest) return
    catalogueSelection = { ...saved, movie, quality }
    if (initialMovie?.activeSeason != null) catalogueSelection.episodes = (saved.episodes || []).map(e => ({ ...e, excluded: e.excluded || (e.season ?? saved.season ?? 1) !== initialMovie.activeSeason }))
    $('#magnet').value = saved.magnet
    $('#join').requestSubmit()
  } catch (error) { status(error.message) }
}
const movieId = initialMovie?.id || new URLSearchParams(location.search).get('imdb')
if (movieId && /^tt\d{7,10}$/.test(movieId)) {
  (initialMovie ? Promise.resolve([initialMovie]) : mediaJson('/catalog/movies')).then(movies => {
    if (disposed) return
    const movie = movies.find(m => m.id === movieId)
    if (!movie) return status('Карточка фильма не найдена')
    const label = document.createElement('label')
    label.textContent = compact ? 'Качество ' : `${movie.title} · Качество `
    const select = document.createElement('select')
    for (const source of movie.sources) { const option = document.createElement('option'); option.value = source.id; option.textContent = source.label; select.append(option) }
    label.append(select); ($('#quality-slot') || $('video').parentNode).insertBefore(label, $('#quality-slot') ? null : $('video'))
    const chosen = initialQuality || new URLSearchParams(location.search).get('quality')
    if (movie.sources.some(s => s.id === chosen)) select.value = chosen
    select.onchange = () => catalogueQuality(movieId, select.value)
    if (select.value) catalogueQuality(movieId, select.value)
  }).catch(e => status(e.message))
}
return {
  playQuality: quality => catalogueQuality(movieId, quality),
  retryIfStopped () { if (!$('video').getAttribute('src')) catalogueQuality(movieId, $('#quality-slot select')?.value || catalogueSelection?.quality || initialQuality) },
  destroy () {
    saveProgress(); globalThis.removeEventListener?.('pagehide', saveProgress)
    disposed = true
    ++trackScan; clearTimeout(trackRetry)
    ++joinRequest; ++catalogueRequest; ++audioRequest; clearTimeout(audioTimer); clearInterval(statsTimer)
    $('video').pause()
    joinQueue = joinQueue.catch(() => {}).then(stop)
    return joinQueue
  }
}
}
