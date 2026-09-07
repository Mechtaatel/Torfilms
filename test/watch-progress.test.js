import test from 'node:test'
import assert from 'node:assert/strict'
import { readProgress, writeProgress } from '../public/p2p/watch-progress.js'
test('progress cookie preserves episode, quality and time and rejects corrupt values', () => {
  const p = { hash: 'a'.repeat(40), quality: 'hd', index: 54, time: 600, season: 2 }
  const oldDocument = globalThis.document, oldLocation = globalThis.location
  try {
    globalThis.document = { cookie: '' }; globalThis.location = { protocol: 'https:' }
    writeProgress('tt6424454', p)
    assert.deepEqual(readProgress('tt6424454'), p)
    assert.match(document.cookie, /SameSite=Lax; Secure/)
    assert.match(document.cookie, /Max-Age=15552000/)
    assert.equal(readProgress('tt6424454', 'torfilms_tt6424454=%broken'), null)
    assert.equal(readProgress('tt6424454', `torfilms_tt6424454=${encodeURIComponent(JSON.stringify({ ...p, time: -1 }))}`), null)
    assert.equal(readProgress('tt1234567', document.cookie), null)
  } finally { globalThis.document = oldDocument; globalThis.location = oldLocation }
})
