const ui = {
  source: document.querySelector('#source-input'),
  form: document.querySelector('#add-form'),
  file: document.querySelector('#torrent-file'),
  notice: document.querySelector('#notice'),
  sessions: document.querySelector('#sessions-list'),
  count: document.querySelector('#session-count'),
  server: document.querySelector('#server-status'),
  memory: document.querySelector('#memory-slider'),
  memoryValue: document.querySelector('#memory-value'),
  applyMemory: document.querySelector('#apply-memory'),
  empty: document.querySelector('#viewer-empty'),
  viewer: document.querySelector('#viewer-content'),
  playerShell: document.querySelector('#player-shell'),
  viewerTitle: document.querySelector('#viewer-title'),
  video: document.querySelector('#video'),
  overlay: document.querySelector('#video-overlay'),
  playToggle: document.querySelector('#play-toggle'),
  currentTime: document.querySelector('#time-current'),
  timelineCache: document.querySelector('#timeline-cache'),
  timelineBuffer: document.querySelector('#timeline-buffer'),
  timeline: document.querySelector('#timeline'),
  totalTime: document.querySelector('#time-total'),
  bufferStatus: document.querySelector('#buffer-status'),
  muteToggle: document.querySelector('#mute-toggle'),
  volume: document.querySelector('#volume'),
  fullscreen: document.querySelector('#fullscreen'),
  files: document.querySelector('#files-list'),
  cache: document.querySelector('#active-cache'),
  loadStatus: document.querySelector('#load-status'),
  audioControl: document.querySelector('#audio-control'),
  audioSelect: document.querySelector('#audio-select'),
  remove: document.querySelector('#remove-torrent'),
  vlc: document.querySelector('#open-vlc'),
  footer: document.querySelector('#transfer-footer')
}

let appState = { memoryMb: 1024, torrents: [] }
let activeId = null
let activeFileIndex = null
let activeAudioIndex = 0
let activeDuration = 0
let transcodeOffset = 0
let timelineDragging = false
let playbackRequest = 0
const mediaCache = new Map()
let pollTimer = null
let activePlaybackUrl = ''
let resumeAfterVisibility = false
let heartbeatTimer = null
let lastFilmPosition = 0
let memoryDraft = null
let memoryApplying = false
let fullscreenHideTimer = null
let fullscreenActive = false
let fullscreenNativeSeen = false
let lastFullscreenPointer = ''
let bufferWaitTimer = null
let seekPreparation = null
let pendingSeek = null

function cancelBufferWait () {
  clearTimeout(bufferWaitTimer)
  bufferWaitTimer = null
}

