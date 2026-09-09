export function allowedOrigin (req, env = process.env) {
  const origin = req.headers.origin
  if (!origin) return true
  const allowed = (env.TORFILMS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  return origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}` || allowed.includes(origin)
}
export function backendAccess (req, res, env = process.env) {
  if (!allowedOrigin(req, env)) { res.writeHead(403); res.end('Origin not allowed'); return false }
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return false }
  // CORS is not authentication. Public deployments default to immutable catalog.
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (env.TORFILMS_CATALOG_READONLY === '1' && pathname.startsWith('/catalog/') && !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(403); res.end(JSON.stringify({ error: 'Каталог доступен только для чтения' })); return false
  }
  return true
}
