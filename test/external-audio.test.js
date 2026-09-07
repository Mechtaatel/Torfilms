import test from 'node:test'
import assert from 'node:assert/strict'
import { externalAudioFiles } from '../lib/external-audio.js'

test('external dubs match the episode across directories, never a different episode or season', () => {
  const files = [
    '[anti-raws]Fate Apocrypha ep.01[BDRemux].mkv',
    'RUS Sound/[AniDub]/[anti-raws]Fate Apocrypha ep.01[BDRemux].AniDub.mka',
    'RUS Sound/Other/[anti-raws]Fate Apocrypha ep.01.Other.flac',
    'RUS Sound/[AniDub]/[anti-raws]Fate Apocrypha ep.02[BDRemux].AniDub.mka',
    'Another Show ep.01.mka',
    '[anti-raws]Fate Apocrypha S02E01.mka'
  ].map(path => ({ path }))
  assert.deepEqual(externalAudioFiles(files, 0).map(t => t.fileIndex), [1, 2])
  assert.deepEqual(externalAudioFiles(files, 1), [])
})