function bytes (value) {
  if (!Number.isFinite(value) || value <= 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / (1024 ** power)
  return `${amount >= 10 || power === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[power]}`
}

function speed (value) { return `${bytes(value)}/с` }

function phaseLabel (phase) {
  return ({ metadata: 'Метаданные', connecting: 'Соединение', ready: 'Готов', playing: 'Воспроизведение', complete: 'Готово', error: 'Ошибка', stopped: 'Остановлен' })[phase] || phase
}

function setNotice (message = '', error = false) {
  ui.notice.textContent = message
  ui.notice.classList.toggle('error', error)
}

function setMemoryLabel (value) {
  ui.memoryValue.textContent = value >= 1024 ? `${(value / 1024).toFixed(value % 1024 ? 1 : 0)} ГБ` : `${value} МБ`
  const percent = Math.max(0, Math.min(100, ((value - Number(ui.memory.min)) / (Number(ui.memory.max) - Number(ui.memory.min))) * 100))
  ui.memory.style.background = `linear-gradient(90deg, var(--cyan) 0%, var(--cyan) ${percent}%, #273651 ${percent}%, #273651 100%)`
}

function setVolumeFill (value = ui.video.volume) {
  const volume = Math.max(0, Math.min(1, Number(value) || 0))
  const percent = volume * 100
  ui.volume.style.background = `linear-gradient(90deg, var(--cyan) 0%, var(--cyan) ${percent}%, #273651 ${percent}%, #273651 100%)`
}

function formatTime (value) {
  if (!Number.isFinite(value) || value < 0) return '--:--'
  const total = Math.floor(value)
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`
}

function setTimelineDuration (duration) {
  if (!Number.isFinite(duration) || duration <= 0) return
  activeDuration = duration
  ui.timeline.max = String(duration)
  ui.totalTime.textContent = formatTime(duration)
  updateMediaControls()
}

function currentFilmTime () {
  if (pendingSeek) return pendingSeek.target
  const offset = ui.video.dataset.playbackMode === 'aac' ? transcodeOffset : 0
  return Math.max(0, offset + (Number(ui.video.currentTime) || 0))
}

function activeFileSnapshot () {
  const torrent = appState.torrents.find(item => item.id === activeId)
  return { torrent, file: torrent?.files.find(item => item.index === activeFileIndex) }
}

function bufferedAheadSeconds () {
  const current = Number(ui.video.currentTime) || 0
  for (let index = 0; index < ui.video.buffered.length; index += 1) {
    const start = ui.video.buffered.start(index)
    const end = ui.video.buffered.end(index)
    if (current >= start - 0.25 && current <= end) return Math.max(0, end - current)
  }
  return 0
}

function playWhenReady (requestId, localStart = 0) {
  cancelBufferWait()
  let attempts = 0
  let positioned = localStart === 0
  const tryPlay = () => {
    if (requestId !== playbackRequest) return
    if (ui.video.error) { cancelBufferWait(); pendingSeek = null; return }
    if (!positioned) {
      for (let i = 0; i < ui.video.buffered.length; i++) {
        if (ui.video.buffered.start(i) <= localStart && ui.video.buffered.end(i) > localStart) {
          ui.video.currentTime = localStart
          positioned = true
          break
        }
      }
    }
    const hasFutureData = ui.video.readyState >= 3
    const remaining = activeDuration ? Math.max(0, activeDuration - currentFilmTime()) : Infinity
    const hasSmallSafetyBuffer = bufferedAheadSeconds() >= Math.min(3, remaining)
    // Paused progressive media can stop fetching after a single fragment.
    // Do not wait forever for 3 seconds when the browser has enough data.
    const canReleaseShortBuffer = attempts >= 10 && ui.video.readyState === 4 && bufferedAheadSeconds() >= Math.min(1, remaining)
    const pausedPreview = pendingSeek && !pendingSeek.resume
    if (positioned && !ui.video.seeking && ui.video.readyState >= 2 && (pausedPreview || (hasFutureData && (hasSmallSafetyBuffer || canReleaseShortBuffer)))) {
      const resume = pendingSeek ? pendingSeek.resume : true
      pendingSeek = null
      cancelBufferWait()
      ui.overlay.classList.add('off')
      updateMediaControls()
      if (resume) ui.video.play().catch(() => setNotice('Нажмите Play: браузер заблокировал автозапуск.', false))
      return
    }
    if (attempts++ === 150) setNotice('Ожидаем непрерывный буфер в выбранной позиции…')
    bufferWaitTimer = setTimeout(tryPlay, 200)
  }
  tryPlay()
}

function renderCachedRanges () {
  if (!ui.timelineCache) return
  const { file } = activeFileSnapshot()
  const size = Number(file?.size) || 0
  const ranges = file?.cachedRanges || []
  ui.timelineCache.innerHTML = size
    ? ranges.map(range => {
      const left = Math.max(0, Math.min(100, Number(range[0]) / size * 100))
      const width = Math.max(0, Math.min(100 - left, (Number(range[1]) - Number(range[0])) / size * 100))
      return `<i style="left:${left}%;width:${width}%"></i>`
    }).join('')
    : ''
}

function updateBufferStatus () {
  if (!ui.bufferStatus || !ui.timelineBuffer) return
  const duration = activeDuration || Number(ui.video.duration)
  const offset = ui.video.dataset.playbackMode === 'aac' ? transcodeOffset : 0
  const buffered = []
  for (let index = 0; index < ui.video.buffered.length; index += 1) {
    const start = offset + ui.video.buffered.start(index)
    const end = offset + ui.video.buffered.end(index)
    buffered.push([start, end])
  }
  const ahead = bufferedAheadSeconds()
  ui.bufferStatus.textContent = `буфер ${formatTime(ahead)}`
  ui.timelineBuffer.innerHTML = Number.isFinite(duration) && duration > 0
    ? buffered.map(range => {
      const left = Math.max(0, Math.min(100, range[0] / duration * 100))
      const width = Math.max(0, Math.min(100 - left, (range[1] - range[0]) / duration * 100))
      return `<i style="left:${left}%;width:${width}%"></i>`
    }).join('')
    : ''
}

function updateMediaControls () {
  const current = Math.min(activeDuration || Number.MAX_SAFE_INTEGER, currentFilmTime())
  if (activeId !== null && activeFileIndex !== null && Number.isFinite(current)) lastFilmPosition = current
  if (!timelineDragging) {
    ui.currentTime.textContent = formatTime(current)
    ui.timeline.value = String(current)
  }
  ui.playToggle.textContent = (pendingSeek ? !pendingSeek.resume : ui.video.paused) ? '▶' : 'Ⅱ'
  ui.muteToggle.textContent = ui.video.muted || ui.video.volume === 0 ? '🔇' : '🔊'
  setVolumeFill(ui.video.volume)
  updateBufferStatus()
}

function seekTo (seconds) {
  if (!activeId || activeFileIndex === null) return
  const target = Math.max(0, Math.min(activeDuration || Number(seconds), Number(seconds) || 0))
  if (ui.video.dataset.playbackMode === 'aac') {
    playFileWithTrack(activeId, activeFileIndex, activeAudioIndex, target)
  } else {
    ui.video.currentTime = target
  }
}

function renderSessions () {
  ui.count.textContent = appState.torrents.length
  if (!appState.torrents.length) {
    ui.sessions.innerHTML = '<div class="empty-sessions"><span class="empty-icon">◌</span><p>Здесь появятся<br>подключённые торренты</p></div>'
    return
  }
  ui.sessions.innerHTML = appState.torrents.map(torrent => `
    <article class="session-card ${torrent.id === activeId ? 'active' : ''}" data-id="${torrent.id}">
      <div class="session-top"><span class="session-name" title="${escapeHtml(torrent.name)}">${escapeHtml(torrent.name)}</span><span class="session-state ${torrent.phase}">${phaseLabel(torrent.phase)}</span></div>
      <div class="session-meta"><span>${torrent.peers} peers</span><span>${speed(torrent.downloadSpeed)}</span><span>${bytes(torrent.downloaded)} / ${bytes(torrent.length)}</span></div>
      <div class="bar"><i style="width:${Math.round((torrent.progress || 0) * 100)}%"></i></div>
    </article>`).join('')
  ui.sessions.querySelectorAll('.session-card').forEach(card => card.addEventListener('click', () => selectTorrent(card.dataset.id)))
}

function renderViewer (force = false) {
  const torrent = appState.torrents.find(item => item.id === activeId)
  if (!torrent) {
    activeId = null
    activeFileIndex = null
    ui.empty.classList.remove('hidden')
    ui.viewer.classList.add('hidden')
    return
  }
  ui.empty.classList.add('hidden')
  ui.viewer.classList.remove('hidden')
  if (force || ui.viewerTitle.textContent !== torrent.name) ui.viewerTitle.textContent = torrent.name
  const ram = torrent.memory
  const activeFile = torrent.files.find(file => file.index === activeFileIndex)
  ui.cache.textContent = activeFile
    ? `RAM-кэш · ${bytes(activeFile.cachedBytes)} · лимит ${bytes(ram.maxBytes)}`
    : `RAM-кэш · ${bytes(ram.usedBytes)} · лимит ${bytes(ram.maxBytes)}`
  const sourceRate = mediaCache.get(`${torrent.id}:${activeFileIndex}`)?.bitrate ? mediaCache.get(`${torrent.id}:${activeFileIndex}`).bitrate / 8 : 0
  const speedNote = sourceRate && torrent.downloadSpeed
    ? (torrent.downloadSpeed >= sourceRate * 1.15 ? ` · запас +${speed(torrent.downloadSpeed - sourceRate)}` : ' · скорость близка к битрейту')
    : ''
  ui.loadStatus.textContent = `ЗАГРУЖЕНО · ${bytes(torrent.downloaded)} / ${bytes(torrent.length)} · ${speed(torrent.downloadSpeed)}${speedNote}`
  const media = activeFileIndex === null ? { tracks: [], duration: 0, bitrate: 0 } : (mediaCache.get(`${torrent.id}:${activeFileIndex}`) || { tracks: [], duration: 0, bitrate: 0 })
  const tracks = media.tracks || []
  if (activeFileIndex !== null && media.duration) setTimelineDuration(media.duration)
  ui.audioControl.classList.toggle('hidden', tracks.length < 2)
  if (tracks.length >= 2) {
    const options = tracks.map(track => `<option value="${track.index}">${escapeHtml(trackLabel(track))}</option>`).join('')
    if (ui.audioSelect.dataset.options !== options) {
      ui.audioSelect.innerHTML = options
      ui.audioSelect.dataset.options = options
    }
    ui.audioSelect.value = String(activeAudioIndex)
  }
  renderCachedRanges()
  ui.files.innerHTML = torrent.files.length
    ? torrent.files.map(file => `
      <div class="file-row ${file.index === activeFileIndex ? 'current' : ''}">
        <button data-file="${file.index}" title="Воспроизвести">▶</button>
        <span class="file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</span>
        ${file.browserTranscode ? '<span class="audio-badge">AAC</span>' : ''}
        <span class="file-size">${bytes(file.size)}</span>
      </div>`).join('')
    : `<div class="file-row"><span class="file-name">${torrent.ready ? 'Файлы не найдены' : 'Ожидаем метаданные…'}</span></div>`
  ui.files.querySelectorAll('button[data-file]').forEach(button => button.addEventListener('click', () => playFile(torrent.id, Number(button.dataset.file))))
  ui.overlay.classList.toggle('off', !ui.video.src || ui.video.readyState >= 3)
}

function selectTorrent (id) {
  activeId = id
  const torrent = appState.torrents.find(item => item.id === id)
  activeFileIndex = torrent?.activeFile ?? null
  renderSessions()
  renderViewer(true)
}

async function playFile (id, fileIndex) {
  pendingSeek = null
  seekPreparation?.abort()
  cancelBufferWait()
  const requestId = ++playbackRequest
  const torrent = appState.torrents.find(item => item.id === id)
  const file = torrent?.files.find(item => item.index === fileIndex)
  if (!file) return
  activeId = id
  activeFileIndex = fileIndex
  activeAudioIndex = 0
  activeDuration = 0
  transcodeOffset = 0
  lastFilmPosition = 0
  ui.timeline.max = '0'
  ui.timeline.value = '0'
  renderSessions()
  renderViewer(true)
  ui.overlay.classList.remove('off')
  // Probe before opening playback: an unknown codec used to select the
  // expensive video encoder, even for browser-compatible H.264 files.
  setNotice('Определяю видеокодек и звуковые дорожки…')
  const media = await loadMediaInfo(id, fileIndex)
  if (requestId !== playbackRequest) return
  const initialTranscode = needsTranscode(file, media)
  const initialPath = initialTranscode
    ? `/playback/${encodeURIComponent(id)}/${fileIndex}?audio=${activeAudioIndex}`
    : `/stream/${encodeURIComponent(id)}/${fileIndex}`
  ui.video.dataset.playbackMode = initialTranscode ? 'aac' : 'direct'
  activePlaybackUrl = initialPath
  ui.video.src = initialPath
  ui.video.load()
  if (initialTranscode) setNotice('Запускаю RAM-поток. Дорожки и длительность определяются параллельно…')
  playWhenReady(requestId)

  const tracks = media.tracks || []
  activeDuration = media.duration || 0
  renderViewer(true)
  const transcode = needsTranscode(file, media)
  if (transcode !== initialTranscode) {
    await playFileWithTrack(id, fileIndex, activeAudioIndex, currentFilmTime())
    return
  }
  if (transcode) setNotice(tracks.length > 1 ? `Выбрана озвучка: ${trackLabel(tracks[activeAudioIndex])}. Аудио преобразуется в AAC стерео через RAM-поток.` : 'Для совместимости MKV/AC-3 включён аудиорежим AAC стерео. Данные проходят через RAM-поток.')
}

async function loadMediaInfo (id, fileIndex) {
  const key = `${id}:${fileIndex}`
  if (mediaCache.has(key)) return mediaCache.get(key)
  try {
    const response = await fetch(`/api/tracks/${encodeURIComponent(id)}/${fileIndex}`, { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Не удалось определить медиадорожки')
    const media = { tracks: data.tracks || [], duration: Number(data.duration) || 0, bitrate: Number(data.bitrate) || 0, video: data.video || null }
    if (media.tracks.length || media.duration || media.video) mediaCache.set(key, media)
    return media
  } catch {
    return { tracks: [], duration: 0, bitrate: 0, video: null }
  }
}

function trackLabel (track) {
  if (!track) return 'Дорожка 1'
  const languageNames = { ru: 'Русский', rus: 'Русский', en: 'English', eng: 'English', uk: 'Українська', deu: 'Deutsch', de: 'Deutsch', fra: 'Français', fr: 'Français', spa: 'Español', es: 'Español' }
  const language = languageNames[String(track.language || '').toLowerCase()] || track.language
  const channel = track.channels ? `${track.channels === 6 ? '5.1' : `${track.channels} ch`}` : ''
  const details = [track.title, language, track.codec?.toUpperCase(), channel].filter(Boolean).join(' · ')
  return details ? `Дорожка ${track.index + 1} · ${details}` : `Дорожка ${track.index + 1}`
}

function needsTranscode (file, media) {
  const tracks = media.tracks || []
  const browserUnsupportedAudio = new Set(['ac3', 'eac3', 'dts', 'dts_hd', 'truehd', 'mlp', 'flac'])
  const browserVideoCodecs = new Set(['h264', 'hevc', 'vp9', 'av1'])
  const videoCodec = String(media.video?.codec || '').toLowerCase()
  return Boolean(file.browserTranscode) || tracks.length > 1 || tracks.some(track => browserUnsupportedAudio.has(String(track.codec || '').toLowerCase())) || (videoCodec && !browserVideoCodecs.has(videoCodec))
}

async function changeAudio () {
  if (activeId === null || activeFileIndex === null) return
  const position = currentFilmTime()
  activeAudioIndex = Number(ui.audioSelect.value) || 0
  await playFileWithTrack(activeId, activeFileIndex, activeAudioIndex, position)
}

async function playFileWithTrack (id, fileIndex, trackIndex, position) {
  const resume = pendingSeek ? pendingSeek.resume : !ui.video.paused
  pendingSeek = { target: Math.max(0, position || 0), resume }
  ui.video.pause()
  updateMediaControls()
  cancelBufferWait()
  seekPreparation?.abort()
  const preparation = new AbortController()
  seekPreparation = preparation
  const requestId = ++playbackRequest
  const torrent = appState.torrents.find(item => item.id === id)
  const file = torrent?.files.find(item => item.index === fileIndex)
  const media = await loadMediaInfo(id, fileIndex)
  if (requestId !== playbackRequest) return
  const tracks = media.tracks || []
  if (!file) return
  let plan = { origin: 0, localTime: 0 }
  if (position > 0) {
    setNotice('Подготавливаю перемотку…')
    try {
      const response = await fetch(`/api/seek/${encodeURIComponent(id)}/${fileIndex}?seconds=${position}`, { signal: preparation.signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Не удалось подготовить перемотку')
      plan = data
    } catch (error) {
      if (requestId === playbackRequest && error.name !== 'AbortError') {
        pendingSeek = null
        updateMediaControls()
        setNotice(error.message, true)
      }
      return
    }
  }
  if (requestId !== playbackRequest) return
  activeId = id
  activeFileIndex = fileIndex
  activeAudioIndex = trackIndex
  activeDuration = media.duration || activeDuration
  transcodeOffset = plan.origin
  lastFilmPosition = Math.max(0, position || 0)
  renderSessions()
  renderViewer(true)
  ui.overlay.classList.remove('off')
  activePlaybackUrl = `/playback/${encodeURIComponent(id)}/${fileIndex}?audio=${trackIndex}&start=${Math.max(0, position || 0)}`
  ui.video.dataset.playbackMode = 'aac'
  ui.video.src = activePlaybackUrl
  ui.video.load()
  playWhenReady(requestId, plan.localTime)
  setNotice(`Выбрана озвучка: ${trackLabel(tracks[trackIndex])}.`)
}

async function addMagnet (event) {
  event.preventDefault()
  const source = ui.source.value.trim()
  if (!source) return
  setNotice('Подключаюсь и получаю метаданные…')
  try {
    const response = await fetch('/api/torrents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Не удалось подключить torrent')
    activeId = data.id
    activeFileIndex = null
    ui.source.value = ''
    setNotice('Сеанс добавлен. Ищу peers…')
    await refresh()
  } catch (error) { setNotice(error.message, true) }
}

async function addFile () {
  const file = ui.file.files[0]
  if (!file) return
  setNotice(`Загружаю метаданные ${file.name}…`)
  try {
    const response = await fetch('/api/torrents/file', { method: 'POST', headers: { 'Content-Type': 'application/x-bittorrent', 'X-Torrent-Name': file.name }, body: await file.arrayBuffer() })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Не удалось открыть .torrent')
    activeId = data.id
    activeFileIndex = null
    ui.file.value = ''
    setNotice('Сеанс добавлен. Ищу peers…')
    await refresh()
  } catch (error) { setNotice(error.message, true) }
}

async function applyMemory () {
  const requested = Number(ui.memory.value)
  memoryApplying = true
  try {
    const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memoryMb: requested }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Не удалось обновить кеш')
    appState.memoryMb = data.memoryMb
    memoryDraft = null
    ui.memory.value = String(data.memoryMb)
    setMemoryLabel(data.memoryMb)
    setNotice(`Лимит RAM-кеша: ${formatMemory(data.memoryMb)}. Старые pieces освобождены.`)
    await refresh()
  } catch (error) {
    setNotice(error.message, true)
  } finally {
    memoryApplying = false
  }
}

async function removeActive () {
  pendingSeek = null
  seekPreparation?.abort()
  if (!activeId) return
  cancelBufferWait()
  playbackRequest += 1
  const oldId = activeId
  try {
    const response = await fetch(`/api/torrents/${encodeURIComponent(oldId)}`, { method: 'DELETE' })
    if (!response.ok) throw new Error('Не удалось остановить сеанс')
    activeId = null
    activeFileIndex = null
    activeAudioIndex = 0
    activeDuration = 0
    transcodeOffset = 0
    lastFilmPosition = 0
    activePlaybackUrl = ''
    ui.timeline.max = '0'
    ui.timeline.value = '0'
    ui.currentTime.textContent = '--:--'
    ui.totalTime.textContent = '--:--'
    ui.video.removeAttribute('src')
    ui.video.load()
    setNotice('Сеанс остановлен, RAM-кеш очищен.')
    await refresh()
  } catch (error) { setNotice(error.message, true) }
}

async function openPlayer () {
  if (!activeId || activeFileIndex === null) return setNotice('Сначала выберите видео.', true)
  try {
    const response = await fetch(`/api/player/${encodeURIComponent(activeId)}/${activeFileIndex}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player: 'vlc' }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Не удалось запустить плеер')
    setNotice(`Поток открыт в ${data.player}.`)
  } catch (error) { setNotice(error.message, true) }
}

