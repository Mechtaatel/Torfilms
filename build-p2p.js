import { copyFile } from 'node:fs/promises'
for (const name of ['webtorrent.min.js', 'sw.min.js']) {
  await copyFile(new URL(`./node_modules/webtorrent/dist/${name}`, import.meta.url), new URL(`./public/p2p/${name}`, import.meta.url))
}
