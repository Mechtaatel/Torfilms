import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { catalog } from '../lib/catalog.js'
import { sourcesFor, seasonValue, seasonsOf, removeSeason, validateSeasonNames } from '../public/p2p/catalog-model.js'
import { peerTrackers } from '../public/p2p/peer-trackers.js'
test('named and decimal seasons survive saving with independent covers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'torfilms-named-seasons-'))
  try {
    const db = catalog(dir), names = ['Bonus', '1.1', '1.2 Бой камня']
    await db.save({ id: 'tt1234567', title: 'Fixture', isSeries: true, seasons: names.map((number, i) => ({ number, poster: `https://example.com/${i}.jpg` })), sources: [{ id: 'all', season: 'Bonus', label: 'All seasons', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`, episodes: names.map((season, index) => ({ index, title: `Episode ${index}`, season })) }] })
    const movie = (await catalog(dir).all())[0]
    for (const name of names) assert.equal(sourcesFor(movie, name).length, 1)
    assert.equal(movie.seasons.find(s => s.number === 'Bonus').poster, 'https://example.com/0.jpg')
    assert.equal(seasonValue('1'), 1); assert.equal(seasonValue('1.1'), '1.1')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('hybrid viewer uses public trackers in addition to local discovery; private torrents stay private', () => {
  const urls = peerTrackers('wss://localhost/tracker/hash')
  assert.ok(urls.includes('wss://tracker.webtorrent.dev'))
  assert.ok(urls.includes('wss://localhost/tracker/hash'))
  assert.deepEqual(peerTrackers('wss://localhost/tracker/hash', true), ['wss://localhost/tracker/hash'])
})
test('duplicate display names are rejected regardless of season identifiers, whitespace and case', () => {
  assert.throws(() => validateSeasonNames([{ number: 0, title: 'Bonus' }, { number: 'Bonus', title: ' bonus  ' }]), /уже используется/)
})
test('deleting a referenced season requires a destination and does not recreate it', () => {
  const movie = { isSeries: true, seasons: [{ number: 0, title: 'Bonus' }, { number: 1, title: 'Main' }], sources: [{ season: 0, episodes: [{ index: 0 }, { index: 1, season: 0, excluded: true }] }] }
  assert.throws(() => removeSeason(movie, 0, null), /Выберите сезон/)
  assert.equal(movie.seasons.length, 2)
  removeSeason(movie, 0, 1)
  assert.deepEqual(seasonsOf(movie).map(s => s.number), [1])
  assert.equal(movie.sources[0].season, 1)
  assert.ok(movie.sources[0].episodes.every(e => e.season === 1))
  assert.equal(movie.sources[0].episodes[1].excluded, true)
})
test('catalog rejects duplicate season titles after normalizing source references', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'torfilms-duplicate-seasons-'))
  try {
    await assert.rejects(catalog(dir).save({ id: 'tt1234567', title: 'Fixture', isSeries: true, seasons: [{ number: 0, title: 'Bonus' }], sources: [{ label: 'Fixture', season: 'Bonus', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}` }] }), /уже используется/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
