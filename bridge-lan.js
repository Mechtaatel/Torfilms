import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { createLanProxy } from './lib/lan-proxy.js'
const host = process.env.TORFILMS_LAN_HOST
if (!Object.values(networkInterfaces()).flat().some(a => !a.internal && a.address === host)) throw new Error('Укажите TORFILMS_LAN_HOST — IP домашнего интерфейса')
const cert = process.env.TORFILMS_TLS_CERT
const key = process.env.TORFILMS_TLS_KEY
if (Boolean(cert) !== Boolean(key)) throw new Error('Нужны и TLS_CERT, и TLS_KEY')
const tls = cert ? { cert: await readFile(cert), key: await readFile(key) } : undefined
const port = Number(process.env.TORFILMS_BRIDGE_LAN_PORT || 18184)
const server = createLanProxy(Number(process.env.TORFILMS_BRIDGE_PORT || 18183), { tls, websocket: true })
server.on('error', e => { console.error(e.message); process.exitCode = 1 })
server.listen(port, host, () => {
  console.log(`Hybrid LAN: ${tls ? 'https' : 'http'}://${host}:${port}/`)
  if (!tls) console.log('HTTP: страница доступна, но P2P на телефоне требует доверенного HTTPS-сертификата.')
})
