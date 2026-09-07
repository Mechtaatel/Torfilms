import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import { mkdirSync, appendFileSync, statSync, renameSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('.', import.meta.url))
const runtime = path.join(root, '.runtime')
mkdirSync(runtime, { recursive: true })
const logfile = path.join(runtime, 'keep-online.log')
function log (text) {
  try {
    if (statSync(logfile, { throwIfNoEntry: false })?.size > 1024 * 1024) renameSync(logfile, logfile + '.previous')
    appendFileSync(logfile, `${new Date().toISOString()} ${text}\n`)
  } catch {}
}
// One supervisor, including when the launcher is run again manually.
const guard = net.createServer(socket => socket.destroy())
guard.on('error', error => { if (error.code !== 'EADDRINUSE') log(error.message); process.exit(error.code === 'EADDRINUSE' ? 0 : 1) })
guard.listen(18186, '127.0.0.1', () => { log('Supervisor started'); tick() })
const env = {
  ...process.env,
  TORFILMS_BRIDGE_HOST: '127.0.0.1', TORFILMS_BRIDGE_PORT: '18183',
  TORFILMS_LAN_HOST: '192.168.0.122', TORFILMS_BRIDGE_LAN_PORT: '18184',
  TORFILMS_TLS_CERT: path.join(root, '.local-tls/server.pem'),
  TORFILMS_TLS_KEY: path.join(root, '.local-tls/server-key.pem')
}
const services = [
  { host: '127.0.0.1', port: 18183, script: 'bridge.js' },
  { host: '192.168.0.122', port: 18184, script: 'bridge-lan.js' }
]
function listening (service) {
  return new Promise(resolve => {
    const socket = net.connect({ host: service.host, port: service.port })
    let finished = false
    const done = result => { if (finished) return; finished = true; socket.destroy(); resolve(result) }
    socket.setTimeout(2000, () => done(false))
    socket.once('connect', () => done(true)); socket.once('error', () => done(false))
  })
}
async function tick () {
  let backendHealthy = false
  for (const service of services) {
    if (await listening(service)) {
      if (service.port === 18184 && !backendHealthy) continue
      const healthy = await responds(service)
      if (service.port === 18183) backendHealthy = healthy
      service.failures = healthy ? 0 : (service.failures || 0) + 1
      if (service.failures >= 3) {
        log(`${service.script}: three failed HTTP checks; restarting verified process`)
        await restartVerified(service)
        service.failures = 0
      }
      continue
    }
    if (service.child) continue
    log(`Starting ${service.script}`)
    const child = spawn(process.execPath, [service.script], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    service.child = child
    child.stdout.on('data', b => log(`${service.script}: ${b.toString().trim().slice(0, 2000)}`))
    child.stderr.on('data', b => log(`${service.script}: ${b.toString().trim().slice(0, 2000)}`))
    child.on('error', e => log(e.message))
    child.on('close', code => { log(`${service.script} exited: ${code}`); service.child = null })
  }
  setTimeout(tick, 10000)
}
function responds (service) {
  return new Promise(resolve => {
    let tls
    try { if (service.port === 18184) tls = { ca: readFileSync(path.join(root, '.local-tls/root.pem')) } } catch { resolve(false); return }
    const request = (tls ? https : http).get({ hostname: service.host, port: service.port, path: '/bridge/config', ...tls }, response => {
      response.resume(); resolve(response.statusCode === 200)
    })
    const deadline = setTimeout(() => request.destroy(new Error('Health timeout')), 5000)
    request.on('close', () => clearTimeout(deadline))
    request.on('error', () => resolve(false))
  })
}
function restartVerified (service) {
  if (service.child) { service.child.kill(); return Promise.resolve() }
  // Adopt only the known Torfilms command owning the exact listening port.
  const command = `$c=Get-NetTCPConnection -State Listen -LocalPort ${service.port} -ErrorAction SilentlyContinue; foreach($x in $c){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$x.OwningProcess); if($p.Name -eq 'node.exe' -and $p.CommandLine -match '[\\\\ /\"]${service.script.replace('.', '[.]')}\"?\\s*$'){Write-Output $p.ProcessId}}`
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, timeout: 5000 }, (error, output) => {
    if (!error) for (const pid of output.trim().split(/\s+/)) {
      if (/^\d+$/.test(pid)) try { process.kill(Number(pid)); log(`Stopped unresponsive ${service.script} PID ${pid}`) } catch (e) { log(e.message) }
    }
    resolve()
  }))
}
