'use strict'
/**
 * 命令行客户端的设备指纹。
 *
 * 与浏览器的区别：终端里没有 canvas/UA，但有更硬的身份信号——机器标识。
 * 同一个人在同一台机器上跑 CLI，应当稳定地被认成老用户（不重复要求填昵称）。
 *
 * 采集：主机名 + 平台/架构/内核 + CPU 型号 + 非内网网卡 MAC + 用户名。
 * MAC 取排序后的全集（换网线顺序会变，所以要排序）并过滤虚拟网卡噪音。
 */

const os = require('node:os')
const crypto = require('node:crypto')

/** 与前端 hashFingerprint() 等价：SHA-256 十六进制。服务端会再做一次加盐 HMAC。 */
function hashFingerprint(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex')
}

function macAddresses() {
  const list = []
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (!item || item.internal) continue
      const mac = String(item.mac || '').toLowerCase()
      if (!mac || mac === '00:00:00:00:00:00') continue
      list.push(mac)
    }
  }
  return [...new Set(list)].sort()
}

/**
 * 采集原始指纹串。
 * 每一项都是"同机稳定、异机不同"的信号；不稳定的东西（时间、负载、IP）一律不采，
 * 否则每次运行都会变成新设备，老用户识别就废了。
 */
function collectSignals() {
  const username = (() => {
    try {
      return os.userInfo().username
    } catch {
      return process.env.USER || process.env.USERNAME || 'unknown'
    }
  })()
  const cpus = os.cpus() || []
  return {
    version: 'cli-1',
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpuModel: cpus.length ? String(cpus[0].model).trim() : '',
    cpuCount: cpus.length,
    username,
    macs: macAddresses()
  }
}

function signalsToString(signals) {
  return [
    signals.version,
    signals.hostname,
    signals.platform,
    signals.arch,
    signals.release,
    signals.cpuModel,
    signals.cpuCount,
    signals.username,
    signals.macs.join(',')
  ].join('|')
}

/**
 * 生成要发给服务端的指纹哈希。
 * @param {{override?: string}} [options] override 用于测试/单机模拟多设备
 */
function deviceFingerprint(options = {}) {
  const signals = collectSignals()
  const raw = options.override ? String(options.override) : signalsToString(signals)
  return {
    hash: hashFingerprint(raw),
    source: options.override ? 'override' : 'machine',
    signals
  }
}

module.exports = { deviceFingerprint, hashFingerprint, collectSignals, signalsToString, macAddresses }
