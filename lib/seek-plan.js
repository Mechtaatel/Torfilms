import { spawn } from 'node:child_process'

export async function seekPlan (executable, inputUrl, seconds, signal) {
  const child = spawn(executable, [
    '-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${seconds}%+#1`,
    '-show_entries', 'packet=pts_time,dts_time,flags:format=start_time:stream=has_b_frames,avg_frame_rate', '-of', 'json', inputUrl
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let output = ''
    let errors = ''
    const abort = () => { child.kill(); reject(new Error('Seek preparation cancelled')) }
    const timeout = setTimeout(abort, 60000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout.on('data', data => { output = (output + data).slice(-16000) })
    child.stderr.on('data', data => { errors = (errors + data).slice(-2000) })
    child.once('error', reject)
    child.once('close', code => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (code !== 0) return reject(new Error(errors || 'Cannot locate seek keyframe'))
      try {
        const info = JSON.parse(output)
        const packet = info.packets?.[0]
        const pts = Number(packet?.pts_time)
        const [num, den] = String(info.streams?.[0]?.avg_frame_rate || '0/1').split('/').map(Number)
        const fps = num / den
        const reorderDelay = fps > 0 ? (Number(info.streams?.[0]?.has_b_frames) || 0) / fps : 0
        // Matroska may omit DTS for its first packets. FFmpeg reconstructs
        // that small decoder delay from the video stream's reorder depth.
        const dts = packet?.dts_time === undefined ? pts - reorderDelay : Number(packet.dts_time)
        const start = Number(info.format?.start_time) || 0
        if (!packet?.flags?.includes('K') || !Number.isFinite(pts) || !Number.isFinite(dts)) {
          throw new Error('Seek keyframe timestamps unavailable')
        }
        // Fragmented MP4 starts at the first video's decode timestamp.
        // Retain its PTS-DTS distance: B-frames must not be flattened.
        const origin = dts - start
        resolve({ origin, localTime: Math.max(0, seconds - origin), keyframe: pts - start })
      } catch (error) { reject(error) }
    })
  })
}
