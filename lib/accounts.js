import { randomBytes, randomUUID, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
const scrypt = promisify(derive)
const digest = value => createHash('sha256').update(value).digest('hex')
const safeUser = ({ id, email, name, role, disabled, createdAt }) => ({ id, email, name, role, disabled, createdAt })
export async function passwordHash (password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('Пароль: от 12 до 128 символов')
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`
}
export function accounts (store, library) {
  const limits = new Map()
  const audit = (state, actor, action, target) => { state.audit.push({ at: new Date().toISOString(), actor, action, target }); state.audit = state.audit.slice(-5000) }
  const requireUser = async (req, roles) => {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1]
    const state = await store.read()
    const session = token && state.sessions.find(s => s.hash === digest(token) && s.expires > Date.now())
    const user = session && state.users.find(u => u.id === session.userId && !u.disabled)
    if (!user || (roles && !roles.includes(user.role))) { const error = new Error(user ? 'Недостаточно прав' : 'Войдите в аккаунт'); error.status = user ? 403 : 401; throw error }
    return safeUser(user)
  }
  async function body (req) {
    const chunks = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > 12 * 1024 ** 2) throw new Error('Запрос слишком большой'); chunks.push(chunk) }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}')
  }
  function throttle (key, maximum) {
    const now = Date.now()
    for (const [k, entry] of limits) if (entry.until <= now) limits.delete(k)
    if (limits.size > 10000) throw new Error('Слишком много запросов')
    const entry = limits.get(key) || { count: 0, until: now + 15 * 60000 }; limits.set(key, entry)
    if (++entry.count > maximum) { const e = new Error('Слишком много попыток. Повторите через 15 минут.'); e.status = 429; throw e }
  }
  return { requireUser, async handle (req, res, url) {
    if (!/^\/(auth|requests|admin)(\/|$)/.test(url.pathname)) return false
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
    try {
      const route = url.pathname
      if (req.method === 'POST' && ['/auth/register', '/auth/login'].includes(route)) {
        throttle(`auth:${req.socket.remoteAddress}`, 60)
        const data = await body(req), email = String(data.email || '').trim().toLowerCase()
        if (!/^[^\s@]{1,64}@[^\s@]{1,180}\.[^\s@]{2,30}$/.test(email)) throw new Error('Некорректный email')
        throttle(`email:${email}`, 12)
        const token = randomBytes(32).toString('hex'), session = { hash: digest(token), expires: Date.now() + 7 * 86400000 }
        let user
        if (route === '/auth/register') {
          const hash = await passwordHash(data.password)
          user = { id: randomUUID(), email, name: String(data.name || email.split('@')[0]).trim().slice(0, 80), role: 'user', password: hash, disabled: false, createdAt: new Date().toISOString() }
          await store.change(state => {
            if (state.users.some(u => u.email === email)) throw new Error('Регистрация недоступна для этого адреса')
            if (state.users.length >= 10000) throw new Error('Лимит регистрации')
            state.users.push(user); state.sessions = state.sessions.filter(s => s.expires > Date.now()); state.sessions.push({ ...session, userId: user.id }); audit(state, user.id, 'register', user.id)
          })
        } else {
          user = (await store.read()).users.find(u => u.email === email)
          const [salt, expected] = (user?.password || `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':')
          if (typeof data.password !== 'string' || data.password.length > 128) throw new Error('Неверный email или пароль')
          const actual = await scrypt(data.password, salt, 64)
          if (!timingSafeEqual(actual, Buffer.from(expected, 'hex')) || !user || user.disabled) throw new Error('Неверный email или пароль')
          await store.change(state => {
            const current = state.users.find(u => u.id === user.id)
            if (!current || current.disabled) throw new Error('Аккаунт недоступен')
            state.sessions = state.sessions.filter(s => s.expires > Date.now() && (s.userId !== user.id || s.expires > Date.now() + 6 * 86400000)).slice(-20000)
            state.sessions.push({ ...session, userId: user.id })
          })
        }
        json(200, { user: safeUser(user), token }); return true
      }
      const user = await requireUser(req)
      if (route === '/auth/me' && req.method === 'GET') { json(200, user); return true }
      if (route === '/auth/logout' && req.method === 'POST') { const hash = digest(req.headers.authorization.slice(7)); await store.change(state => { state.sessions = state.sessions.filter(s => s.hash !== hash) }); json(200, { ok: true }); return true }
      if (route === '/requests' && req.method === 'GET') {
        const state = await store.read()
        json(200, state.requests.filter(r => user.role !== 'user' || r.author === user.id)); return true
      }
      if (route === '/requests' && req.method === 'POST') {
        throttle(`request:${user.id}`, 20)
        const data = await body(req)
        if (!['movie', 'description', 'poster', 'audio', 'quality', 'episodes'].includes(data.kind)) throw new Error('Укажите тип заявки')
        if (!data.draft || !/^tt\d{7,10}$/.test(data.draft.id)) throw new Error('Нужна карточка с IMDb ID')
        const request = { id: randomUUID(), author: user.id, kind: data.kind, draft: data.draft, status: 'pending', createdAt: new Date().toISOString() }
        await store.change(state => { if (state.requests.filter(r => r.author === user.id && r.status === 'pending').length >= 20) throw new Error('Сначала дождитесь обработки предыдущих заявок'); state.requests.push(request); audit(state, user.id, 'submit', request.id) })
        json(201, request); return true
      }
      const review = /^\/requests\/([a-f0-9-]+)\/review$/.exec(route)
      if (review && req.method === 'POST') {
        await requireUser(req, ['moderator', 'admin'])
        const data = await body(req)
        if (!['approve', 'reject'].includes(data.action)) throw new Error('Неизвестное решение')
        const request = await store.change(state => {
          const r = state.requests.find(r => r.id === review[1])
          if (!r || r.status !== 'pending') throw new Error('Заявка уже обрабатывается или закрыта')
          r.status = data.action === 'approve' ? 'applying' : 'rejected'; r.reviewer = user.id; r.note = String(data.note || '').slice(0, 2000); r.reviewedAt = new Date().toISOString()
          audit(state, user.id, r.status, r.id); return structuredClone(r)
        })
        if (data.action === 'approve') {
          try {
            // Existing catalog validation and optimistic revision checking remain mandatory.
            const draft = structuredClone(request.draft), old = (await library.all()).find(m => m.id === draft.id)
            for (const s of draft.sources || []) if (s.hasTorrent && !s.torrentBase64) s.torrentBase64 = old?.sources.find(p => p.id === s.id)?.torrentBase64 || ''
            await library.save(draft)
          } catch (error) { await store.change(state => { const r = state.requests.find(r => r.id === request.id); r.status = 'pending'; r.error = error.message }); throw error }
          await store.change(state => { const r = state.requests.find(r => r.id === request.id); r.status = 'approved'; delete r.error; audit(state, user.id, 'approved', r.id) })
        }
        json(200, { ok: true }); return true
      }
      if (route === '/admin/users' && req.method === 'GET') { await requireUser(req, ['admin']); json(200, (await store.read()).users.map(safeUser)); return true }
      if (route === '/admin/audit' && req.method === 'GET') { await requireUser(req, ['admin']); json(200, (await store.read()).audit.slice(-300)); return true }
      const target = /^\/admin\/users\/([a-f0-9-]+)$/.exec(route)
      if (target && req.method === 'POST') {
        await requireUser(req, ['admin']); const data = await body(req)
        if (!['user', 'moderator', 'admin'].includes(data.role) || typeof data.disabled !== 'boolean') throw new Error('Недопустимые права')
        await store.change(state => {
          const person = state.users.find(u => u.id === target[1]); if (!person) throw new Error('Пользователь не найден')
          if (person.role === 'admin' && !person.disabled && (data.role !== 'admin' || data.disabled) && state.users.filter(u => u.role === 'admin' && !u.disabled).length <= 1) throw new Error('Нельзя отключить последнего администратора')
          person.role = data.role; person.disabled = data.disabled; state.sessions = state.sessions.filter(s => s.userId !== person.id); audit(state, user.id, `role:${data.role};blocked:${data.disabled}`, person.id)
        }); json(200, { ok: true }); return true
      }
      json(404, { error: 'Маршрут не найден' })
    } catch (e) { json(e.status || 400, { error: e.message }) }
    return true
  } }
}
