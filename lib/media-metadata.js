import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export function mediaMetadata (directory) {
  const target = (hash, index) => {
    if (!/^[a-f0-9]{40}$/.test(hash) || !Number.isInteger(index) || index < 0) throw new Error('Invalid metadata key')
    return path.join(directory, `${hash}-${index}.json`)
  }
  return {
    async list (hash) {
      target(hash, 0)
      let names
      try { names = await readdir(directory) } catch (e) { if (e.code === 'ENOENT') return {}; throw e }
      const result = {}
      for (const name of names) {
        const match = new RegExp(`^${hash}-(\\d+)\\.json$`).exec(name)
        if (match) result[match[1]] = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
      }
      return result
    },
    async get (hash, index) {
      try { return JSON.parse(await readFile(target(hash, index), 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
    },
    async put (hash, index, data) {
      await mkdir(directory, { recursive: true })
      const file = target(hash, index), temp = `${file}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify(data)); await rename(temp, file)
    }
  }
}
