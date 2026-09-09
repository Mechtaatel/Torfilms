import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../public/p2p/', import.meta.url))
const out = fileURLToPath(new URL('../dist-pages/', import.meta.url))
const backend = new URL(process.env.TORFILMS_BACKEND_URL || '')
if (backend.protocol !== 'https:' || backend.pathname !== '/' || backend.username || backend.password || backend.search || backend.hash) throw new Error('TORFILMS_BACKEND_URL must be a public HTTPS origin')
const base = process.env.TORFILMS_PAGES_BASE || '/Torfilms/'
if (!/^\/(?:[a-zA-Z0-9_.-]+\/)*$/.test(base) || base.includes('..')) throw new Error('Invalid TORFILMS_PAGES_BASE')
await mkdir(out, { recursive: true })
for (const file of await readdir(root)) {
  if (!/\.(js|mjs|css|html|txt)$/.test(file)) continue
  if (file.endsWith('.html')) {
    const text = (await readFile(path.join(root, file), 'utf8')).replace(/(href|src)="\/(?!\/)/g, `$1="${base}`)
    await writeFile(path.join(out, file), text)
  } else await copyFile(path.join(root, file), path.join(out, file))
}
await writeFile(path.join(out, 'runtime-config.js'), `export default ${JSON.stringify({ backendUrl: backend.origin, staticRouting: true })}\n`)
await writeFile(path.join(out, '.nojekyll'), '')
// GitHub Pages has no SPA rewrites: its custom 404 serves the app shell at
// the requested IMDb URL. Absolute asset paths also work with a trailing slash.
await copyFile(path.join(out, 'index.html'), path.join(out, '404.html'))
console.log(`Pages build: ${out}; base ${base}; backend ${backend.origin}`)
