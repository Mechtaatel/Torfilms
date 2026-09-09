import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startDirectPlayback } from '../public/p2p/direct-player.js'

test('direct playback uses original torrent URL, resumes natively and cleans listeners without fallback', async () => {
  const video = new EventTarget()
  Object.assign(video, { duration: 100, pause () {}, load () {}, removeAttribute () {}, play: async () => {} })
  let ready = 0, errors = 0, streams = 0
  const player = startDirectPlayback(video, { streamTo (target) { streams++; target.src = '/webtorrent/hash/episode.mkv' } }, { position: 37, onReady () { ready++ }, onError () { errors++ } })
  assert.match(video.src, /episode\.mkv$/)
  video.dispatchEvent(new Event('loadedmetadata'))
  assert.equal(video.currentTime, 37)
  assert.equal(ready, 1)
  video.dispatchEvent(new Event('error'))
  assert.equal(errors, 1)
  assert.equal(streams, 1)
  player.destroy()
  video.dispatchEvent(new Event('error'))
  assert.equal(errors, 1)
})

test('embedded player exposes the direct MKV mode', () => {
  for (const file of ['compact-player.js']) {
    const text = readFileSync(new URL(`../public/p2p/${file}`, import.meta.url), 'utf8')
    assert.match(text, /value="direct">Прямое воспроизведение MKV/)
  }
})

test('native audio selection changes tracks without restarting the video', () => {
  const video = new EventTarget()
  Object.assign(video, { audioTracks: [{ label: 'Japanese', enabled: true }, { label: 'Russian', enabled: false }], duration: 90, pause () {}, load () {}, removeAttribute () {}, play: async () => {} })
  let streams = 0, tracks
  const player = startDirectPlayback(video, { streamTo () { streams++ } }, { onReady () {}, onError: assert.fail, onTracks: value => { tracks = value } })
  video.dispatchEvent(new Event('loadedmetadata'))
  assert.equal(tracks[1].title, 'Russian')
  player.selectAudio(tracks[1])
  assert.equal(video.audioTracks[0].enabled, false)
  assert.equal(video.audioTracks[1].enabled, true)
  assert.equal(streams, 1)
  player.destroy()
})
