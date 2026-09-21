'use strict'
/**
 * CLI 核心：与浏览器端**同一套 WebSocket 协议**，只是把交互换成终端。
 *
 * 状态机：
 *   connecting → identify（问 /api/session 探指纹）
 *     ├── 命中老设备 → 直接 chatting（免填昵称，和网页端行为一致）
 *     └── 新设备     → 需要在终端输入昵称 → 连上后发 nickname 帧 → chatting
 *
 * 这个文件刻意不碰 readline / process，全部通过 events 表达，
 * 这样集成测试可以直接拿假 socket 驱动它（终端交互留在 bin 里）。
 */

const { EventEmitter } = require('node:events')
const { deviceFingerprint } = require('./fingerprint.js')
const { loadSession, saveSession } = require('./session.js')
const { renderMessage, renderDaySeparator, makePainter } = require('./render.js')

const PROTOCOL_VERSION = 1

class ChatCli extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.serverUrl 形如 http://127.0.0.1:3000
   * @param {string} options.configDir 本地会话目录
   * @param {string} [options.fingerprintOverride] 模拟成另一台设备（测试用）
   * @param {Function} [options.webSocketFactory] 注入用（测试传假实现）
   * @param {Function} [options.fetchImpl]
   */
  constructor(options) {
    super()
    this.serverUrl = String(options.serverUrl).replace(/\/$/, '')
    this.configDir = options.configDir
    this.webSocketFactory = options.webSocketFactory || ((url) => new WebSocket(url))
    this.doFetch = options.fetchImpl || ((...args) => fetch(...args))

    const fp = deviceFingerprint({ override: options.fingerprintOverride })
    this.fingerprint = fp.hash
    this.fingerprintSource = fp.source

    const session = loadSession(this.configDir, this.serverUrl)
    this.session = session
    this.token = session.token || null
    this.nickname = session.nickname || null
    this.user = session.userId ? { id: session.userId, nickname: session.nickname } : null

    this.painter = makePainter(options.color !== false)
    this.width = options.width || 80
    this.state = 'idle'
    this.socket = null
    this.pendingNickname = null
    this.openImages = []
    this.imageHintShown = false
    this.latestMessageId = 0
    this.online = []
  }

  get wsUrl() {
    return `${this.serverUrl.replace(/^http/, 'ws')}/ws`
  }

  setState(next) {
    this.state = next
    this.emit('state', next)
  }

  /** 探指纹：老设备直接进聊天室，新设备要昵称。 */
  async identify() {
    this.setState('connecting')
    let known = false
    let user = null
    try {
      const response = await this.doFetch(`${this.serverUrl}/api/session?h=${encodeURIComponent(this.fingerprint)}`)
      if (response.ok) {
        const payload = await response.json()
        known = Boolean(payload.known)
        user = payload.user || null
      }
    } catch (err) {
      throw new Error(`连不上服务端 ${this.serverUrl}：${err.message}`)
    }

    if (known) {
      this.user = { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl }
      this.nickname = user.nickname
      saveSession(this.configDir, this.serverUrl, { userId: user.id, nickname: user.nickname })
      this.emit('identified', { known: true, user })
      return { known: true, user }
    }

    this.emit('identified', { known: false, user: null })
    return { known: false, user: null }
  }

  /** 建立 WebSocket 并完成 hello。成功后进入 chatting（老设备）或 needs-nickname（新设备）。 */
  connect({ nickname = null, timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false
      const socket = this.webSocketFactory(this.wsUrl)
      this.socket = socket

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`握手超时（${timeoutMs}ms），检查服务端是否可达：${this.wsUrl}`))
      }, timeoutMs)

      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'hello', fpHash: this.fingerprint, token: this.token }))
      }
      socket.onerror = () => {
        const err = new Error(`WebSocket 连接失败：${this.wsUrl}`)
        this.emit('error', err)
        finish(reject, err)
      }
      socket.onclose = () => {
        this.emit('closed')
        if (this.state !== 'closed') this.setState('closed')
        finish(reject, new Error('连接在握手完成前被关闭'))
      }
      socket.onmessage = (event) => {
        let frame
        try {
          frame = JSON.parse(event.data)
        } catch {
          return
        }
        this.handleFrame(frame)
        if (frame.type === 'welcome') {
          if (frame.needsNickname && nickname) {
            socket.send(JSON.stringify({ type: 'nickname', nickname }))
            return
          }
          this.setState('chatting')
          finish(resolve, { known: frame.known, user: frame.user, recent: frame.recent || [] })
        } else if (frame.type === 'onboard' && nickname) {
          socket.send(JSON.stringify({ type: 'nickname', nickname, avatar: frame.avatar }))
        } else if (frame.type === 'registered') {
          this.setState('chatting')
          finish(resolve, { known: true, user: frame.user, recent: [] })
        }
      }
    })
  }

  /** 服务端帧 → 事件（渲染层自己决定怎么显示）。 */
  handleFrame(frame) {
    // 原始帧也抛出去：一次性命令（--say）要等 ack，走这个通用通道
    this.emit('frame', frame)
    switch (frame.type) {
      case 'welcome': {
        this.token = frame.token || this.token
        this.user = frame.user
        this.nickname = frame.user && frame.user.nickname
        this.latestMessageId = frame.latestMessageId || 0
        this.openImages = []
        saveSession(this.configDir, this.serverUrl, {
          token: this.token,
          userId: frame.user && frame.user.id,
          nickname: this.nickname
        })
        this.emit('recent', frame.recent || [])
        this.emit('online', frame.online || [])
        return
      }
      case 'registered':
        this.user = frame.user
        this.nickname = frame.user && frame.user.nickname
        saveSession(this.configDir, this.serverUrl, {
          token: this.token,
          userId: frame.user && frame.user.id,
          nickname: this.nickname
        })
        this.emit('registered', frame.user)
        return
      case 'onboard':
        this.pendingNickname = frame
        this.emit('onboard', frame)
        return
      case 'message':
        this.onMessage(frame.message)
        return
      case 'ack':
        this.onMessage({ ...frame.message, clientId: frame.clientId })
        return
      case 'presence':
        this.emit('online', frame.online || [])
        return
      case 'typing':
        this.emit('typing', frame)
        return
      case 'error':
        this.emit('serverError', frame)
        return
      default:
        return
    }
  }

  onMessage(message) {
    if (!message) return
    if (typeof message.id === 'number' && message.id > this.latestMessageId) this.latestMessageId = message.id
    if (message.imageUrl) this.openImages.push(message.imageUrl)
    this.emit('message', message)
  }

  /** 发一条文本消息。返回 clientId（服务端会用 ack 回同一个 id）。 */
  say(text, clientId = `cli-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`) {
    if (!this.socket || this.socket.readyState !== 1) {
      const err = new Error('还没连上服务器')
      this.emit('error', err)
      return null
    }
    this.socket.send(JSON.stringify({ type: 'message', clientId, text }))
    return clientId
  }

  setNickname(nickname) {
    if (!this.socket || this.socket.readyState !== 1) return false
    this.socket.send(JSON.stringify({ type: 'nickname', nickname }))
    return true
  }

  notifyTyping() {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify({ type: 'typing', on: true }))
    }
  }

  close() {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.close(1000, 'cli exit')
    }
    this.setState('closed')
  }

  /**
   * 渲染一条消息为文本行（供 bin 打印，也供测试断言）。
   * 图片操作提示只在第一次遇到图片时给，之后省略，免得每条图片消息都重复三行。
   */
  formatMessage(message) {
    const lines = renderMessage(message, {
      selfId: this.user && this.user.id,
      width: this.width,
      painter: this.painter,
      baseUrl: this.serverUrl,
      showImageHint: Boolean(message.imageUrl) && !this.imageHintShown
    })
    if (message && message.imageUrl) this.imageHintShown = true
    return lines
  }

  formatDaySeparator(ts) {
    return renderDaySeparator(ts)
  }
}

