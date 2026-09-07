import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import parseTorrent from 'parse-torrent'
import { mediaMetadata } from './media-metadata.js'
import { externalAudioFiles } from './external-audio.js'
import { videoFiles } from '../public/p2p/catalog-model.js'

export function catalog (directory) {
  const metadata = mediaMetadata(path.join(directory, 'media-metadata'))
  async function describeSource ({ torrentBase64, ...source }) {
    const parsed = await parseTorrent(torrentBase64 ? Buffer.from(torrentBase64, 'base64') : source.magnet)
    const files = parsed.files || await metadata.files(parsed.infoHash)
    const audioMetadata = await metadata.list(parsed.infoHash)
    for (const [index, file] of files.entries()) {
      if (!/\.(mkv|mp4|webm|avi|m4v|mov|ts)$/i.test(file.name)) continue
      const saved = await metadata.get(parsed.infoHash, index)
      const externalTracks = externalAudioFiles(files, index)
      if (saved || externalTracks.length) audioMetadata[index] = saved || { tracks: [], externalTracks, pending: true, duration: 0 }
    }
    const overrides = new Map((source.episodes || []).map(e => [e.index, e]))
    const episodes = videoFiles(files).map(({ file, index }) => ({ index, filename: file.name, title: overrides.get(index)?.title || file.name, excluded: overrides.get(index)?.excluded === true, duration: audioMetadata[index]?.duration || null }))
    return { ...source, episodes: episodes.length ? episodes : source.episodes || [], episodeCount: episodes.filter(e => !e.excluded).length, infoHash: parsed.infoHash, audioMetadata, hasTorrent: !!torrentBase64 }
  }
  let queue = Promise.resolve()
  async function all () {
    try { return JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8')) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  }
  const text = (value, max) => String(value || '').trim().slice(0, max)
  function posterValue (value) {
    const poster = String(value || '').trim()
    if (poster.length > 3000000 || (poster && !/^https:\/\//.test(poster) && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(poster))) throw new Error('Обложка: HTTPS-ссылка или JPEG/PNG/WebP до 2 МБ')
    return poster
  }
  async function normalize (input) {
    if (!/^tt\d{7,10}$/.test(input.id)) throw new Error('IMDb ID должен выглядеть как tt1727587')
    const title = text(input.title, 200)
    if (!title) throw new Error('Введите название')
    const poster = posterValue(input.poster)
    const kinopoiskId = text(input.kinopoiskId, 20)
    if (kinopoiskId && !/^[1-9]\d{0,11}$/.test(kinopoiskId)) throw new Error('ID Кинопоиска должен состоять из цифр')
    const ageRating = text(input.ageRating, 20)
    if (!['', '0+', '6+', '12+', '16+', '18+'].includes(ageRating)) throw new Error('Недопустимый возрастной рейтинг')
    const endDate = text(input.endDate, 40)
    if (endDate && (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !Number.isFinite(Date.parse(endDate)) || new Date(endDate).toISOString().slice(0, 10) !== endDate)) throw new Error('Укажите корректную дату завершения')
    const completed = input.completed === true
    if (endDate && !completed) throw new Error('Дата завершения указана, но сериал не отмечен завершённым')
    const tags = [...new Set((Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(',')).map(t => text(t, 60).toLowerCase()).filter(Boolean))]
    if (tags.length > 30) throw new Error('Не больше 30 тегов')
    const seasons = []
    if (!Array.isArray(input.seasons || []) || (input.seasons || []).length > 100) throw new Error('Не больше 100 сезонов')
    for (const season of input.seasons || []) {
      const number = Number(season.number)
      if (!Number.isInteger(number) || number < 0 || number > 999 || seasons.some(s => s.number === number)) throw new Error('Номера сезонов должны быть уникальными (0–999)')
      seasons.push({ number, title: text(season.title, 120) || `Сезон ${number}`, poster: posterValue(season.poster) })
    }
    const isSeries = input.isSeries === true || input.kind === 'Сериал' || seasons.length > 0
    const sources = []
    if (!Array.isArray(input.sources || []) || (input.sources || []).length > 200) throw new Error('Не больше 200 раздач на карточку')
    for (const source of input.sources || []) {
      const season = isSeries ? Number(source.season ?? 1) : null
      if (season !== null && (!Number.isInteger(season) || season < 0 || season > 999)) throw new Error('Номер сезона раздачи: 0–999')
      if (season !== null && !seasons.some(s => s.number === season)) seasons.push({ number: season, title: `Сезон ${season}`, poster: '' })
      const label = text(source.label, 80)
      if (!label) throw new Error('Укажите качество раздачи')
      const torrentBase64 = source.torrentBase64 || ''
      if (typeof torrentBase64 !== 'string' || torrentBase64.length > 4 * 1024 * 1024) throw new Error('.torrent слишком большой (до 3 МБ)')
      const parsed = await parseTorrent(torrentBase64 ? Buffer.from(torrentBase64, 'base64') : text(source.magnet, 12000))
      const episodes = []
      if (!Array.isArray(source.episodes || []) || (source.episodes || []).length > 2000) throw new Error('Не больше 2000 серий')
      for (const e of source.episodes || []) {
        const index = Number(e.index)
        if (!Number.isInteger(index) || index < 0 || episodes.some(x => x.index === index) || (parsed.files && !videoFiles(parsed.files).some(x => x.index === index))) throw new Error('Некорректный индекс серии')
        episodes.push({ index, title: text(e.title, 200), excluded: e.excluded === true })
      }
      const params = new URLSearchParams()
      for (const tracker of parsed.announce || []) params.append('tr', tracker)
      if (parsed.name) params.set('dn', parsed.name)
      sources.push({ id: /^[a-zA-Z0-9-]{1,40}$/.test(source.id || '') ? source.id : randomUUID(), label, season, episodes, magnet: `magnet:?xt=urn:btih:${parsed.infoHash}${params.size ? '&' + params : ''}`, torrentBase64, fileIndex: Math.max(0, Math.floor(Number(source.fileIndex) || 0)) })
    }
    if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('Повторяющийся ID качества')
    if (seasons.length > 100) throw new Error('Не больше 100 сезонов')
    return { id: input.id, title, year: text(input.year, 4), kind: ['Фильм', 'Сериал', 'Мультфильм', 'Аниме'].includes(input.kind) ? input.kind : 'Фильм', genre: text(input.genre, 160), description: text(input.description, 8000), poster, sources, kinopoiskId, ageRating, tags, isSeries, completed, endDate, seasons: seasons.sort((a, b) => a.number - b.number) }
  }
  async function save (input) {
    const item = await normalize(input)
    const operation = queue.then(async () => {
      const items = await all(), index = items.findIndex(m => m.id === item.id), old = items[index]
      if ((old?.revision || 0) !== (input.revision || 0)) throw new Error('Карточка уже изменена. Откройте её заново перед сохранением.')
      if (!old && items.length >= 200) throw new Error('Лимит домашнего каталога: 200 карточек')
      const next = { ...item, revision: (old?.revision || 0) + 1, updatedAt: new Date().toISOString() }
      if (index < 0) items.unshift(next); else items[index] = next
      const data = JSON.stringify(items)
      if (Buffer.byteLength(data) > 64 * 1024 * 1024) throw new Error('Каталог превышает 64 МБ')
      await mkdir(directory, { recursive: true })
      const temp = path.join(directory, 'catalog.json.tmp')
      await writeFile(temp, data); await rename(temp, path.join(directory, 'catalog.json'))
      return next
    })
    queue = operation.catch(() => {})
    return operation
  }
  async function resolve (id, quality) {
    const movie = (await all()).find(m => m.id === id)
    const source = movie?.sources.find(s => s.id === quality)
    if (!source) throw new Error('Сохранённая раздача не найдена')
    return source
  }
  async function handle (req, res, url) {
    if (!url.pathname.startsWith('/catalog/')) return false
    const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
    try {
      if (url.pathname === '/catalog/movies' && req.method === 'GET') {
        json(200, await Promise.all((await all()).map(async m => ({ ...m, sources: await Promise.all(m.sources.map(describeSource)) })))); return true
      }
      if (url.pathname === '/catalog/movies' && req.method === 'POST') {
        let chunks = [], size = 0
        for await (const chunk of req) { size += chunk.length; if (size > 12 * 1024 * 1024) throw new Error('Карточка слишком большая (до 12 МБ)'); chunks.push(chunk) }
        const input = JSON.parse(Buffer.concat(chunks))
        // Keep uploaded torrent bytes if the editor only changes descriptive fields.
        const previous = (await all()).find(m => m.id === input.id)
        for (const s of input.sources || []) if (s.hasTorrent && !s.torrentBase64) s.torrentBase64 = previous?.sources.find(p => p.id === s.id)?.torrentBase64 || ''
        json(200, await save(input)); return true
      }
      const match = /^\/catalog\/source\/(tt\d{7,10})\/([a-zA-Z0-9-]+)$/.exec(url.pathname)
      if (match && req.method === 'GET') { const source = await resolve(match[1], match[2]); json(200, { ...source, ...await describeSource(source) }); return true }
      json(404, { error: 'Not found' })
    } catch (e) { json(400, { error: e.message }) }
    return true
  }
  return { all, save, resolve, handle }
}
