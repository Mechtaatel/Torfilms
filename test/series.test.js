import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { catalog } from '../lib/catalog.js'
import { seasonsOf, sourcesFor, tagsOf, videoFiles } from '../public/p2p/catalog-model.js'

test('legacy series get season 1 without rewriting records; video list excludes images and sorts episodes naturally', () => {
  const movie = { kind: 'Сериал', genre: 'Космос, драма', sources: [{ id: 'a', fileIndex: 0 }] }
  assert.deepEqual(seasonsOf(movie).map(s => s.number), [1])
  assert.equal(movie.sources[0].season, undefined)
  assert.equal(sourcesFor(movie, 1)[0].id, 'a')
  assert.deepEqual(tagsOf(movie), ['космос', 'драма'])
  const files = ['cover.jpg', 'episode10.mp4', 'episode2.mp4', 'episode1.mkv', 'readme.txt'].map(name => ({ name }))
  assert.deepEqual(videoFiles(files).map(f => f.index), [3, 2, 1])
})

test('series save linked season covers, separate torrents, KP id, assigned age and completion date', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'torfilms-series-test-'))
  const magnet = 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789'
  try {
    const db = catalog(dir)
    const movie = await db.save({ id: 'tt0303461', title: 'Fixture', kind: 'Сериал', kinopoiskId: '12345', ageRating: '16+', completed: true, endDate: '2003-01-01', tags: ['Космос', 'драма', 'космос'], seasons: [{ number: 1, poster: 'https://example.com/one.jpg' }, { number: 2, title: 'Второй сезон', poster: 'https://example.com/two.jpg' }], sources: [{ season: 1, label: 'HD', magnet }, { season: 2, label: 'HD', magnet }] })
    assert.equal(movie.seasons.length, 2)
    assert.equal(sourcesFor(movie, 2).length, 1)
    assert.equal(movie.kinopoiskId, '12345')
    assert.equal(movie.endDate, '2003-01-01')
    assert.deepEqual(movie.tags, ['космос', 'драма'])
    assert.deepEqual(await catalog(dir).all(), [movie])
    for (const update of [{ kinopoiskId: 'abc' }, { ageRating: '99+' }, { endDate: '2023-02-31' }, { completed: false }, { seasons: [{ number: 1 }, { number: 1 }] }, { sources: [{ label: 'bad season', season: -1, magnet }] }]) await assert.rejects(db.save({ ...movie, ...update }))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
