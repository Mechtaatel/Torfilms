import { accountsStore } from '../lib/accounts-store.js'
import { fileURLToPath } from 'node:url'
const email = String(process.argv[2] || '').trim().toLowerCase()
if (!email || !email.includes('@')) throw new Error('Usage: node scripts/grant-admin.mjs EMAIL (after registration)')
const store = accountsStore(process.env.TORFILMS_CATALOG_DIR || fileURLToPath(new URL('../data/', import.meta.url)))
await store.change(state => {
  const user = state.users.find(u => u.email === email)
  if (!user) throw new Error('Account not registered. Register in the browser first.')
  user.role = 'admin'; user.disabled = false
  state.sessions = state.sessions.filter(s => s.userId !== user.id)
  state.audit.push({ at: new Date().toISOString(), actor: 'server-owner', action: 'grant-admin', target: user.id })
})
console.log('Administrator assigned. Sign in again.')
