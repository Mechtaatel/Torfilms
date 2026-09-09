import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeStallCheck } from '../public/p2p/native-stall.js'
test('buffered freeze gets one same-position recovery, never a seek loop', () => {
  let now = 0, seeks = 0, errors = 0
  const video = { get currentTime () { return 130.901333 }, set currentTime (t) { assert.equal(t, 130.901333); seeks++ }, buffered: { length: 1, start: () => 75.52, end: () => 157.134 } }
  const check = nativeStallCheck(video, () => errors++, () => now)
  now = 8001; check(); assert.equal(seeks, 1)
  for (let i = 0; i < 40; i++) { now += 1000; check() }
  assert.equal(seeks, 1); assert.equal(errors, 1)
})
test('manual pause, seek and missing current buffer never trigger recovery', () => {
  let now = 0, seeks = 0
  const video = { get currentTime () { return 20 }, set currentTime (_) { seeks++ }, paused: true, buffered: { length: 1, start: () => 30, end: () => 60 } }
  const check = nativeStallCheck(video, assert.fail, () => now)
  now = 9000; check(); video.paused = false; now += 9000; check()
  video.buffered.start = () => 0; video.seeking = true; now += 9000; check()
  assert.equal(seeks, 0)
})
