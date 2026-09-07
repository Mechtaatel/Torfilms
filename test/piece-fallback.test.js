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
