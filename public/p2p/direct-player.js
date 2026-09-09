import { startDirectAudio } from './direct-audio.js'
import { nativeStallCheck } from './native-stall.js'

// Video always stays on the original torrent URL, even with external audio.
export function startDirectPlayback (video, file, { position = 0, torrent, fileIndex, onTracks = () => {}, onAudioReady = () => {}, onReady, onError }) {
  let destroyed = false, external
  const tracks = () => onTracks(Array.from(video.audioTracks || [], (track, index) => ({ id: `native:${index}`, title: track.label || `Дорожка ${index + 1}`, language: track.language })))
  const ready = () => {
    if (destroyed) return
    if (position > 0) video.currentTime = Number.isFinite(video.duration) ? Math.min(position, Math.max(0, video.duration - 0.01)) : position
    tracks(); onReady()
    video.play().catch(() => { if (!destroyed) onError(new Error('Нажмите Play для начала воспроизведения')) })
  }
  const error = () => { if (!destroyed) onError(new Error('Браузер не смог воспроизвести исходный MKV. Выберите перепаковку на устройстве или режим моста. Автоматическое преобразование отключено.')) }
  video.pause(); video.removeAttribute('src'); video.load()
  video.addEventListener('loadedmetadata', ready, { once: true })
  video.addEventListener('error', error)
  video.audioTracks?.addEventListener?.('addtrack', tracks)
  video.audioTracks?.addEventListener?.('removetrack', tracks)
  try { file.streamTo(video) } catch (e) { onError(e) }
  const watchdog = setInterval(nativeStallCheck(video, onError), 1000)
  return { transport: 'direct', selectAudio (track) {
    external?.destroy(); external = null
    if (track?.external) {
      try { external = startDirectAudio(video, { torrent, fileIndex, track, duration: video.duration, onReady: onAudioReady, onError }) } catch (error) { onError(error) }
    } else {
      const index = Number(track?.id?.split(':')[1] || 0)
      Array.from(video.audioTracks || []).forEach((t, i) => { t.enabled = i === index })
      onAudioReady()
    }
  }, destroy () { destroyed = true; clearInterval(watchdog); external?.destroy(); video.removeEventListener('loadedmetadata', ready); video.removeEventListener('error', error); video.audioTracks?.removeEventListener?.('addtrack', tracks); video.audioTracks?.removeEventListener?.('removetrack', tracks) } }
}
