import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { spawn } from 'node:child_process'

function ff (command, args, input) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), chunks = []
    let stderr = ''
    const timer = setTimeout(() => { process.kill(); reject(new Error('FFmpeg timeout')) }, 20000)
    process.stdout.on('data', b => chunks.push(b)); process.stderr.on('data', b => { stderr += b })
    process.stdin.on('error', () => {}); process.stdin.end(input)
    process.on('error', e => { clearTimeout(timer); reject(e) })
    process.on('close', code => { clearTimeout(timer); code ? reject(new Error(stderr)) : resolve(Buffer.concat(chunks)) })
  })
}
async function remux (files, options) {
  const url = new URL('../public/p2p/local-remux-worker.js', import.meta.url).href
  const worker = new Worker(`const {parentPort}=require('node:worker_threads'); globalThis.onmessage=null; globalThis.postMessage=(message,transfer)=>parentPort.postMessage(message,transfer); import(${JSON.stringify(url)}).then(()=>{ parentPort.on('message', data=>globalThis.onmessage({data})); parentPort.postMessage({type:'boot'}); });`, { eval: true })
  const chunks = [], audioChunks = [], reads = []; let metadata, config
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Remux timeout')), 15000)
      worker.on('error', e => { clearTimeout(timer); reject(e) })
      worker.on('message', m => {
        if (m.type === 'boot') { worker.postMessage({ type: 'start', fileIndex: 0, length: files[0].length, duration: 12, ...options }); return }
        if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.message)); return }
        let value
        if (m.type === 'read') { reads.push(m); value = new Uint8Array(files[m.fileIndex].subarray(m.start, m.end)); assert.ok(value.length <= 256 * 1024) }
        if (m.type === 'metadata') metadata = m
        if (m.type === 'configure') config = m
        if (m.type === 'append') chunks.push(Buffer.from(m.bytes))
        if (m.type === 'appendAudio') audioChunks.push(Buffer.from(m.bytes))
        worker.postMessage({ type: 'reply', id: m.id, value })
        if (m.type === 'end') { clearTimeout(timer); resolve() }
      })
    })
    return { bytes: Buffer.concat(chunks), audioBytes: Buffer.concat(audioChunks), metadata, config, reads }
  } finally { await worker.terminate() }
}
test('real browser worker remuxes MKV with B-frames, seeks, switches embedded and external audio without encoding', { timeout: 90000 }, async () => {
  const video = await ff('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=12', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '1:a', '-c:v', 'libx264', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '2', '-c:a', 'aac', '-c:a:2', 'flac', '-ar:a:2', '96000', '-sample_fmt:a:2', 's32', '-ac:a:2', '2', '-f', 'matroska', 'pipe:1'])
  const external = await ff('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-map', '0:a:1', '-c:a', 'copy', '-f', 'matroska', 'pipe:1'], video)
  const mp3 = await ff('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-map', '0:a:1', '-c:a', 'libmp3lame', '-f', 'matroska', 'pipe:1'], video)
  const mp3Result = await remux([video, mp3], { position: 5.3, audioFile: 1, audioLength: mp3.length })
  assert.match(mp3Result.config.mime, /avc1/)
  assert.equal(mp3Result.config.audioMime, 'audio/mpeg')
  const mp3Info = JSON.parse(await ff('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', 'pipe:0'], mp3Result.bytes))
  const mp3AudioInfo = JSON.parse(await ff('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', 'pipe:0'], mp3Result.audioBytes))
  assert.equal(mp3AudioInfo.streams[0].codec_name, 'mp3')
  assert.equal(mp3Info.streams.find(s => s.codec_type === 'video').codec_name, 'h264')
  for (const [dub, codec] of [[mp3, 'mp3'], [external, 'aac']]) {
    const result = await remux([video, dub], { audioOnly: true, position: 5.3, audioFile: 1, audioLength: dub.length })
    assert.match(result.config.mime, /^audio\//)
    const info = JSON.parse(await ff('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', 'pipe:0'], result.bytes))
    assert.equal(info.streams.length, 1, 'direct MKV companion must not output any video')
    assert.equal(info.streams[0].codec_name, codec, 'audio must not be transcoded')
  }
  for (const options of [{ position: 0, audioIndex: 1 }, { position: 5.3, audioIndex: 2 }, { position: 5.3, audioFile: 1, audioLength: external.length }, { position: 5.3, audioIndex: 3 }]) {
    const result = await remux([video, external], options)
    assert.equal(result.metadata.tracks.length, 3)
    assert.equal(result.config.duration, 12)
    assert.match(result.config.mime, options.audioIndex === 3 ? /avc1.*flac/i : /avc1.*mp4a/)
    const info = JSON.parse(await ff('ffprobe', ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', 'pipe:0'], result.bytes))
    assert.equal(info.streams.find(s => s.codec_type === 'video').codec_name, 'h264')
    const audio = info.streams.find(s => s.codec_type === 'audio')
    assert.equal(audio.codec_name, options.audioIndex === 3 ? 'flac' : 'aac')
    if (options.audioIndex === 3) { assert.equal(audio.sample_rate, '96000'); assert.equal(audio.bits_per_raw_sample, '24') }
    for (const stream of info.streams) {
      const packets = info.packets.filter(p => p.stream_index === stream.index)
      assert.ok(packets.length > 50)
      for (let i = 1; i < packets.length; i++) assert.ok(Number(packets[i].dts_time) > Number(packets[i - 1].dts_time), 'decode timestamps must increase')
    }
    const frames = JSON.parse(await ff('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', 'pipe:0'], result.bytes)).frames
    const times = frames.map(f => Number(f.best_effort_timestamp_time) + result.config.timestampOffset).filter(t => t >= options.position)
    assert.ok(times.length > 100)
    for (let i = 1; i < times.length; i++) assert.ok(Math.abs(times[i] - times[i - 1] - 0.04) < 0.001, '25 fps after seek')
    const pcm = await ff('ffmpeg', ['-v', 'error', '-copyts', '-i', 'pipe:0', '-ss', String(options.position - result.config.timestampOffset + 0.2), '-t', '0.4', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], result.bytes)
    let crossings = 0
    for (let i = 2; i < pcm.length; i += 2) if (pcm.readInt16LE(i - 2) <= 0 && pcm.readInt16LE(i) > 0) crossings++
    const frequency = crossings / (pcm.length / 2 / 48000)
    assert.ok(Math.abs(frequency - ([1, 3].includes(options.audioIndex) ? 440 : 880)) < 15, `wrong dub ${frequency}`)
    if (options.audioFile === 1) assert.ok(result.reads.some(r => r.fileIndex === 1))
  }
})
