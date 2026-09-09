// Recover a stalled native demuxer only when data exists at the playhead.
// Never seek over a missing range or retry endlessly at the same position.
export function nativeStallCheck (video, onError, now = Date.now) {
  let time = video.currentTime, changed = now(), recoveryAt = null, reported = false
  return () => {
    const current = now()
    if (video.paused || video.ended || video.error || !Number.isFinite(video.currentTime)) { time = video.currentTime; changed = current; return }
    if (Math.abs(video.currentTime - time) > 0.01) {
      time = video.currentTime; changed = current
      if (recoveryAt !== null && time > recoveryAt + 10) { recoveryAt = null; reported = false }
      return
    }
    if (video.seeking || current - changed < 8000 || reported) return
    const hasData = Array.from({ length: video.buffered.length }, (_, i) => i).some(i => video.buffered.start(i) <= time && video.buffered.end(i) > time + 1)
    if (!hasData) { changed = current; return }
    if (recoveryAt !== null) {
      reported = true; onError(new Error('Прямой MKV завис несмотря на загруженный буфер. Автовосстановление не помогло. Выберите перепаковку на устройстве — видео останется без перекодирования.')); return
    }
    recoveryAt = time; changed = current
    // A seek at the existing timestamp flushes the native decoder and also
    // repositions the external dub via its normal seeking/seeked handlers.
    video.currentTime = time
  }
}
