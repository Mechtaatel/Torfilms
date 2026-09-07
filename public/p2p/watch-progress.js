export function readProgress (id, cookie = document.cookie) {
  if (!/^tt\d{7,10}$/.test(id || '')) return null
  try {
    const value = cookie.split('; ').find(s => s.startsWith(`torfilms_${id}=`))?.split('=').slice(1).join('=')
    const p = JSON.parse(decodeURIComponent(value))
    return /^[a-f0-9]{40}$/.test(p.hash) && Number.isInteger(p.index) && p.index >= 0 && Number.isFinite(p.time) && p.time >= 0 && p.time < 604800 && typeof p.quality === 'string' ? p : null
  } catch { return null }
}
export function writeProgress (id, progress) {
  if (!/^tt\d{7,10}$/.test(id || '')) return
  document.cookie = `torfilms_${id}=${encodeURIComponent(JSON.stringify(progress))}; Path=/; Max-Age=15552000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
}
