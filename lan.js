import { networkInterfaces } from 'node:os'
import { createLanProxy } from './lib/lan-proxy.js'

const host = process.env.TORFILMS_LAN_HOST
const addresses = Object.values(networkInterfaces()).flat().filter(Boolean)
if (!host || !addresses.some(a => a.address === host && !a.internal)) {
  console.error('Укажите адрес домашнего интерфейса: TORFILMS_LAN_HOST (например, 192.168.0.122).')
  process.exit(1)
}
const port = Number(process.env.TORFILMS_LAN_PORT || 18182)
const server = createLanProxy(Number(process.env.TORFILMS_PORT || 18181))
server.on('error', error => { console.error(error.message); process.exitCode = 1 })
server.listen(port, host, () => console.log(`Torfilms LAN: http://${host}:${server.address().port}/`))