async function toggleFullscreen () {
  const current = fullscreenActive || document.fullscreenElement || document.webkitFullscreenElement
  if (current) {
    fullscreenActive = false
    clearTimeout(fullscreenHideTimer)
    const exit = document.exitFullscreen || document.webkitExitFullscreen
    if (exit && (document.fullscreenElement || document.webkitFullscreenElement)) await exit.call(document)
    updateFullscreenButton()
    return
  }
  const target = ui.playerShell
  const enter = target?.requestFullscreen || target?.webkitRequestFullscreen
  if (!enter) return setNotice('Полный экран недоступен в этом окне браузера.', true)
  try {
    fullscreenActive = true
    updateFullscreenButton()
    await enter.call(target)
    showFullscreenControls()
  } catch {
    fullscreenActive = false
    updateFullscreenButton()
    setNotice('Не удалось открыть полный экран. Разрешите полноэкранный режим для локального приложения.', true)
  }
}

function updateFullscreenButton () {
  const active = fullscreenActive || Boolean(document.fullscreenElement || document.webkitFullscreenElement)
  ui.fullscreen.textContent = active ? '×' : '⛶'
  ui.fullscreen.title = active ? 'Выйти из полноэкранного режима' : 'На весь экран'
  ui.playerShell.classList.toggle('fullscreen-active', active)
  if (active) showFullscreenControls()
  else {
    clearTimeout(fullscreenHideTimer)
    ui.playerShell.classList.remove('controls-hidden')
  }
}

