import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mediaMetadata } from '../lib/media-metadata.js'
import { catalog } from '../lib/catalog.js'
import http from 'node:http'
import { once } from 'node:events'

test('audio metadata survives reopening and ships with catalog even for magnet-only sources', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'torfilms-metadata-'))
  const hash = 'b'.repeat(40)
  const data = { duration: 120, tracks: [{ index: 0, codec: 'aac' }], externalTracks: [{ fileIndex: 4, title: 'AniDub', external: true }] }
  const cacheDir = path.join(dir, 'media-metadata')
  let server
  try {
    await mediaMetadata(cacheDir).put(hash, 54, data)
    assert.deepEqual(await mediaMetadata(cacheDir).get(hash, 54), data)
    assert.deepEqual(await mediaMetadata(cacheDir).list('c'.repeat(40)), {})
    const library = catalog(dir)
    await library.save({ id: 'tt6424454', title: 'Fixture', sources: [{ id: 'hd', label: 'HD', magnet: `magnet:?xt=urn:btih:${hash}` }] })
    server = http.createServer((req, res) => library.handle(req, res, new URL(req.url, 'http://localhost')))
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const movies = await fetch(`http://127.0.0.1:${server.address().port}/catalog/movies`).then(r => r.json())
    assert.deepEqual(movies[0].sources[0].audioMetadata[54], data)
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)) }
    await rm(dir, { recursive: true, force: true })
  }
})
