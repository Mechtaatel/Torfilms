import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createPieceFallback } from '../public/p2p/piece-fallback.js'
import { RamStore, installReader } from '../public/p2p/ram-store.js'

test('HTTPS fallback verifies hashes before caching and announces RAM pieces to P2P peers', async () => {
  const original = globalThis.fetch, bytes = new Uint8Array([1, 2, 3, 4]), haves = []
  const torrent = { infoHash: 'a'.repeat(40), pieces: [null], pieceLength: 4, lastPieceLength: 4, _hashes: [createHash('sha1').update(bytes).digest('hex')], store: new RamStore(4, { limit: 8 }), _markVerified: i => { torrent.verified = i }, wires: [{ have: i => haves.push(i) }] }
  try {
    globalThis.fetch = async () => new Response(bytes, { headers: { 'Content-Length': '4' } })
    let transferred = 0
    await createPieceFallback(torrent, 8, n => { transferred += n })(0, new AbortController().signal)
    assert.equal(transferred, 4); assert.equal(torrent.verified, 0); assert.deepEqual(haves, [0]); assert.equal(torrent.store.used, 4)
    torrent._hashes[0] = '0'.repeat(40)
    await assert.rejects(createPieceFallback(torrent, 8)(0, new AbortController().signal), /SHA-1/)
    assert.deepEqual(haves, [0])
  } finally { globalThis.fetch = original }
})

test('reader can play from verified fallback RAM when no WebRTC peer connects', async () => {
  const torrent = { numPeers: 0, pieceLength: 4, store: new RamStore(4, { limit: 8 }), _select () {}, _deselect () {} }
  const file = { name: 'episode.mp4', offset: 0, length: 4 }
  installReader(file, torrent, 8, null, async index => new Promise(resolve => torrent.store.put(index, new Uint8Array([4, 3, 2, 1]), resolve)))
  const reader = file[Symbol.asyncIterator]()
  assert.deepEqual((await reader.next()).value, new Uint8Array([4, 3, 2, 1]))
  await reader.return()
})
test('RAM reader crosses a piece boundary without repeating the previous piece', { timeout: 2000 }, async () => {
  const torrent = { numPeers: 0, pieceLength: 4, store: new RamStore(4, { limit: 16 }), _select () {}, _deselect () {} }
  const file = { offset: 0, length: 12 }, calls = []
  installReader(file, torrent, 16, null, async i => { calls.push(i); await new Promise(resolve => torrent.store.put(i, new Uint8Array([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 3]), resolve)) })
  const out = []
  for await (const chunk of file[Symbol.asyncIterator]({ start: 3, end: 8 })) out.push(...chunk)
  assert.deepEqual(out, [3, 4, 5, 6, 7, 8]); assert.deepEqual(calls, [0, 1, 2])
})
test('small demux reads request lookahead within the file instead of stopping at the requested byte', async () => {
  const selections = [], demands = []
  const torrent = { numPeers: 0, pieceLength: 4, store: new RamStore(4, { limit: 64 }), _select: (...args) => selections.push(args), _deselect () {} }
  await new Promise(resolve => torrent.store.put(1, new Uint8Array(4), resolve))
  const file = { offset: 0, length: 40 }
  installReader(file, torrent, 64, (first, last) => demands.push([first, last]), null)
  for await (const chunk of file[Symbol.asyncIterator]({ start: 4, end: 4 })) assert.equal(chunk.length, 1)
  assert.deepEqual(selections[0].slice(0, 2), [1, 4]); assert.deepEqual(demands, [[1, 4]])
})
test('successful HTTPS fallback never waits for a background-throttled polling timer', async () => {
  const originalTimer = globalThis.setTimeout
  const torrent = { numPeers: 0, pieceLength: 4, store: new RamStore(4, { limit: 8 }), _select () {}, _deselect () {} }
  const file = { offset: 0, length: 4 }
  installReader(file, torrent, 8, null, async i => new Promise(resolve => torrent.store.put(i, new Uint8Array([1, 2, 3, 4]), resolve)))
  try {
    globalThis.setTimeout = (fn, ms, ...args) => { if (ms === 50) throw new Error('Polling a piece that is already cached'); return originalTimer(fn, ms, ...args) }
    const chunks = []
    for await (const bytes of file) chunks.push(...bytes)
    assert.deepEqual(chunks, [1, 2, 3, 4])
  } finally { globalThis.setTimeout = originalTimer }
})
test('many tiny demux iterators share demand throttling instead of flooding HTTP connections', async () => {
  const torrent = { numPeers: 0, pieceLength: 4, store: new RamStore(4, { limit: 64 }), _select () {}, _deselect () {} }
  await new Promise(resolve => torrent.store.put(0, new Uint8Array(4), resolve))
  const file = { offset: 0, length: 4 }, demands = []
  installReader(file, torrent, 64, (...args) => demands.push(args), null)
  for (let i = 0; i < 1000; i++) for await (const bytes of file[Symbol.asyncIterator]({ start: 0, end: 0 })) assert.equal(bytes.length, 1)
  assert.equal(demands.length, 1)
})
