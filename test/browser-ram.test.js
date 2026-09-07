import test from 'node:test'
import assert from 'node:assert/strict'
import { RamStore, installReader } from '../public/p2p/ram-store.js'
const put = (store, i, bytes) => new Promise((resolve, reject) => store.put(i, bytes, e => e ? reject(e) : resolve()))
test('browser cache is bounded and tells peers about eviction', async () => {
  const invalid = [], notified = []
  const store = new RamStore(4, { limit: 8, torrent: { _markUnverified: i => invalid.push(i), wires: [{ lt_donthave: { donthave: i => notified.push(i) } }] } })
  for (let i = 0; i < 3; i++) await put(store, i, new Uint8Array(4))
  assert.equal(store.used, 8)
  assert.deepEqual(invalid, [0]); assert.deepEqual(notified, [0])
  await new Promise(resolve => store.get(0, error => { assert.equal(error.notFound, true); resolve() }))
  store.destroy()
  assert.equal(store.used, 0)
})
test('browser reader selects a bounded range and cancellation releases it', async () => {
  const selected = [], removed = []
  const torrent = { pieceLength: 4, _select: (...a) => selected.push(a), _deselect: (...a) => removed.push(a), store: { get: (i, opts, cb) => cb({ notFound: true }) } }
  const file = { offset: 0, length: 10000 }
  installReader(file, torrent, 64)
  const reader = file[Symbol.asyncIterator]()
  const pending = reader.next()
  await reader.return()
  await pending
  assert.deepEqual(selected[0].slice(0, 2), [0, 3])
  assert.equal(removed.length, 1)
})
