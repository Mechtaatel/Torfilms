// Local-only, in-memory browser integration fixture. Never uses the live catalog.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import mime from 'mime-types'
const root = path.resolve('public/p2p')
const fixture = await new Promise((resolve, reject) => {
  const child = spawn('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=40', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=40', '-map', '0:v', '-map', '1:a', '-map', '1:a', '-c:v', 'libx264', '-g', '50', '-bf', '2', '-c:a:0', 'aac', '-c:a:1', 'flac', '-ar:a:1', '96000', '-sample_fmt:a:1', 's32', '-ac:a:1', '2', '-f', 'matroska', 'pipe:1'], { windowsHide: true })
  const chunks = []; let error = ''
  child.stdout.on('data', b => chunks.push(b)); child.stderr.on('data', b => { error += b }); child.on('error', reject); child.on('close', code => code ? reject(new Error(error)) : resolve(Buffer.concat(chunks)))
})
const html = `<!doctype html><meta charset="utf-8"><title>Local remux check</title><video controls width="640"></video><p><button id="start">Start AAC</button><button id="flac">Start FLAC</button><button id="seek">Seek 23.3</button><button id="stop">Stop</button></p><pre id="status"></pre><script type="module">
import {startLocalRemux} from '/local-remux.js';
const bytes=new Uint8Array(await(await fetch('/fixture')).arrayBuffer());
const file={length:bytes.length, [Symbol.asyncIterator]({start,end}){return (async function*(){yield bytes.subarray(start,end+1)})()}};
const video=document.querySelector('video'),status=document.querySelector('#status');let player,audio=1;
function start(position=0){player?.destroy();player=startLocalRemux(video,{torrent:{files:[file]},fileIndex:0,track:{id:'local:'+audio},duration:40,position,resume:true,onMetadata:m=>status.textContent='metadata '+m.duration,onSeek:time=>start(time),onReady:()=>status.textContent='playing',onError:e=>status.textContent='ERROR '+e.message});}
document.querySelector('#start').onclick=()=>{audio=1;start()};document.querySelector('#flac').onclick=()=>{audio=2;start()};document.querySelector('#seek').onclick=()=>start(23.3);document.querySelector('#stop').onclick=()=>{player?.destroy();video.pause();status.textContent='stopped'};
</script>`
const server = http.createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return }
  if (req.url === '/fixture') { res.end(fixture); return }
  const target = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname))
  if (!target.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return }
  try { res.setHeader('Content-Type', mime.lookup(target) || 'application/octet-stream'); res.end(await readFile(target)) } catch { res.writeHead(404); res.end() }
})
server.listen(18189, '127.0.0.1', () => console.log('Remux fixture: http://127.0.0.1:18189/'))
