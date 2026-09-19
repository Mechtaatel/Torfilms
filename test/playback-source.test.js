import test from 'node:test'
import assert from 'node:assert/strict'
import { publicPlaybackSource } from '../public/p2p/playback-source.js'
test('public playback uses only approved hash, never tracker secrets', () => {
  const hash = '095f55c471003b83b4f6ca8e13c3354582d8bc0b'
  assert.equal(publicPlaybackSource({}), null)
  assert.equal(publicPlaybackSource({ publicPlayback: { infoHash: 'invalid' } }), null)
  const result = publicPlaybackSource({ id: 'q', publicPlayback: { infoHash: hash }, magnet: 'magnet:?tr=secret' })
  assert.equal(result.magnet, `magnet:?xt=urn:btih:${hash}`)
  assert.equal(result.id, 'q')
})
