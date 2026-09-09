import config from './runtime-config.js'
export function backendUrl (route) {
  if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Invalid backend route')
  if (!config.backendUrl) return route
  const base = new URL(config.backendUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('backendUrl must be an HTTP(S) origin')
  return new URL(route, base).href
}
export const backendFetch = (route, options) => fetch(backendUrl(route), options)
export function trackerUrl (route = '/tracker') {
  const url = new URL(backendUrl(route), globalThis.location?.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}
export const siteRoot = new URL('./', import.meta.url).pathname
export function filmUrl (id, season) {
  if (!/^tt\d{7,10}$/.test(id)) throw new Error('Invalid IMDb ID')
  return `${siteRoot}${id}`
}
export function filmId (pathname, search = '', root = siteRoot) {
  if (!pathname.startsWith(root)) return null
  const path = pathname.slice(root.length)
  const match = /^(?:film\/)?(tt\d{7,10})\/?$/.exec(path)
  const legacy = new URLSearchParams(search).get('film')
  return match?.[1] || (/^tt\d{7,10}$/.test(legacy || '') ? legacy : null)
}
