import test from 'node:test'
import assert from 'node:assert/strict'
import { RetainedRamPool } from '../public/p2p/retained-ram.js'
import { RamStore } from '../public/p2p/ram-store.js'
import { readRamSetting } from '../public/p2p/viewer-settings.js'
const put = (s, i) => new Promise(r => s.put(i, new Uint8Array(4), r))
test('retained RAM survives client close, isolates hashes and evicts within one total budget', async () => {
  const pool = new RetainedRamPool(8)
  const torrent = hash => ({ infoHash: hash, wires: [], _markUnverified () {} })
  const a = new RamStore(4, { limit: 8, pool, torrent: torrent('a') })
  await put(a, 0); await put(a, 1); a.close()
  assert.equal(pool.used, 8)
  const reopened = new RamStore(4, { limit: 8, pool, torrent: torrent('a') })
  assert.equal(reopened.entries.size, 2)
  const b = new RamStore(4, { limit: 8, pool, torrent: torrent('b') })
  assert.equal(b.entries.size, 0); await put(b, 0)
  assert.equal(pool.used, 8); assert.equal(reopened.entries.has(0), false); assert.equal(reopened.entries.has(1), true)
  pool.configure(4); assert.equal(pool.used, 4)
})
test('RAM preference accepts only the enforced range', () => {
  assert.equal(readRamSetting('torfilms_ram=2048'), 2048)
  assert.equal(readRamSetting('torfilms_ram=1000'), 1000)
  for (const v of ['499', '2049', 'garbage', '-1']) assert.equal(readRamSetting(`torfilms_ram=${v}`), 500)
})
