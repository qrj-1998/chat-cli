#!/usr/bin/env node
'use strict'
/**
 * 命令行聊天室客户端。
 *
 * 与网页端连接同一个服务端、走同一套 WebSocket 协议，身份同样按设备指纹判定：
 * 同一台机器第一次跑要填一次昵称，之后直接进聊天室（和浏览器端行为完全一致）。
 *
 * 用法：
 *   web-chat-cli                                  # 连默认服务器，进入交互模式
 *   web-chat-cli --url http://1.2.3.4:3000        # 指定服务器
 *   web-chat-cli --nick 阿宝                       # 首次运行时直接给昵称，免交互输入
 *   web-chat-cli --say "开会了"                    # 一次性发言后退出（可脚本化）
 *   web-chat-cli --read 20                         # 只打印最近 20 条，不进入交互
 *   web-chat-cli --fp other-device                 # 模拟成另一台设备（换马甲）
 *   web-chat-cli --no-color | head -5              # 非 TTY 时自动关色
 */

const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')

const { ChatCli, sayOnce } = require('../cli.js')
const { defaultConfigDir, clearSession, loadSession } = require('../session.js')

const HELP = `
小动物聊天室 · 命令行版

用法
  web-chat-cli [选项]

选项
  -u, --url <地址>       服务端地址（默认 $WEB_CHAT_URL 或 http://127.0.0.1:3000）
  -n, --nick <昵称>      昵称；新设备首次运行用它可跳过输入提示
      --say <文本>       发一条消息后退出（不进交互模式）
      --read [N]         打印最近 N 条消息后退出（默认 20）
      --fp <字符串>      覆盖设备指纹（模拟另一台设备）
      --config-dir <目录> 会话存档目录（默认 ~/.config/web-chat-cli）
      --no-color         关闭彩色输出
      --reset            清掉本机存档（令牌/昵称），下次按新设备处理
  -h, --help             显示帮助
  -v, --version          显示版本

交互模式下的命令
  /help              帮助
  /nick <昵称>       改昵称
  /users             列出在线的人
  /whoami            我是谁（昵称 / 设备指纹 / 存档路径）
  /open              用浏览器打开最近一张图片
  /day               打印一条记录分隔线（手账感）
  /clear             清屏
  /quit              退出（也可以 Ctrl+C / Ctrl+D）

说明
  身份是按「设备指纹」判定的：同一台机器再进来不会重新要求填昵称。
  令牌只是快速通道，存档删了也不影响识别（--reset 之后仍是同一台设备）。
`.trim()

function parseArgs(argv) {
  const options = {
    url: process.env.WEB_CHAT_URL || 'http://127.0.0.1:3000',
    nick: null,
    say: null,
    read: null,
    fp: null,
    configDir: defaultConfigDir(),
    color: null,
    reset: false,
    help: false,
    version: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '-u':
      case '--url':
        options.url = next()
        break
      case '-n':
      case '--nick':
        options.nick = next()
        break
      case '--say':
        options.say = next()
        break
      case '--read':
        options.read = /^\d+$/.test(argv[i + 1] || '') ? Number(next()) : 20
        break
      case '--fp':
        options.fp = next()
        break
      case '--config-dir':
        options.configDir = next()
        break
      case '--no-color':
        options.color = false
        break
      case '--reset':
        options.reset = true
        break
      case '-h':
      case '--help':
        options.help = true
        break
      case '-v':
      case '--version':
        options.version = true
        break
      default:
        if (arg.startsWith('--url=')) options.url = arg.slice(6)
        else if (arg.startsWith('--nick=')) options.nick = arg.slice(7)
        else if (arg.startsWith('--say=')) options.say = arg.slice(6)
        else if (arg.startsWith('--fp=')) options.fp = arg.slice(5)
        else if (arg.startsWith('--config-dir=')) options.configDir = arg.slice(13)
        else {
          process.stderr.write(`未知参数：${arg}\n用 --help 看用法\n`)
          process.exit(2)
        }
    }
  }
  return options
}

