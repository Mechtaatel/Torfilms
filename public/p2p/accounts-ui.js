import { backendFetch } from './backend.js'
export let currentUser = null
export const canModerate = () => ['moderator', 'admin'].includes(currentUser?.role)
const element = (tag, text) => { const e = document.createElement(tag); if (text != null) e.textContent = text; return e }
async function api (route, data) {
  const response = await backendFetch(route, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Ошибка сервера'); return result
}
export function mountAccounts () {
  const button = element('button', 'Войти / Регистрация'); button.type = 'button'; document.querySelector('header .actions').append(button)
  const dialog = element('dialog'), content = element('div'), close = element('button', 'Закрыть')
  dialog.setAttribute('aria-label', 'Аккаунт и заявки'); close.onclick = () => dialog.close(); dialog.append(close, content); document.body.append(dialog)
  const showError = error => { const p = element('p', error.message); p.setAttribute('role', 'alert'); content.append(p) }
  const changed = () => { button.textContent = currentUser ? `${currentUser.name} · Аккаунт` : 'Войти / Регистрация'; document.dispatchEvent(new Event('torfilms-auth')) }
  async function requests () {
    const list = await api('/requests'); content.replaceChildren(element('h2', canModerate() ? 'Очередь заявок' : 'Мои заявки'))
    if (!list.length) content.append(element('p', 'Заявок пока нет'))
    const names = { pending: 'Ожидает решения', applying: 'Применяется — не повторять', approved: 'Принята', rejected: 'Отклонена' }
    for (const item of list.slice().reverse()) {
      const box = element('fieldset'); box.append(element('legend', `${item.draft.title || item.draft.id} · ${names[item.status]}`), element('p', `${item.kind} · ${item.createdAt}`))
      const details = element('details'); details.append(element('summary', 'Предложенные данные'), element('pre', JSON.stringify(item.draft, (key, value) => key === 'torrentBase64' ? '[torrent-файл]' : value, 2))); box.append(details)
      if (item.note || item.error) box.append(element('p', item.note || item.error))
      if (canModerate() && item.status === 'pending') {
        const note = element('textarea'); note.placeholder = 'Комментарий к решению'; note.setAttribute('aria-label', 'Комментарий модератора'); box.append(note)
        for (const [action, label] of [['approve', 'Принять и применить'], ['reject', 'Отклонить']]) {
          const b = element('button', label); b.onclick = async () => {
            b.disabled = true
            try { await api(`/requests/${item.id}/review`, { action, note: note.value }); await requests(); document.dispatchEvent(new Event('torfilms-catalog-changed')) } catch (e) { showError(e); b.disabled = false }
          }; box.append(b)
        }
      }
      content.append(box)
    }
  }
  async function users () {
    const list = await api('/admin/users'); content.replaceChildren(element('h2', 'Пользователи и права'))
    for (const user of list) {
      const row = element('fieldset'); row.append(element('legend', `${user.name} · ${user.email}`))
      const role = element('select'); role.setAttribute('aria-label', `Роль ${user.name}`)
      for (const [value, label] of [['user', 'Пользователь'], ['moderator', 'Модератор'], ['admin', 'Администратор']]) role.append(new Option(label, value))
      role.value = user.role
      const blocked = element('input'); blocked.type = 'checkbox'; blocked.checked = user.disabled
      const label = element('label', 'Заблокирован '); label.append(blocked)
      const save = element('button', 'Сохранить права'); save.onclick = async () => {
        save.disabled = true
        try { await api(`/admin/users/${user.id}`, { role: role.value, disabled: blocked.checked }); await users() } catch (e) { showError(e); save.disabled = false }
      }; row.append(role, label, save); content.append(row)
    }
  }
  function show () {
    content.replaceChildren(element('h2', currentUser ? currentUser.name : 'Вход и регистрация'))
    if (!currentUser) {
      const form = element('form'), email = element('input'), name = element('input'), password = element('input')
      email.type = 'email'; email.required = true; email.autocomplete = 'email'; email.placeholder = 'Email'; email.setAttribute('aria-label', 'Email')
      name.placeholder = 'Имя'; name.maxLength = 80; name.autocomplete = 'nickname'; name.setAttribute('aria-label', 'Имя')
      password.type = 'password'; password.required = true; password.maxLength = 128; password.autocomplete = 'current-password'; password.placeholder = 'Пароль (от 12 символов)'; password.setAttribute('aria-label', 'Пароль')
      const login = element('button', 'Войти'), register = element('button', 'Зарегистрироваться'); login.type = register.type = 'submit'; register.value = 'register'
      form.append(name, email, password, login, register)
      form.onsubmit = async event => {
        event.preventDefault(); login.disabled = register.disabled = true
        try { const result = await api(`/auth/${event.submitter?.value === 'register' ? 'register' : 'login'}`, { email: email.value, name: name.value, password: password.value }); sessionStorage.setItem('torfilms-session', result.token); password.value = ''; currentUser = result.user; changed(); show() } catch (e) { showError(e) } finally { login.disabled = register.disabled = false }
      }; content.append(form)
    } else {
      const queue = element('button', canModerate() ? 'Рассмотреть заявки' : 'Мои заявки'); queue.onclick = () => requests().catch(showError)
      const logout = element('button', 'Выйти'); logout.onclick = async () => { try { await api('/auth/logout', {}) } catch {} sessionStorage.removeItem('torfilms-session'); currentUser = null; changed(); show() }
      content.append(queue, logout)
      if (currentUser.role === 'admin') {
        const admin = element('button', 'Пользователи и права'); admin.onclick = () => users().catch(showError); content.append(admin)
        const audit = element('button', 'Журнал действий'); audit.onclick = async () => { try { const records = await api('/admin/audit'); content.replaceChildren(element('h2', 'Журнал действий'), element('pre', JSON.stringify(records, null, 2))) } catch (e) { showError(e) } }; content.append(audit)
      }
    }
  }
  button.onclick = () => { show(); dialog.showModal() }
  api('/auth/me').then(user => { currentUser = user; changed() }).catch(() => { currentUser = null; changed() })
  return { open () { show(); if (!dialog.open) dialog.showModal() } }
}
