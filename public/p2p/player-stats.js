export function createPlayerStats () {
  let previous
  const mb = n => ((Number(n) || 0) / 1024 ** 2).toFixed(1)
  return ({ now = Date.now(), video, torrent, store, cache, stream, audioActive, httpBytes }) => {
    const quality = video.getVideoPlaybackQuality?.()
    const bytes = stream?.receivedBytes || 0
    const local = stream?.transport === 'local-remux'
    const elapsed = previous ? (now - previous.now) / 1000 : 0
    const same = previous?.stream === stream && previous?.torrent === torrent
    const rate = value => `${mb(value) } МиБ/с`
    const mp4Rate = same && elapsed > 0 ? Math.max(0, bytes - previous.bytes) / elapsed : 0
    let ahead = 0
    for (let i = 0; i < (video.buffered?.length || 0); i++) if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) ahead = video.buffered.end(i) - video.currentTime
    const frames = quality ? quality.totalVideoFrames - quality.droppedVideoFrames : null
    const fps = same && elapsed > 0 && frames !== null && previous.frames !== null && frames >= previous.frames ? ((frames - previous.frames) / elapsed).toFixed(1) : '—'
    previous = { now, bytes, stream, torrent, frames }
    return [
      `Воспроизведение: ${!torrent ? 'не запущено' : local ? 'torrent / P2P → перепаковка в браузере' : audioActive ? 'HTTPS / MP4 с моста (не P2P)' : 'torrent / P2P'}`,
      `Состояние: ${video.paused ? 'пауза' : video.readyState < 3 ? 'буферизация' : 'воспроизведение'} · Буфер впереди: ${ahead.toFixed(1)} с`,
      `Показано кадров/с: ${fps} · Пропущено кадров: ${quality?.droppedVideoFrames ?? '—'}`,
      ...(local ? [`Чтение контейнера из RAM: ${rate(mp4Rate)} · Прочитано: ${mb(bytes)} МиБ (включая повторные чтения, не сетевой трафик)`] : audioActive ? [stream ? `Приём MP4: ${rate(mp4Rate)} · Получено за текущий поток: ${mb(bytes)} МиБ` : 'Приём MP4: прямой поток; браузер не предоставляет счётчик байтов'] : []),
      `WebRTC-пиры: ${torrent?.numPeers || 0}`,
      `Приём P2P: ${rate(torrent?.downloadSpeed)} · Отдача P2P: ${rate(torrent?.uploadSpeed)}`,
      `Получено torrent-кусков через HTTPS: ${mb(httpBytes)} МиБ · Отдано P2P: ${mb(torrent?.uploaded)} МиБ`,
      ...(torrent?._fallbackStatus ? [`${torrent._fallbackStatus} · ${Math.max(0, (now - torrent._fallbackStageAt) / 1000).toFixed(1)} с`] : []),
      `RAM-куски текущей раздачи: ${mb(store?.used)} МиБ`,
      ...(local ? [`Обработка: ${stream.diagnostics || '—'}`] : []),
      `RAM-кеш страницы: ${mb(cache.used)} / ${mb(cache.limit)} МиБ (без буфера декодера)`
    ].join('\n')
  }
}
