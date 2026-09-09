// This adapter never sends Torfilms accounts, cookies or database credentials to Neon.
export function createCatalogReader (config, fallback, request = globalThis.fetch) {
  let tokenRequest
  function endpoint (value) {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Neon: требуется публичный HTTPS URL без ключей и пароля')
    return url
  }
  async function token () {
    if (!config.neonAnonymousTokenUrl) return null
    tokenRequest ||= request(endpoint(config.neonAnonymousTokenUrl), { credentials: 'omit', cache: 'no-store' }).then(async res => {
      const data = await res.json()
      if (!res.ok || typeof data.token !== 'string') throw new Error('Не удалось получить гостевой токен Neon')
      return data.token
    }).catch(error => { tokenRequest = null; throw error })
    return tokenRequest
  }
  return async function readMovies () {
    if (!config.neonDataApiUrl) return fallback('/catalog/movies')
    const base = endpoint(config.neonDataApiUrl)
    base.pathname = base.pathname.replace(/\/$/, '') + '/movies'
    base.search = '?select=movie&order=id.asc&limit=200&offset=0'
    const movies = []
    for (let offset = 0; ; offset += 200) {
      base.searchParams.set('offset', String(offset))
      let response
      for (let attempt = 0; attempt < 2; attempt++) {
        const jwt = await token()
        response = await request(base.href, { method: 'GET', credentials: 'omit', headers: { 'Accept-Profile': 'catalog', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) } })
        if (response.status !== 401 || attempt) break
        tokenRequest = null
      }
      const rows = await response.json()
      if (!response.ok) throw new Error(rows.message || 'Neon: каталог недоступен')
      if (!Array.isArray(rows) || rows.some(row => !row.movie || !/^tt\d{7,10}$/.test(row.movie.id))) throw new Error('Neon: некорректный каталог')
      movies.push(...rows.map(row => row.movie))
      if (rows.length < 200) return movies
    }
  }
}
