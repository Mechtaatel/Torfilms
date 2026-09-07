import test from 'node:test'
import assert from 'node:assert/strict'
import { readRange } from '../lib/range-reader.js'

function fixture () {
  const bytes = Buffer.from('abcdefghijklmnop')
  const selected = new Set()
  const requests = []
  const torrent = {
    pieceLength: 4, destroyed: false,
    bitfield: { get: () => true },
    _select (from, to, priority, notify, stream) {
      assert.equal(from, to)
      assert.equal(stream, true)
      selected.add(from)
      requests.push(from)
      assert.equal(selected.size, 1)
    },
    _deselect (from) { selected.delete(from) },
    store: { get (index, opts, cb) { cb(null, bytes.subarray(index * 4 + opts.offset, index * 4 + opts.offset + opts.length)) } }
  }
  return { torrent, selected, requests, file: { offset: 3 }, signal: new AbortController() }
}

test('unaligned multi-file range returns exact bytes with one selected piece at a time', async () => {
  const f = fixture()
  const chunks = []
  for await (const chunk of readRange(f.file, f.torrent, 1, 8, f.signal.signal)) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString(), 'efghijkl')
  assert.deepEqual(f.requests, [1, 2])
  assert.equal(f.selected.size, 0)
})

test('closing a large HTTP range does not select the rest of the movie', async () => {
  const f = fixture()
  for await (const chunk of readRange(f.file, f.torrent, 0, 80e9, f.signal.signal)) {
    assert.equal(chunk.toString(), 'd')
    break
  }
  assert.deepEqual(f.requests, [0])
  assert.equal(f.selected.size, 0)
})

test('seek aborts a waiting piece and releases its selection', async () => {
  const f = fixture()
  f.torrent.bitfield.get = () => false
  const iterator = readRange(f.file, f.torrent, 0, 100, f.signal.signal)
  const pending = iterator.next()
  f.signal.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(f.selected.size, 0)
})

test('cache eviction between bitfield check and get retries without truncating HTTP response', async () => {
  const f = fixture()
  const original = f.torrent.store.get
  let reads = 0
  f.torrent.store.get = (...args) => {
    if (reads++ === 0) args[2](Object.assign(new Error('evicted'), { notFound: true }))
    else original(...args)
  }
  const chunks = []
  for await (const chunk of readRange(f.file, f.torrent, 0, 0, f.signal.signal)) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString(), 'd')
  assert.equal(reads, 2)
})
