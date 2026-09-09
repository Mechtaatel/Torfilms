import { copyFile } from 'node:fs/promises'
for (const name of ['webtorrent.min.js', 'sw.min.js']) {
  await copyFile(new URL(`./node_modules/webtorrent/dist/${name}`, import.meta.url), new URL(`./public/p2p/${name}`, import.meta.url))
}
for (const [source, destination] of [
  ['dist/bundles/mediabunny.min.mjs', 'mediabunny.min.mjs'],
  ['LICENSE', 'mediabunny-LICENSE.txt']
]) await copyFile(new URL(`./node_modules/mediabunny/${source}`, import.meta.url), new URL(`./public/p2p/${destination}`, import.meta.url))
await copyFile(new URL('./lib/external-audio.js', import.meta.url), new URL('./public/p2p/external-audio.js', import.meta.url))