/** 颜色：显式 --no-color 关闭；否则仅在 TTY 上开。 */
function pickColor(options) {
  if (options.color === false) return false
  if (options.color === true) return true
  return Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb'
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${require(path.join(__dirname, '..', '..', 'package.json')).version}\n`)
    return 0
  }

  if (options.reset) {
    const removed = clearSession(options.configDir, options.url)
    process.stdout.write(removed ? '已清掉本机存档（设备指纹不变，仍是同一台设备）\n' : '没有找到可清的存档\n')
  }

  const cli = new ChatCli({
    serverUrl: options.url,
    configDir: options.configDir,
    fingerprintOverride: options.fp,
    color: pickColor(options),
    width: process.stdout.columns || 80
  })

  if (options.read !== null) return runRead(cli, options)
  if (options.say !== null) return runSay(cli, options)
  return runInteractive(cli, options)
}

/* ---------- 一次性模式 ---------- */

async function runRead(cli, options) {
  const limit = Math.max(1, Math.min(Number(options.read) || 20, 200))
  const response = await fetch(`${cli.serverUrl}/api/messages?limit=${limit}`)
  if (!response.ok) {
    process.stderr.write(`读取失败：HTTP ${response.status}\n`)
    return 1
  }
  const payload = await response.json()
  const messages = payload.messages || []
  if (!messages.length) {
    process.stdout.write('（还没有任何消息）\n')
    return 0
  }
  let lastDay = null
  for (const message of messages) {
    const day = new Date(message.createdAt).toDateString()
    if (day !== lastDay) {
      process.stdout.write(`${cli.formatDaySeparator(message.createdAt)}\n`)
      lastDay = day
    }
    process.stdout.write(`${cli.formatMessage(message).join('\n')}\n`)
  }
  return 0
}

async function runSay(cli, options) {
  const result = await sayOnce(cli, options.say, { nickname: options.nick })
  process.stdout.write(`已发送（id=${result.ack.id}）：${options.say}\n`)
  return 0
}

/* ---------- 交互模式 ---------- */

async function runInteractive(cli, options) {
  const out = (text) => process.stdout.write(`${text}\n`)
  const err = (text) => process.stderr.write(`${text}\n`)

  const identity = await cli.identify()
  if (identity.known) {
    out(`认得这台设备：${identity.user.nickname}（免填昵称）`)
  } else {
    out('这是一台新设备，先起个昵称吧。')
  }

  let nickname = options.nick || cli.nickname
  if (!identity.known && !nickname) {
    nickname = await askOnce('昵称：')
    if (!nickname) {
      err('没有昵称就没法进聊天室')
      return 1
    }
  }

  out(`正在连接 ${cli.serverUrl} …`)
  await cli.connect({ nickname })
  out(`已进入聊天室，当前身份：${cli.nickname}`)
  out('输入内容回车发送；/help 看命令；Ctrl+C 退出。')
  out('')

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' })
    let lastDay = new Date().toDateString()

    const printLines = (lines) => {
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)
      for (const line of lines) out(line)
      rl.prompt(true)
    }

    // 历史消息先铺一遍，接着进入实时模式
    const seen = new Set()
    const printMessage = (message) => {
      if (seen.has(message.id)) return
      seen.add(message.id)
      const day = new Date(message.createdAt).toDateString()
      const lines = []
      if (day !== lastDay) {
        lines.push(cli.formatDaySeparator(message.createdAt))
        lastDay = day
      }
      lines.push(...cli.formatMessage(message))
      printLines(lines)
    }

    cli.on('message', printMessage)
    cli.on('typing', (frame) => {
      if (frame.on && frame.nickname) printLines([`  ${cli.painter.gray(`${frame.nickname} 正在输入…`)}`])
    })
    cli.on('online', (users) => {
      cli.online = users
    })
    cli.on('serverError', (frame) => {
      printLines([`  ${cli.painter.red(`服务器提示：${frame.message}`)}`])
    })
    cli.on('closed', () => {
      printLines([`  ${cli.painter.yellow('连接已断开')}`])
      rl.close()
      resolve(0)
    })

    const handleCommand = (line) => {
      const [command, ...rest] = line.trim().split(/\s+/)
      const argument = rest.join(' ')
      switch (command) {
        case '/help':
          out(HELP)
          return
        case '/nick':
          if (!argument) {
            out('用法：/nick 新昵称')
            return
          }
          cli.setNickname(argument)
          out(`已请求改名为「${argument}」`)
          return
        case '/users':
          out(cli.online.length ? cli.online.map((u) => `${u.nickname}${u.id === (cli.user && cli.user.id) ? '（我）' : ''}`).join('、') : '（只有你）')
          return
        case '/whoami':
          out(`昵称      ：${cli.nickname || '未设置'}`)
          out(`设备指纹  ：${cli.fingerprint.slice(0, 24)}…（来源 ${cli.fingerprintSource}）`)
          out(`存档      ：${loadSession(options.configDir, options.url).file}`)
          out(`服务端    ：${cli.serverUrl}`)
          return
        case '/open': {
          const last = cli.openImages[cli.openImages.length - 1]
          if (!last) {
            out('这条会话里还没有人发过图片')
            return
          }
          const url = `${cli.serverUrl}${last}`
          openInBrowser(url)
          out(`已在浏览器打开：${url}`)
          return
        }
        case '/day':
          out(cli.formatDaySeparator(Date.now()))
          return
        case '/clear':
          process.stdout.write('\u001b[2J\u001b[H')
          return
        case '/quit':
        case '/exit':
          cli.close()
          rl.close()
          resolve(0)
          return
        default:
          out(`未知命令：${command}（用 /help 看用法）`)
      }
    }

    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) {
        rl.prompt()
        return
      }
      if (text.startsWith('/')) {
        handleCommand(text)
        rl.prompt()
        return
      }
      const clientId = cli.say(text)
      if (!clientId) err('发送失败：连接不可用')
      rl.prompt()
    })

    rl.on('close', () => {
      cli.close()
      resolve(0)
    })

    process.on('SIGINT', () => {
      out('')
      cli.close()
      rl.close()
      resolve(0)
    })

    rl.prompt()
  })
}

/** 单次提问（只为拿昵称，用独立的 readline）。 */
function askOnce(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(String(answer || '').trim())
    })
  })
}

/** 尽力在图形环境里打开 URL；无图形环境就静默跳过（终端里仍能看到链接）。 */
function openInBrowser(url) {
  const platform = os.platform()
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* 没图形环境就只留链接 */
  }
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    process.stderr.write(`出错了：${err.message}\n`)
    process.exit(1)
  })
