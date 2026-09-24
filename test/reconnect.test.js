'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { test } = require('node:test')

function sendFrame(socket, value) {
  const payload = Buffer.from(JSON.stringify(value))
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
  socket.write(Buffer.concat([header, payload]))
}

test('交互模式断线后自动重连，退出时正常结束', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-chat-reconnect-'))
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }))

  let connections = 0
  const opcodes = []
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ known: true, user: { id: 1, nickname: 'Tester' } }))
  })
  server.on('upgrade', (req, socket) => {
    connections += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 2) {
        const opcode = pending[0] & 0x0f
        opcodes.push(opcode)
        const masked = Boolean(pending[1] & 0x80)
        let length = pending[1] & 0x7f
        let headerLength = 2
        if (length === 126) {
          if (pending.length < 4) return
          length = pending.readUInt16BE(2)
          headerLength = 4
        }
        const frameLength = headerLength + (masked ? 4 : 0) + length
        if (pending.length < frameLength) return
        pending = pending.subarray(frameLength)
        if (opcode === 0x08) {
          socket.write(Buffer.from([0x88, 0x00]))
          socket.end()
        }
      }
    })
    const accept = crypto.createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    sendFrame(socket, {
      type: 'welcome', known: true, user: { id: 1, nickname: 'Tester' },
      recent: [], latestMessageId: 0
    })
    if (connections === 1) setTimeout(() => socket.destroy(), 100)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'bin', 'web-chat-cli.js'),
    '--url', `http://127.0.0.1:${server.address().port}`,
    '--config-dir', configDir,
    '--no-color'
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => {
    child.kill()
    for (const socket of sockets) socket.destroy()
    server.close()
  })

  let output = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待重连超时：${output}\n${stderr}`)), 5000)
    child.stdout.on('data', () => {
      if (!output.includes('连接已恢复')) return
      clearTimeout(timer)
      resolve()
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`进程提前退出 (${code})：${output}\n${stderr}`))
    })
  })

  child.stdin.write('/quit\n')
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`退出超时：frames=${opcodes.join(',')} sockets=${sockets.size}\n${output}\n${stderr}`)), 4000)
    child.once('exit', (exitCode) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })
  assert.equal(code, 0, stderr)
  assert.equal(connections, 2)
  assert.match(output, /连接已断开/)
  assert.match(output, /连接已恢复/)
})