function handleFullscreenChange () {
  const nativeFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement)
  if (nativeFullscreen) fullscreenNativeSeen = true
  else if (fullscreenNativeSeen) {
    fullscreenNativeSeen = false
    fullscreenActive = false
  }
  updateFullscreenButton()
}

function showFullscreenControls () {
  clearTimeout(fullscreenHideTimer)
  ui.playerShell.classList.remove('controls-hidden')
  const active = fullscreenActive || Boolean(document.fullscreenElement || document.webkitFullscreenElement)
  if (active && !ui.video.paused) {
    fullscreenHideTimer = setTimeout(() => ui.playerShell.classList.add('controls-hidden'), 2600)
  }
}

function handleFullscreenPointer (event) {
  const active = fullscreenActive || Boolean(document.fullscreenElement || document.webkitFullscreenElement)
  if (!active) return
  if (event.type === 'pointermove') {
    const point = `${event.clientX}:${event.clientY}`
    if (point === lastFullscreenPointer) return
    lastFullscreenPointer = point
  }
  showFullscreenControls()
}

function reportPlaybackPosition () {
  if (document.hidden || !activeId || activeFileIndex === null || ui.video.paused) return
  const seconds = currentFilmTime()
  fetch(`/api/playback-position/${encodeURIComponent(activeId)}/${activeFileIndex}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seconds })
  }).catch(() => {})
}

function recoverPlayback (shouldPlay = true) {
  if (!activeId || activeFileIndex === null || !activePlaybackUrl) return
  const position = Math.max(lastFilmPosition, currentFilmTime())
  if (ui.video.dataset.playbackMode === 'aac') {
    playFileWithTrack(activeId, activeFileIndex, activeAudioIndex, position)
    return
  }
  const path = activePlaybackUrl
  ui.video.src = path
  ui.video.load()
  ui.video.addEventListener('loadedmetadata', () => {
    if (position > 0 && Number.isFinite(ui.video.duration)) ui.video.currentTime = position
    if (shouldPlay) ui.video.play().catch(() => {})
  }, { once: true })
}

async function refresh () {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Сервер недоступен')
    appState = data
    if (Number.isFinite(data.memoryMinMb)) ui.memory.min = String(data.memoryMinMb)
    if (Number.isFinite(data.memoryMaxMb)) ui.memory.max = String(data.memoryMaxMb)
    if (memoryDraft === null && !memoryApplying) {
      ui.memory.value = data.memoryMb
      setMemoryLabel(data.memoryMb)
    }
    renderSessions()
    renderViewer()
    const active = data.torrents.find(item => item.id === activeId)
    ui.footer.textContent = active ? `↓ ${speed(active.downloadSpeed)} · ${active.peers} peers` : '↓ 0 KB/s · 0 peers'
    ui.server.textContent = 'Локальный движок · RAM-only'
  } catch (error) {
    ui.server.textContent = 'Нет связи с движком'
  } finally {
    pollTimer = setTimeout(refresh, 1200)
  }
}

function formatMemory (value) { return value >= 1024 ? `${value / 1024} ГБ` : `${value} МБ` }
function plural (n) { return n % 10 === 1 && n % 100 !== 11 ? '' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'а' : 'ов' }
function escapeHtml (value) { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]) }

ui.form.addEventListener('submit', addMagnet)
ui.file.addEventListener('change', addFile)
ui.memory.addEventListener('input', () => {
  memoryDraft = Number(ui.memory.value)
  setMemoryLabel(memoryDraft)
})
ui.applyMemory.addEventListener('click', applyMemory)
ui.remove.addEventListener('click', removeActive)
ui.vlc.addEventListener('click', openPlayer)
ui.audioSelect.addEventListener('change', changeAudio)
function togglePlayback () {
  if (pendingSeek) {
    pendingSeek.resume = !pendingSeek.resume
    updateMediaControls()
    return
  }
  cancelBufferWait()
  if (!ui.video.src) return
  if (ui.video.paused) ui.video.play().catch(() => {})
  else ui.video.pause()
}
ui.playToggle.addEventListener('click', togglePlayback)
ui.video.addEventListener('click', togglePlayback)
ui.timeline.addEventListener('input', () => {
  timelineDragging = true
  ui.currentTime.textContent = formatTime(Number(ui.timeline.value))
})
ui.timeline.addEventListener('change', () => {
  timelineDragging = false
  seekTo(Number(ui.timeline.value))
})
ui.volume.addEventListener('input', () => {
  ui.video.volume = Number(ui.volume.value)
  ui.video.muted = ui.video.volume === 0
  setVolumeFill(ui.video.volume)
  updateMediaControls()
})
ui.muteToggle.addEventListener('click', () => {
  ui.video.muted = !ui.video.muted
  updateMediaControls()
})
ui.fullscreen.addEventListener('click', () => {
  toggleFullscreen()
})
ui.playerShell.addEventListener('pointermove', handleFullscreenPointer)
ui.playerShell.addEventListener('pointerdown', handleFullscreenPointer)
// Some embedded browsers report mouse movement on the document instead of
// bubbling pointer events from the fullscreen element. Listen at both levels
// so moving the mouse always brings the controls back.
document.addEventListener('pointermove', handleFullscreenPointer, { passive: true })
document.addEventListener('mousemove', handleFullscreenPointer, { passive: true })
document.addEventListener('fullscreenchange', handleFullscreenChange)
document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !fullscreenActive) return
  setTimeout(() => {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      fullscreenActive = false
      fullscreenNativeSeen = false
      updateFullscreenButton()
    }
  }, 100)
})
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    resumeAfterVisibility = Boolean(activePlaybackUrl && !ui.video.paused)
    return
  }
  if (!resumeAfterVisibility) return
  resumeAfterVisibility = false
  if (!ui.video.currentSrc || ui.video.error) recoverPlayback(true)
  else ui.video.play().catch(() => {})
})
window.addEventListener('pageshow', () => {
  if (activePlaybackUrl && (!ui.video.currentSrc || ui.video.error)) recoverPlayback(true)
})
ui.video.addEventListener('loadedmetadata', () => {
  if (!activeDuration && Number.isFinite(ui.video.duration)) setTimelineDuration(ui.video.duration)
  updateMediaControls()
})
ui.video.addEventListener('durationchange', () => {
  if (!activeDuration && Number.isFinite(ui.video.duration)) setTimelineDuration(ui.video.duration)
})
ui.video.addEventListener('progress', updateBufferStatus)
ui.video.addEventListener('timeupdate', updateMediaControls)
ui.video.addEventListener('play', updateMediaControls)
ui.video.addEventListener('pause', updateMediaControls)
ui.video.addEventListener('playing', () => {
  ui.overlay.classList.add('off')
  showFullscreenControls()
})
ui.video.addEventListener('waiting', () => ui.overlay.classList.remove('off'))
ui.video.addEventListener('pause', () => {
  ui.overlay.classList.add('off')
  showFullscreenControls()
})
ui.video.addEventListener('error', () => {
  if (activeFileIndex !== null) setNotice('Браузер не смог декодировать поток. Откройте его кнопкой VLC.', true)
})

setMemoryLabel(Number(ui.memory.value))
setVolumeFill(ui.video.volume)
heartbeatTimer = setInterval(reportPlaybackPosition, 1000)
refresh()
