import test from 'node:test'
import assert from 'node:assert/strict'
import { audioIdentity, preferredAudio, readProcessing, saveProcessing, saveAudioPreference } from '../public/p2p/playback-preferences.js'
test('processing mode survives cookie reload and rejects invalid values', () => {
  for (const mode of ['direct', 'browser', 'bridge']) assert.equal(readProcessing(`torfilms_processing=${encodeURIComponent(JSON.stringify(mode))}`), mode)
  assert.equal(readProcessing('torfilms_processing=%broken'), 'browser')
  assert.equal(readProcessing('torfilms_processing="invalid"'), 'browser')
})
test('dub follows episode directory, not the old file index; missing or ambiguous dub is not substituted', () => {
  const old = { external: true, fileIndex: 4, title: 'Show/RUS/Ranmaru/ep.01.mka' }
  const cookie = 'torfilms_audio_tt2359704=' + encodeURIComponent(JSON.stringify(audioIdentity(old)))
  const tracks = [{ external: true, fileIndex: 4, title: 'Show/RUS/Other/ep.02.mka' }, { external: true, fileIndex: 5, title: 'Show/RUS/Ranmaru/ep.02.mka' }]
  assert.equal(preferredAudio('tt2359704', tracks, {}, cookie), tracks[1])
  assert.equal(preferredAudio('tt2359704', tracks.slice(0, 1), {}, cookie), null)
  assert.equal(preferredAudio('tt2359704', [tracks[1], tracks[1]], {}, cookie), null)
  assert.equal(preferredAudio('tt6424454', tracks, {}, cookie), null)
})
test('settings are written immediately as persistent secure cookies', () => {
  const document = globalThis.document, location = globalThis.location
  try {
    globalThis.document = { cookie: '' }; globalThis.location = { protocol: 'https:' }
    saveProcessing('direct')
    assert.equal(readProcessing(globalThis.document.cookie), 'direct')
    assert.match(globalThis.document.cookie, /Max-Age=31536000; SameSite=Lax; Secure/)
    saveAudioPreference('tt2359704', { title: 'Ranmaru', external: true, fileIndex: 4 })
    assert.match(globalThis.document.cookie, /^torfilms_audio_tt2359704=/)
  } finally { if (document === undefined) delete globalThis.document; else globalThis.document = document; if (location === undefined) delete globalThis.location; else globalThis.location = location }
})
