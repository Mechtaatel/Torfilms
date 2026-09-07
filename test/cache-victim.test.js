import test from 'node:test'
import assert from 'node:assert/strict'
import { cacheVictim } from '../lib/cache-victim.js'

const entries = (...indices) => new Map(indices.map(i => [i, Buffer.alloc(1)]))
test('cache retains immediate unread data even when it is oldest', () => {
  assert.equal(cacheVictim(entries(100, 101, 150, 90, 160), 160, { current: 100, end: 160 }), 90)
})
test('when window is full, evict farthest data, not next playback piece', () => {
  assert.equal(cacheVictim(entries(100, 101, 150, 160), 160, { current: 100, end: 160 }), 150)
})
test('seek makes the old window disposable', () => {
  assert.equal(cacheVictim(entries(100, 101, 500, 501), 501, { current: 500, end: 600 }), 100)
})
test('without playback preserve LRU ordering and the incoming piece', () => {
  assert.equal(cacheVictim(entries(3, 4, 5), 3), 4)
})
