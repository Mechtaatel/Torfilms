export function tagsOf (movie) {
  return [...new Set((movie.tags?.length ? movie.tags : String(movie.genre || '').split(',')).map(t => t.trim().toLowerCase()).filter(Boolean))]
}
export function seasonKey (value = 1) { return String(value).trim().normalize('NFC') }
export function seasonValue (value = 1) {
  const key = seasonKey(value)
  if (!key || key.length > 80 || /[\u0000-\u001f]/.test(key) || /^-\d/.test(key)) throw new Error('Сезон: название до 80 символов')
  return /^\d{1,3}$/.test(key) ? Number(key) : key
}
export const seasonTitle = value => typeof value === 'number' ? `Сезон ${value}` : String(value)
export const seasonNameKey = value => String(value).normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru')
export function validateSeasonNames (seasons) {
  const names = new Set()
  for (const s of seasons) {
    const key = seasonNameKey(s.title || seasonTitle(s.number))
    if (names.has(key)) throw new Error(`Название сезона «${s.title}» уже используется. Переименуйте или объедините сезоны.`)
    names.add(key)
  }
}
// Reassign every reference, including excluded episodes and source defaults.
// Otherwise normalization would silently recreate the deleted season.
export function removeSeason (movie, key, destination) {
  const matches = value => seasonKey(value) === seasonKey(key)
  const target = movie.seasons.find(s => seasonKey(s.number) === seasonKey(destination) && !matches(s.number))
  const referenced = movie.sources.some(s => matches(s.season ?? 1) || (s.episodes || []).some(e => matches(e.season ?? s.season ?? 1)))
  if (referenced && !target) throw new Error('Выберите сезон, в который перенести серии и раздачи.')
  for (const source of movie.sources) {
    const previous = source.season ?? 1
    for (const e of source.episodes || []) if (matches(e.season ?? previous)) e.season = target.number
    if (matches(previous)) source.season = target.number
  }
  movie.seasons = movie.seasons.filter(s => !matches(s.number))
}
export function seasonsOf (movie) {
  if (!movie.isSeries && movie.kind !== 'Сериал' && !movie.seasons?.length) return []
  const seasons = new Map((movie.seasons || []).map(s => [seasonKey(s.number), { ...s }]))
  for (const source of movie.sources || []) {
    const number = source.season ?? 1
    if (!seasons.has(seasonKey(number))) seasons.set(seasonKey(number), { number, title: seasonTitle(number), poster: '' })
    for (const e of source.episodes || []) if (!e.excluded && e.season != null && !seasons.has(seasonKey(e.season))) seasons.set(seasonKey(e.season), { number: e.season, title: seasonTitle(e.season), poster: '' })
  }
  return [...seasons.values()].sort((a, b) => String(a.number).localeCompare(String(b.number), 'ru', { numeric: true }))
}
export function sourcesFor (movie, season) {
  return season == null ? movie.sources : movie.sources.filter(s => s.episodes?.length ? s.episodes.some(e => !e.excluded && seasonKey(e.season ?? s.season ?? 1) === seasonKey(season)) : seasonKey(s.season ?? 1) === seasonKey(season))
}
export function videoFiles (files, overrides = []) {
  const settings = new Map(overrides.map(e => [e.index, e]))
  return files.map((file, index) => ({ file, index, title: settings.get(index)?.title || file.name })).filter(({ file, index }) => !settings.get(index)?.excluded && /\.(mp4|webm|m4v|ogg|ogv|mkv|mov|avi|ts|m2ts)$/i.test(file.name)).sort((a, b) => a.file.name.localeCompare(b.file.name, 'ru', { numeric: true }))
}
