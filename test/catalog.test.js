import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { catalog } from '../lib/catalog.js'
const magnet = 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789'
test('catalog persists IMDb cards and independent quality sources, rejects stale edits and unsafe images', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'torfilms-catalog-test-'))
  try {
    const lib = catalog(directory)
    assert.deepEqual(await lib.all(), [])
    const movie = await lib.save({ id: 'tt1727587', title: 'Fixture', sources: [{ label: '720p', magnet }, { label: '1080p', magnet }] })
    assert.equal(movie.revision, 1)
    assert.notEqual(movie.sources[0].id, movie.sources[1].id)
    assert.deepEqual(await catalog(directory).all(), [movie])
    assert.equal((await lib.resolve(movie.id, movie.sources[1].id)).label, '1080p')
    await assert.rejects(lib.save({ ...movie, revision: 0 }), /уже изменена/)
    await assert.rejects(lib.save({ ...movie, id: '../secret' }), /IMDb/)
    await assert.rejects(lib.save({ ...movie, poster: 'javascript:alert(1)' }), /Обложка/)
    const saved = await lib.save({ ...movie, title: 'Edited' })
    assert.equal(saved.revision, 2)
    await assert.rejects(lib.resolve(movie.id, 'missing'), /не найдена/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