/**
 * 一次性发言（不发消息就不进交互模式）：
 * 连接 → 必要时设置昵称 → 发文本 → 等 ack → 断开。
 * 用于 `web-chat-cli --say "..."`，也方便脚本/CI 里灌数据。
 */
async function sayOnce(cli, text, { nickname, timeoutMs = 8000 } = {}) {
  await cli.identify()
  const connected = cli.connect({ nickname: nickname || cli.nickname || null, timeoutMs })
  const result = await connected
  if (!cli.nickname && nickname) cli.nickname = nickname
  if (cli.state !== 'chatting') throw new Error('尚未完成注册，无法发言')

  const clientId = cli.say(text)
  if (!clientId) throw new Error('发送失败：连接不可用')
  const ack = await waitForFrame(cli, (m) => m.type === 'ack' && m.clientId === clientId, timeoutMs)
  cli.close()
  return { ack: ack.message, connected: result }
}

function waitForFrame(emitter, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener('frame', onFrame)
      reject(new Error(`等待服务端应答超时（${timeoutMs}ms）`))
    }, timeoutMs)
    function onFrame(frame) {
      if (!predicate(frame)) return
      clearTimeout(timer)
      emitter.removeListener('frame', onFrame)
      resolve(frame)
    }
    emitter.on('frame', onFrame)
  })
}

module.exports = { ChatCli, sayOnce, PROTOCOL_VERSION }
