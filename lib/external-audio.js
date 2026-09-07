const basename = file => String(file.path || file.name || '').replaceAll('\\', '/').split('/').pop()
const stem = file => basename(file).replace(/\.[^.]+$/, '').toLowerCase()
const episode = name => {
  const match = /^(.*?)(s\d+[ ._-]*)?(?:ep\.?|e)(\d+)(?=\D|$)/i.exec(name)
  return match && `${match[1].replace(/[\s._-]/g, '')}:${match[2]?.replace(/[ ._-]/g, '') || ''}:${Number(match[3])}`
}

export function externalAudioFiles (files, videoIndex) {
  const video = files[videoIndex]
  if (!video || !/\.(mkv|mp4|webm|avi|m4v|mov|ts)$/i.test(basename(video))) return []
  const videoStem = stem(video), videoEpisode = episode(videoStem)
  return files.flatMap((file, fileIndex) => {
    if (!/\.(mka|m4a|aac|ac3|eac3|dts|flac|ogg|opus|mp3|wav)$/i.test(basename(file))) return []
    const audioStem = stem(file)
    if (audioStem !== videoStem && !audioStem.startsWith(`${videoStem}.`) && !(videoEpisode && videoEpisode === episode(audioStem))) return []
    return [{ fileIndex, title: String(file.path || file.name), external: true }]
  })
}
