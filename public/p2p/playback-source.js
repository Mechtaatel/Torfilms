// The public catalog exposes only an explicitly approved infohash, never tracker keys.
export function publicPlaybackSource (source) {
  const hash = source?.publicPlayback?.infoHash
  if (!/^[a-f0-9]{40}$/i.test(hash || '')) return null
  return { ...source, infoHash: hash.toLowerCase(), private: false, magnet: `magnet:?xt=urn:btih:${hash.toLowerCase()}` }
}
