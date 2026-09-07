import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { bridgeMedia } from '../lib/bridge-media.js'
import { playbackArgs } from '../lib/playback-args.js'

test('bridge lists tracks, copies AAC mono and converts selected AC3 to AAC stereo in RAM', { timeout: 20000 }, async () => {
  const source = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=25:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a:0', 'aac', '-c:a:1', 'ac3', '-metadata:s:a:0', 'title=First', '-metadata:s:a:1', 'title=Second', '-f', 'matroska', 'pipe:1'])
  assert.equal(source.status, 0, source.stderr.toString())
  const external = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-c:a', 'copy', '-f', 'matroska', 'pipe:1'], { input: source.stdout })
  assert.equal(external.status, 0)
  const subtitles = spawnSync('ffmpeg', ['-v', 'error', '-f', 'srt', '-i', 'pipe:0', '-f', 'ass', 'pipe:1'], { input: '1\n00:00:00,200 --> 00:00:01,000\nHello subtitles\n' })
  assert.equal(subtitles.status, 0)
  const bytes = Buffer.concat([source.stdout, external.stdout, subtitles.stdout])
  const hash = 'a'.repeat(40)
  const torrent = { ready: true, infoHash: hash, pieceLength: 16384, bitfield: { get: () => true }, _select () {}, _deselect () {}, store: { get (index, opts, cb) { const start = index * 16384 + opts.offset; cb(null, bytes.subarray(start, start + opts.length)) } }, files: [{ offset: 0, length: bytes.length }] }
  torrent.files = [{ name: 'Show ep.01.mkv', offset: 0, length: source.stdout.length }, { path: 'RUS Sound/AniDub/Show ep.01.AniDub.mka', offset: source.stdout.length, length: external.stdout.length }]
  torrent.files.push({ name: 'Show ep.01.AniPlay.ass', offset: source.stdout.length + external.stdout.length, length: subtitles.stdout.length })
  let base
  const media = bridgeMedia(() => torrent, () => base)
  const server = http.createServer(async (req, res) => { if (!await media.handle(req, res, new URL(req.url, base))) { res.writeHead(404); res.end() } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
  try {
    const tracks = await (await fetch(`${base}/bridge/tracks/${hash}/0`)).json()
    assert.deepEqual(tracks.tracks.map(t => t.codec), ['aac', 'ac3'])
    assert.equal(tracks.externalTracks[0].fileIndex, 1)
    assert.equal(tracks.subtitles[0].fileIndex, 2)
    const subs = await fetch(`${base}/bridge/subtitles/${hash}/0?file=2`)
    assert.equal(subs.status, 200)
    const vtt = await subs.text()
    assert.match(vtt, /^WEBVTT/); assert.match(vtt, /Hello subtitles/)
    assert.equal((await fetch(`${base}/bridge/subtitles/${hash}/0?file=1`)).status, 400)
    await fetch(`${base}/bridge/tracks/${hash}/1`).then(r => r.json())
    const externalResponse = await fetch(`${base}/bridge/audio/${hash}/0?track=0&copy=1&audioFile=1`)
    assert.equal(externalResponse.status, 200)
    const externalOutput = Buffer.from(await externalResponse.arrayBuffer())
    const externalInfo = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', 'pipe:0'], { input: externalOutput })
    assert.equal(externalInfo.status, 0, externalInfo.stderr.toString())
    assert.deepEqual(JSON.parse(externalInfo.stdout).streams.map(s => s.codec_name), ['h264', 'aac'])
    assert.equal((await fetch(`${base}/bridge/audio/${hash}/0?track=0&audioFile=99`)).status, 400)
    for (const [track, copy, channels] of [[1, 1, 1], [2, 0, 2]]) {
      const response = await fetch(`${base}/bridge/audio/${hash}/0?track=${track}&copy=${copy}`)
      assert.equal(response.status, 200)
      const output = Buffer.from(await response.arrayBuffer())
      const info = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', 'pipe:0'], { input: output })
      assert.equal(info.status, 0, info.stderr.toString())
      const audio = JSON.parse(info.stdout).streams.find(s => s.codec_type === 'audio')
      assert.equal(audio.codec_name, 'aac'); assert.equal(audio.channels, channels)
    }
    const args = playbackArgs({ inputUrl: 'fixture', copyAudio: true })
    assert.equal(args[args.indexOf('-c:a') + 1], 'copy')
    assert.equal(args[args.indexOf('-c:v') + 1], 'copy')
    assert.equal((await fetch(`${base}/bridge/audio/${hash}/0?track=99`)).status, 400)
  } finally { media.close(); server.closeAllConnections(); await new Promise(r => server.close(r)) }
})
