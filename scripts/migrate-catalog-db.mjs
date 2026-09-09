import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { catalog } from '../lib/catalog.js'

if (!process.env.DATABASE_URL) throw new Error('Укажите DATABASE_URL от Neon перед миграцией')
const source = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'))
const target = catalog(process.env.TORFILMS_CATALOG_DIR || fileURLToPath(new URL('../data/', import.meta.url)))
for (const item of source) {
  await target.save({ ...item, revision: 0 })
  console.log(`migrated ${item.id}`)
}
console.log(`Готово: ${source.length} карточек перенесено в базу.`)
