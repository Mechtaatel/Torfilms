import test from 'node:test'
import assert from 'node:assert/strict'
import { repairFlacMoov, flacHeaderWriter } from '../public/p2p/flac-mp4-header.js'
function box (name, size) { const b = Buffer.alloc(size); b.writeUInt32BE(size); b.write(name, 4); return b }
function fixture (rate) {
  const dfla = box('dfLa', 50); dfla[12] = 128; dfla.writeUIntBE(34, 13, 3); dfla.writeUInt32BE(rate * 4096 + 512 + 23 * 16, 26)
  const entry = box('fLaC', 86); entry.writeUInt16BE(16, 26); dfla.copy(entry, 36)
  const stsd = box('stsd', 102); stsd.writeUInt32BE(1, 12); entry.copy(stsd, 16)
  const moov = box('moov', 110); stsd.copy(moov, 8); return moov
}
test('FLAC sample entry uses correct channels, 24-bit depth and divided high sample rate without touching STREAMINFO', () => {
  for (const rate of [48000, 96000, 192000]) {
    const bytes = fixture(rate), info = Buffer.from(bytes.subarray(60))
    repairFlacMoov(bytes)
    assert.equal(bytes.readUInt16BE(48), 2)
    assert.equal(bytes.readUInt16BE(50), 24)
    assert.equal(bytes.readUInt32BE(56), 48000 * 65536)
    assert.deepEqual(bytes.subarray(60), info)
  }
})
test('header repair handles split boxes and passes media bytes unchanged', async () => {
  const chunks = [], writer = flacHeaderWriter(async b => chunks.push(Buffer.from(b))), ftyp = box('ftyp', 8), moov = fixture(96000), mdat = box('mdat', 20)
  const original = Buffer.concat([ftyp, moov, mdat])
  for (let i = 0; i < original.length; i++) await writer(original.subarray(i, i + 1))
  const output = Buffer.concat(chunks)
  assert.equal(output.readUInt32BE(64), 48000 * 65536)
  assert.deepEqual(output.subarray(-20), mdat)
  assert.throws(() => repairFlacMoov(Buffer.from([0, 0, 0, 1, 109, 111, 111, 118])), /Повреждённый/)
})
