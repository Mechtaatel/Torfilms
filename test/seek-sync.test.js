import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { playbackArgs } from '../lib/playback-args.js'
import { seekPlan } from '../lib/seek-plan.js'

function run (exe, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    let errors = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Media test timed out')) }, 20000)
    child.stdout.on('data', data => chunks.push(data))
    child.stderr.on('data', data => { errors += data })
    child.stdin.on('error', () => {})
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code) reject(new Error(errors))
      else resolve(Buffer.concat(chunks))
    })
    child.stdin.end(input)
  })
}

test('non-keyframe seek starts with the requested picture and synchronized timestamps (RAM only)', { timeout: 60000 }, async () => {
  // Red until 7s, blue after 7s. Keyframes every 6s and B-frames in between.
  const source = await run('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x90:r=25:d=7',
    '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=25:d=5',
    '-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*if(lt(t\\,7)\\,440\\,880)*t):s=48000:d=12',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-g', '150', '-keyint_min', '150',
    '-sc_threshold', '0', '-bf', '2', '-c:a', 'ac3', '-f', 'matroska', 'pipe:1'
  ])
  const externalAudio = await run('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-c:a', 'copy', '-f', 'matroska', 'pipe:1'], source)
  const server = http.createServer((req, res) => {
    const bytes = req.url === '/audio' ? externalAudio : source
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '')
    const start = match ? Number(match[1]) : 0
    const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1
    res.writeHead(match ? 206 : 200, {
      'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {})
    })
    res.end(bytes.subarray(start, end + 1))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const inputUrl = `http://127.0.0.1:${server.address().port}/`
    const legacy = await run('ffmpeg', [
      '-v', 'error', '-fflags', '+genpts', '-copyts', '-start_at_zero', '-ss', '8.75', '-i', inputUrl,
      '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-bsf:v', 'setts=ts=PTS-STARTPTS',
      '-c:a', 'aac', '-af', 'aresample=async=1000:min_hard_comp=0.100',
      '-avoid_negative_ts', 'make_zero', '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1'
    ])
    const oldFrame = await run('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], legacy)
    assert.ok(oldFrame[0] > 200 && oldFrame[2] < 30, 'fixture must reproduce the old GOP misalignment')
    for (const [seek, external] of [[7.3, false], [8.75, false], [8.75, true]]) {
      const plan = await seekPlan('ffprobe', inputUrl, seek)
      assert.ok(plan.keyframe <= seek)
      assert.ok(!playbackArgs({ inputUrl, seek }).includes('libx264'))
      const result = await run('ffmpeg', playbackArgs({ inputUrl, seek, ...(external ? { audioUrl: `${inputUrl}audio`, audioSeek: Math.max(0, plan.origin), audioMap: '1:a:0' } : {}) }))
      const info = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_packets', '-show_streams', '-of', 'json', 'pipe:0'], result))
      const video = info.streams.find(s => s.codec_type === 'video')
      const audio = info.streams.find(s => s.codec_type === 'audio')
      assert.ok(Math.abs(Number(video.start_time) - Number(audio.start_time)) < 0.1)
      for (const stream of [video, audio]) {
        const packets = info.packets.filter(p => p.stream_index === stream.index)
        for (let i = 1; i < packets.length; i++) assert.ok(Number(packets[i].dts) > Number(packets[i - 1].dts))
      }
      const frames = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', 'pipe:0'], result)).frames
      const times = frames.map(f => Number(f.best_effort_timestamp_time)).filter(t => t >= plan.localTime)
      assert.ok(times.length > 50, 'must decode multiple seconds after the seek')
      for (let i = 1; i < times.length; i++) {
        assert.ok(Math.abs(times[i] - times[i - 1] - 1 / 25) < 0.001, 'decoded frame cadence must remain 25 fps')
      }
      const frame = await run('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-ss', String(plan.localTime), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], result)
      // The requested time is blue. Returning the preceding GOP gives red,
      // even if both streams' timestamps were independently forced to zero.
      assert.ok(frame[2] > 200 && frame[0] < 30, `wrong picture after seek ${seek}: ${frame.subarray(0, 3)}`)
      const pcm = await run('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-ss', String(plan.localTime), '-t', '0.3', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], result)
      let crossings = 0
      for (let i = 2; i < pcm.length; i += 2) {
        if (pcm.readInt16LE(i - 2) <= 0 && pcm.readInt16LE(i) > 0) crossings++
      }
      const frequency = crossings / (pcm.length / 2 / 48000)
      assert.ok(Math.abs(frequency - 880) < 15, `wrong audio content at target: ${frequency} Hz`)
    }
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
