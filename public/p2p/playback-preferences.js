const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const key = scope => /^(tt\d{7,10}|[a-f0-9]{40})$/.test(scope || '') ? `torfilms_audio_${scope}` : null
function read (name, cookie = globalThis.document?.cookie || '') {
  try { return JSON.parse(decodeURIComponent(cookie.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1))) } catch { return null }
}
function write (name, value) {
  if (name) document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
}
export function readProcessing (cookie) { const value = read('torfilms_processing', cookie); return ['browser', 'bridge', 'direct'].includes(value) ? value : 'browser' }
export function saveProcessing (value) { if (['browser', 'bridge', 'direct'].includes(value)) write('torfilms_processing', value) }
export function audioIdentity (track, { files = [], labels = {}, index } = {}) {
  const title = labels[track.external ? `file:${track.fileIndex}` : `${index}:${track.index}`] || labels[track.id] || track.title
  const path = String(files[track.fileIndex]?.path || files[track.fileIndex]?.name || track.title || '').replaceAll('\\', '/')
  // External file indices change each episode; its directory identifies the dub.
  const directory = track.external && path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const name = normalize(title).replace(/(?:ep\.?|s\d+e|\be)\s*\d+/gi, 'episode')
  return { external: !!track.external, name, directory: normalize(directory), language: normalize(track.language) }
}
export function saveAudioPreference (scope, track, context) { if (track) write(key(scope), audioIdentity(track, context)) }
export function preferredAudio (scope, tracks, context, cookie) {
  const name = key(scope); if (!name) return null
  const saved = read(name, cookie)
  if (!saved || typeof saved.external !== 'boolean' || typeof saved.name !== 'string') return null
  const matches = tracks.filter(track => {
    const candidate = audioIdentity(track, context)
    if (candidate.external !== saved.external) return false
    return (saved.name && candidate.name === saved.name && candidate.language === saved.language) ||
      (saved.external && saved.directory && candidate.directory === saved.directory)
  })
  return matches.length === 1 ? matches[0] : null
}
