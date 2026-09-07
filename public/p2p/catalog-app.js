import { tagsOf, seasonsOf, sourcesFor } from './catalog-model.js'
import { readProgress } from './watch-progress.js'
import { openSeriesEditor } from './series-editor.js'
const $ = s => document.querySelector(s)
let movies = [], category = '', editing = null
let activePlayer = null, playerRequest = 0
const node = (tag, text, className) => { const e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e }
async function api (route, options) { const response = await fetch(route, options); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Сервер недоступен'); return data }
function cover (movie) { const box = node('div', '', 'cover'); if (movie.poster) { const img = new Image(); img.src = movie.poster; img.alt = movie.title; img.loading = 'lazy'; img.onerror = () => box.replaceChildren(node('span', 'Нет обложки')); box.append(img) } else box.append(node('span', 'Нет обложки')); return box }
function card (movie) { const a = node('a', '', 'card'); a.href = `/film/${movie.id}`; a.append(cover(movie), node('h3', movie.title), node('small', [movie.year, movie.kind, movie.genre].filter(Boolean).join(' · '))); return a }
function render () {
  ++playerRequest; activePlayer?.destroy(); activePlayer = null
  const content = $('#content'); content.replaceChildren()
  const id = /^\/film\/(tt\d{7,10})\/?$/.exec(location.pathname)?.[1]
  if (id) {
    const movie = movies.find(m => m.id === id)
    if (!movie) { content.append(node('h1', 'Фильм не найден'), node('p', 'Карточку с таким IMDb ID ещё не добавили.')); return }
    document.title = `${movie.title} — Torfilms`
    const seasons = seasonsOf(movie)
    const chosenSeason = Number(new URLSearchParams(location.search).get('season') ?? readProgress(id)?.season)
    const season = seasons.find(s => s.number === chosenSeason) || seasons[0]
    const playable = { ...movie, activeSeason: season?.number, sources: sourcesFor(movie, season?.number) }
    const back = node('a', '← В библиотеку', 'muted'); back.href = '/'; content.append(back)
    const detail = node('section', '', 'detail'); detail.style.marginTop = '24px'
    const body = node('div', '', 'body'); body.append(node('div', movie.kind, 'eyebrow'), node('h1', movie.title), node('p', [movie.year, movie.genre].filter(Boolean).join(' · '), 'muted'))
    const imdb = node('a', `IMDb · ${movie.id}`); imdb.href = `https://www.imdb.com/title/${movie.id}/`; imdb.target = '_blank'; imdb.rel = 'noopener'; body.append(imdb)
    if (movie.kinopoiskId) { const kp = node('a', `Кинопоиск · ${movie.kinopoiskId}`); kp.href = `https://www.kinopoisk.ru/${seasons.length ? 'series' : 'film'}/${movie.kinopoiskId}/`; kp.target = '_blank'; kp.rel = 'noopener'; kp.className = 'external-id'; body.append(kp) }
    const meta = node('p', movie.ageRating ? `Возраст: ${movie.ageRating}` : 'Возрастной рейтинг не указан', 'muted')
    if (seasons.length || movie.isSeries || movie.kind === 'Сериал') meta.append(node('span', movie.completed ? ` · Завершён${movie.endDate ? ' · Дата окончания: ' + movie.endDate.split('-').reverse().join('.') : ' · Дата окончания не указана'}` : ' · Дата окончания не указана'))
    body.append(meta)
    const tagList = node('div', '', 'tag-list')
    for (const tag of tagsOf(movie)) { const link = node('a', tag, 'tag'); link.href = `/?tag=${encodeURIComponent(tag)}`; tagList.append(link) }
    body.append(tagList)
    const edit = node('button', 'Редактировать'); edit.onclick = () => openEditor(movie)
    const actions = node('div', '', 'actions')
    const play = node('button', '▶ Смотреть', 'primary'); play.disabled = !playable.sources.length
    const player = node('section'); player.hidden = true; player.setAttribute('aria-label', 'Плеер фильма')
    play.onclick = async () => {
      const request = ++playerRequest
      play.disabled = true
      try {
        if (activePlayer) activePlayer.retryIfStopped()
        else {
          const { createCompactPlayer } = await import('./compact-player.js')
          if (request !== playerRequest) return
          const progress = readProgress(id)
          activePlayer = createCompactPlayer(player, playable, playable.sources.find(s => s.id === progress?.quality)?.id || playable.sources[0]?.id)
        }
        player.hidden = false; player.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } catch (error) { $('#notice').textContent = `Не удалось открыть плеер: ${error.message}` }
      finally { play.disabled = false }
    }
    if (!playable.sources.length) actions.append(node('span', 'Раздачи этого сезона пока не добавлены', 'muted'))
    const seriesEdit = node('button', 'Редактор серий/озвучек')
    seriesEdit.onclick = async () => {
      try {
        const fresh = (await api('/catalog/movies')).find(m => m.id === movie.id)
        openSeriesEditor(fresh, async draft => { await api('/catalog/movies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) }); movies = await api('/catalog/movies'); render() })
      } catch (e) { $('#notice').textContent = e.message }
    }
    actions.append(play, edit, seriesEdit)
    body.append(node('p', movie.description || 'Описание пока не добавлено.', 'description'), actions)
    detail.append(cover({ ...movie, poster: season?.poster || movie.poster }), body); content.append(detail)
    if (seasons.length) {
      const strip = node('section', '', 'season-list'); strip.setAttribute('aria-label', 'Сезоны сериала')
      for (const item of seasons) { const link = node('a', '', `season-card${item.number === season.number ? ' selected' : ''}`); link.href = `/film/${movie.id}?season=${item.number}`; if (item.number === season.number) link.setAttribute('aria-current', 'page'); link.append(cover({ title: item.title, poster: item.poster || movie.poster }), node('strong', item.title)); strip.append(link) }
      content.append(node('h2', 'Сезоны'), strip)
    }
    content.append(player)
    return
  }
  document.title = 'Torfilms — домашний кинотеатр'
  const term = $('#search').value.trim().toLowerCase()
  const tag = $('#tag-filter').value
  const filtered = movies.filter(m => (!category || m.kind === category) && (!tag || tagsOf(m).includes(tag)) && (!term || `${m.title} ${m.id} ${m.kinopoiskId || ''} ${m.genre} ${tagsOf(m).join(' ')}`.toLowerCase().includes(term)))
  const sort = $('#sort').value
  if (sort === 'title') filtered.sort((a, b) => a.title.localeCompare(b.title, 'ru'))
  if (sort === 'year') filtered.sort((a, b) => Number(b.year) - Number(a.year))
  if (sort === 'tag') filtered.sort((a, b) => tagsOf(a).slice().sort().join(',').localeCompare(tagsOf(b).slice().sort().join(','), 'ru') || a.title.localeCompare(b.title, 'ru'))
  const heading = node('div', '', 'section-head'); heading.append(node('h1', term ? 'Результаты поиска' : 'Ваша библиотека'), node('span', `${filtered.length} в каталоге`, 'muted')); content.append(heading)
  if (!filtered.length) { const empty = node('div', '', 'empty'); empty.append(node('h2', movies.length ? 'Ничего не найдено' : 'Большой экран начинается здесь'), node('p', movies.length ? 'Попробуйте другое название или категорию.' : 'Добавьте фильм по IMDb ID, загрузите обложку и сохраните раздачи нужного качества. Библиотека будет доступна всем вашим устройствам в домашней сети.', 'muted')); if (!movies.length) { const add = node('button', 'Добавить первый фильм', 'primary'); add.onclick = () => openEditor(); empty.append(add) } content.append(empty) }
  else { const grid = node('section', '', 'grid'); grid.setAttribute('aria-label', 'Фильмы'); filtered.forEach(m => grid.append(card(m))); content.append(grid) }
  content.append(node('div', 'Ваш фильм. Ваше качество. Общая библиотека для дома — отдельный RAM-кеш на каждом устройстве и параллельный Hybrid-мост на сервере.', 'note'))
}
const form = $('#movie-form')
const field = name => form.elements.namedItem(name)
function addSource (source = {}) {
  if ($('#sources').children.length >= 200) return
  const row = node('fieldset'); row.source = source; row.append(node('legend', 'Версия фильма'))
  if (source.episodes?.length) row.append(node('p', `Видео: ${source.episodes.filter(e => !e.excluded).length}. Названия и сезоны — в отдельном «Редакторе серий/озвучек».`))
  for (const [name, title, value] of [['label', 'Качество / версия', source.label], ['season', 'Номер сезона (для сериалов)', source.season ?? 1], ['magnet', 'Magnet-ссылка', source.magnet], ['fileIndex', 'Начальный индекс видео (серии доступны в плеере)', source.fileIndex ?? 0]]) { const label = node('label', title), input = node('input'); input.dataset.field = name; input.value = value ?? ''; input.type = ['fileIndex', 'season'].includes(name) ? 'number' : 'text'; if (input.type === 'number') { input.min = '0'; input.step = '1' } if (name === 'label') input.required = true; label.append(input); row.append(label) }
  const upload = node('input'); upload.type = 'file'; upload.accept = '.torrent'; upload.dataset.field = 'torrent'
  const label = node('label', source.hasTorrent || source.torrentBase64 ? '.torrent сохранён. Выберите файл, чтобы заменить.' : 'Или .torrent-файл (до 3 МБ)'); label.append(upload)
  row.querySelector('[data-field=magnet]').oninput = () => { row.source = { ...row.source, episodes: [], audioLabels: {}, hasTorrent: false, torrentBase64: '' }; row.querySelector('details')?.remove() }
  upload.onchange = () => { row.source = { ...row.source, episodes: [], audioLabels: {} }; row.querySelector('details')?.remove() }
  const remove = node('button', 'Убрать качество'); remove.type = 'button'; remove.onclick = () => row.remove(); row.append(label, remove); $('#sources').append(row)
}
function addSeason (season = {}) {
  if ($('#seasons').children.length >= 100) return
  field('isSeries').checked = true
  const row = node('fieldset'); row.season = season; row.append(node('legend', 'Сезон'))
  for (const [key, title, value] of [['number', 'Номер сезона', season.number ?? $('#seasons').children.length + 1], ['title', 'Название сезона', season.title || ''], ['poster', 'Обложка: HTTPS-ссылка', season.poster?.startsWith('data:') ? '' : season.poster || '']]) {
    const label = node('label', title), input = node('input'); input.dataset.field = key; input.value = value; input.type = key === 'number' ? 'number' : key === 'poster' ? 'url' : 'text'; if (key === 'number') { input.min = '0'; input.max = '999'; input.required = true }; label.append(input); row.append(label)
  }
  const upload = node('input'); upload.type = 'file'; upload.accept = 'image/jpeg,image/png,image/webp'; const label = node('label', 'Или обложка с устройства (до 2 МБ)'); label.append(upload); row.append(label)
  const remove = node('button', 'Убрать оформление сезона'); remove.type = 'button'; remove.onclick = () => row.remove(); row.append(remove); $('#seasons').append(row)
}
const fields = ['id', 'title', 'year', 'kind', 'genre', 'description', 'poster', 'kinopoiskId', 'ageRating', 'endDate']
function openEditor (movie) {
  editing = movie || null; form.reset(); $('#sources').replaceChildren(); $('#form-error').textContent = ''; $('#editor-title').textContent = movie ? 'Редактировать фильм' : 'Добавить фильм'
  for (const key of fields) field(key).value = key === 'poster' && movie?.poster?.startsWith('data:') ? '' : movie?.[key] || (key === 'kind' ? 'Фильм' : '')
  field('tags').value = movie ? tagsOf(movie).join(', ') : ''
  field('isSeries').checked = !!movie?.isSeries || movie?.kind === 'Сериал'
  field('completed').checked = !!movie?.completed
  $('#seasons').replaceChildren(); for (const season of movie ? seasonsOf(movie) : []) addSeason(season)
  field('id').readOnly = !!movie
  for (const source of movie?.sources || []) addSource(source)
  $('#editor').showModal()
}
async function fileData (file, maximum) { if (file.size > maximum) throw new Error(`Файл ${file.name} слишком большой`); return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file) }) }
form.onsubmit = async event => {
  event.preventDefault(); $('#save').disabled = true; $('#form-error').textContent = ''
  try {
    const input = Object.fromEntries(fields.map(key => [key, field(key).value])); input.revision = editing?.revision || 0
    input.tags = field('tags').value.split(','); input.isSeries = field('isSeries').checked; input.completed = field('completed').checked
    input.seasons = await Promise.all([...$('#seasons').children].map(async row => {
      const value = Object.fromEntries(['number', 'title', 'poster'].map(key => [key, row.querySelector(`[data-field=${key}]`).value]))
      const file = row.querySelector('[type=file]').files[0]
      if (file) value.poster = await fileData(file, 2 * 1024 ** 2)
      else if (!value.poster && row.season.poster?.startsWith('data:')) value.poster = row.season.poster
      return value
    }))
    const poster = $('#poster-file').files[0]; if (poster) { if (!['image/jpeg', 'image/png', 'image/webp'].includes(poster.type)) throw new Error('Обложка должна быть JPEG, PNG или WebP'); input.poster = await fileData(poster, 2 * 1024 ** 2) } else if (!input.poster && editing?.poster?.startsWith('data:')) input.poster = editing.poster
    input.sources = await Promise.all([...$('#sources').children].map(async row => { const source = { ...row.source }; for (const key of ['label', 'magnet', 'fileIndex', 'season']) source[key] = row.querySelector(`[data-field=${key}]`).value; const file = row.querySelector('[type=file]').files[0]; if (file) source.torrentBase64 = (await fileData(file, 3 * 1024 ** 2)).split(',')[1]; return source }))
    const saved = await api('/catalog/movies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); location.href = `/film/${saved.id}`
  } catch (error) { $('#form-error').textContent = error.message || 'Не удалось прочитать файл' } finally { $('#save').disabled = false }
}
$('#add').onclick = () => openEditor(); $('#add-source').onclick = () => addSource(); $('#close').onclick = () => $('#editor').close()
$('#add-season').onclick = () => addSeason()
for (const selector of ['#tag-filter', '#sort']) $(selector).onchange = () => { if (location.pathname !== '/') history.pushState({}, '', '/'); render() }
$('#search').oninput = () => { if (location.pathname !== '/') history.pushState({}, '', '/'); render() }
document.querySelectorAll('[data-kind]').forEach(button => { button.onclick = () => { category = button.dataset.kind; document.querySelectorAll('[data-kind]').forEach(b => b.classList.toggle('active', b === button)); if (location.pathname !== '/') history.pushState({}, '', '/'); render() } })
addEventListener('popstate', render)
try { movies = await api('/catalog/movies'); for (const tag of [...new Set(movies.flatMap(tagsOf))].sort((a, b) => a.localeCompare(b, 'ru'))) { const option = node('option', tag); option.value = tag; $('#tag-filter').append(option) }; $('#tag-filter').value = new URLSearchParams(location.search).get('tag') || ''; render() } catch (error) { $('#notice').textContent = `Не удалось загрузить библиотеку: ${error.message}` }
