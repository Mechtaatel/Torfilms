import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlayerStats } from '../public/p2p/player-stats.js'
test('statistics measure MP4 bytes independently of P2P and use the current buffered range', () => {
  const render = createPlayerStats(), stream = { receivedBytes: 0 }, torrent = { numPeers: 0 }
  let frames = 0
  const data = { video: { currentTime: 101, readyState: 4, paused: false, buffered: { length: 2, start: i => i ? 100 : 0, end: i => i ? 110 : 10 }, getVideoPlaybackQuality: () => ({ totalVideoFrames: frames, droppedVideoFrames: 0 }) }, cache: { used: 0, limit: 524288000 }, stream, torrent, audioActive: true, httpBytes: 0 }
  render({ ...data, now: 1000 }); stream.receivedBytes = 2 * 1024 ** 2; frames = 24
  const text = render({ ...data, now: 2000 })
  assert.match(text, /Приём MP4: 2.0 МиБ\/с/)
  assert.match(text, /Буфер впереди: 9.0 с/)
  assert.match(text, /кадров\/с: 24.0/)
  assert.match(text, /WebRTC-пиры: 0/)
  assert.match(render({ ...data, stream: null, now: 3000 }), /не предоставляет счётчик байтов/)
  assert.doesNotMatch(render({ ...data, stream: { receivedBytes: 0 }, now: 4000 }), /NaN|Infinity/)
})
