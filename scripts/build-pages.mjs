import { mkdir, readdir, readFile, writeFile, copyFile, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import runtimeConfig from '../public/p2p/runtime-config.js'
const root = fileURLToPath(new URL('../public/p2p/', import.meta.url))
const out = fileURLToPath(new URL('../dist-pages/', import.meta.url))
const backend = new URL(process.env.TORFILMS_BACKEND_URL || '')
if (backend.protocol !== 'https:' || backend.pathname !== '/' || backend.username || backend.password || backend.search || backend.hash) throw new Error('TORFILMS_BACKEND_URL must be a public HTTPS origin')
const base = process.env.TORFILMS_PAGES_BASE || '/Torfilms/'
const neonDataApiUrl = process.env.TORFILMS_NEON_DATA_API_URL || runtimeConfig.neonDataApiUrl || ''
const neonAnonymousTokenUrl = process.env.TORFILMS_NEON_ANONYMOUS_TOKEN_URL || runtimeConfig.neonAnonymousTokenUrl || ''
for (const value of [neonDataApiUrl, neonAnonymousTokenUrl].filter(Boolean)) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Neon URL must be public HTTPS without credentials or query parameters')
}
if (!/^\/(?:[a-zA-Z0-9_.-]+\/)*$/.test(base) || base.includes('..')) throw new Error('Invalid TORFILMS_PAGES_BASE')
await mkdir(out, { recursive: true })
// Remove retired standalone-player assets from previous local builds as well.
for (const file of ['player.html', 'bootstrap.js', 'style.css']) {
  await unlink(path.join(out, file)).catch(error => { if (error.code !== 'ENOENT') throw error })
}
for (const file of await readdir(root)) {
  if (!/\.(js|mjs|css|html|txt)$/.test(file)) continue
  if (file.endsWith('.html')) {
    const text = (await readFile(path.join(root, file), 'utf8')).replace(/(href|src)="\/(?!\/)/g, `$1="${base}`)
    await writeFile(path.join(out, file), text)
  } else await copyFile(path.join(root, file), path.join(out, file))
}
await writeFile(path.join(out, 'runtime-config.js'), `export default ${JSON.stringify({ backendUrl: backend.origin, staticRouting: true, viewerOnly: true, neonDataApiUrl, neonAnonymousTokenUrl })}\n`)
await writeFile(path.join(out, '.nojekyll'), '')
// GitHub Pages has no SPA rewrites: its custom 404 serves the app shell at
// the requested IMDb URL. Absolute asset paths also work with a trailing slash.
await copyFile(path.join(out, 'index.html'), path.join(out, '404.html'))
console.log(`Pages build: ${out}; base ${base}; backend ${backend.origin}`)
