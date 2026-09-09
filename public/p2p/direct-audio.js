import { startLocalRemux } from './local-remux.js'

// Keep the native video's volume/mute controls intact. Reuse the one permitted
// MediaElementSource per element, restoring its output on every teardown.
const routes = new WeakMap()
function routeFor (video) {
  let route = routes.get(video)
  if (!route) {
    const context = new AudioContext(), source = context.createMediaElementSource(video), gain = context.createGain()
    source.connect(gain); gain.connect(context.destination)
    route = { context, gain }; routes.set(video, route)
  }
  return route
}

export function startDirectAudio (video, options) {
  const audio = document.createElement('audio'), route = routeFor(video)
  let stream, stopped = false, serial = 0, ready = false, held = false, internalPause = false
  let waitingSince = null, videoWaiting = false, lastCorrection = -Infinity
  let audioPlayPending = false, videoPlayPending = false
  let wantsPlay = !video.paused
  const listeners = []
  const listen = (target, name, fn) => { target.addEventListener(name, fn); listeners.push(() => target.removeEventListener(name, fn)) }
  const hold = () => {
    audio.pause()
    if (!video.paused) { held = true; internalPause = true; video.pause() }
  }
  const fail = error => { if (!stopped) { destroy(); options.onError(error) } }
  const ahead = (element, time) => {
    for (let i = 0; i < element.buffered.length; i++) {
      if (element.buffered.start(i) <= time + 0.03 && element.buffered.end(i) > time) return element.buffered.end(i) - time
    }
    return 0
  }
  const play = (element, isVideo) => {
    if (isVideo ? videoPlayPending : audioPlayPending) return
    if (isVideo) videoPlayPending = true; else audioPlayPending = true
    element.play().catch(error => {
      // A pause/seek intentionally interrupts play() on mobile browsers.
      if (error.name !== 'AbortError') fail(error)
    }).finally(() => { if (isVideo) videoPlayPending = false; else audioPlayPending = false })
  }
  const sync = () => {
    if (stopped) return
    audio.volume = video.volume; audio.muted = video.muted
    if (!ready) { hold(); return }
    if (video.seeking) { audio.pause(); return }
    // HAVE_CURRENT_DATA and short waiting/canplay transitions are normal while
    // appending MSE audio. They must not toggle the native video's pause state.
    const buffered = ahead(audio, video.currentTime)
    const remaining = Number.isFinite(audio.duration) ? Math.max(0, audio.duration - video.currentTime) : Infinity
    const refill = Math.min(0.75, remaining)
    if (held) {
      if (audio.readyState < 2 || buffered <= 0 || buffered + 0.03 < refill) return
      waitingSince = null
    } else if (wantsPlay && buffered < 0.08 && remaining > 0.05) {
      waitingSince ??= Date.now()
      if (Date.now() - waitingSince >= 400) { hold(); return }
    } else waitingSince = null
    if (videoWaiting) {
      if (video.readyState < 3 && ahead(video, video.currentTime) < 0.25) { audio.pause(); return }
      videoWaiting = false
    }
    const drift = audio.currentTime - video.currentTime
    // Repeated currentTime writes cause a seek/buffer/seek loop on Android.
    // Correct small clock drift gently; reserve seeks for substantial offsets.
    if (Math.abs(drift) > 0.75 && !audio.seeking && buffered > 0 && Date.now() - lastCorrection >= 3000) {
      lastCorrection = Date.now(); audio.currentTime = video.currentTime
    }
    const correction = Math.abs(drift) > 0.08 ? (drift > 0 ? 0.025 : -0.025) : 0
    const rate = video.playbackRate * (1 - correction)
    if (Math.abs(audio.playbackRate - rate) > 0.001) audio.playbackRate = rate
    if (wantsPlay) {
      if (held) { held = false; play(video, true) }
      if (!video.paused && audio.paused && audio.readyState >= 2 && buffered > 0) play(audio, false)
    } else audio.pause()
  }
  const restart = () => {
    const request = ++serial
    ready = false; waitingSince = null; videoWaiting = false; hold(); stream?.destroy()
    stream = startLocalRemux(audio, { ...options, audioOnly: true, position: video.currentTime, resume: false,
      onMetadata: () => {}, onSeek: () => {},
      onReady: () => { if (!stopped && serial === request) { ready = true; audio.currentTime = video.currentTime; lastCorrection = Date.now(); options.onReady?.(); sync() } },
      onError: error => { if (serial === request) fail(error) }
    })
  }
  listen(video, 'play', () => { wantsPlay = true; sync() })
  listen(video, 'pause', () => { if (internalPause) internalPause = false; else { wantsPlay = false; held = false }; audio.pause() })
  listen(video, 'waiting', () => { videoWaiting = true; audio.pause() })
  listen(video, 'seeking', () => { ready = false; hold() })
  listen(video, 'seeked', restart)
  listen(video, 'ended', () => { wantsPlay = false; audio.pause() })
  for (const event of ['playing', 'canplay', 'volumechange', 'ratechange']) listen(video, event, sync)
  listen(audio, 'waiting', sync); listen(audio, 'canplay', sync)
  const timer = setInterval(sync, 200)
  function destroy () {
    if (stopped) return
    stopped = true; ++serial; clearInterval(timer); listeners.forEach(fn => fn()); stream?.destroy()
    audio.pause(); audio.removeAttribute('src'); audio.load(); route.gain.gain.value = 1
  }
  route.gain.gain.value = 0
  route.context.resume().catch(fail)
  try { restart() } catch (error) { fail(error) }
  return { destroy }
}
