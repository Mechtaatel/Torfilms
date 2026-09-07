import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { catalog } from '../lib/catalog.js'
import { videoFiles, sourcesFor, seasonsOf } from '../public/p2p/catalog-model.js'

test('episode renames and exclusions persist without modifying torrent file indices', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'torfilms-episodes-'))
  try {
    const source = { id: 'hd', label: 'HD', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`, episodes: [{ index: 0, excluded: true, title: 'Opening' }, { index: 4, title: 'Серия 1', excluded: false }] }
    await catalog(dir).save({ id: 'tt6424454', title: 'Fixture', sources: [source] })
    const saved = await catalog(dir).resolve('tt6424454', 'hd')
    assert.deepEqual(saved.episodes, source.episodes)
    const files = ['OP.mkv', 'cover.jpg', 'audio.mka', 'subs.srt', 'ep01.mkv'].map(name => ({ name }))
    assert.deepEqual(videoFiles(files, saved.episodes).map(e => [e.index, e.title]), [[4, 'Серия 1']])
    const movie = await catalog(dir).save({ id: 'tt1234568', title: 'Multiple seasons', isSeries: true, sources: [{ ...source, audioLabels: { 'file:2': 'Русская озвучка' }, episodes: [{ index: 0, title: 'Спецвыпуск', season: 0 }, { index: 4, title: 'Серия 1', season: 2 }] }] })
    assert.equal(sourcesFor(movie, 2).length, 1)
    assert.equal(sourcesFor(movie, 3).length, 0)
    assert.ok(seasonsOf(movie).some(s => s.number === 2))
    assert.equal((await catalog(dir).resolve('tt1234568', 'hd')).audioLabels['file:2'], 'Русская озвучка')
    await assert.rejects(catalog(dir).save({ id: 'tt1234567', title: 'Bad', sources: [{ ...source, episodes: [{ index: -1 }] }] }), /индекс/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
