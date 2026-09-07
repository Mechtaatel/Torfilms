export function playbackArgs ({ inputUrl, seek = 0, audioUrl, audioSeek = seek, audioMap = '0:a:0?', transcodeVideo = false, copyAudio = false }) {
  // Retain preroll on BOTH tracks. The player skips it using seekPlan.
  // Never flatten PTS/DTS or encode compatible video merely to seek.
  const encode = transcodeVideo
  return [
    '-hide_banner', '-loglevel', 'error',
    '-copyts', '-start_at_zero',
    ...(seek > 0 ? ['-ss', String(seek), '-noaccurate_seek'] : []),
    '-i', inputUrl,
    ...(audioUrl ? [...(audioSeek > 0 ? ['-ss', String(audioSeek), '-noaccurate_seek'] : []), '-i', audioUrl] : []),
    '-map', '0:v:0', '-map', audioMap,
    ...(encode
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '48']
      : ['-c:v', 'copy']),
    ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000']),
    '-avoid_negative_ts', 'disabled',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1'
  ]
}
