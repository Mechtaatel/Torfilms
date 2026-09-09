import { ramLimitBytes } from './ram-limits.js'
export function readRamSetting (cookie = globalThis.document?.cookie || '') {
  const value = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('torfilms_ram='))?.split('=')[1]
  try { ramLimitBytes(value); return Number(value) } catch { return 500 }
}
export function saveRamSetting (value) {
  ramLimitBytes(value)
  document.cookie = `torfilms_ram=${Number(value)}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
}
