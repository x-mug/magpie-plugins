// 盯住 magpie 的用量账本：按客户端/模型算实时与往期命中率，偏低时提醒，并把看板数据写给插件页面。
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE_DIR = path.join(HERE, "page")

const DEFAULTS = {
  enabled: true,
  pollSec: 10,
  threshold: 0.8,
  consecutive: 5,
  minPrompt: 15000,
  minRequests: 10,
  cooldownSec: 1800,
  maxAlertsPerHour: 6,
  notify: "toast",
  backfillHours: 0,
  ignore: [],
}

const RANGES = [
  { id: "1h", label: "1 小时", ms: 3600 * 1000 },
  { id: "today", label: "今天", today: true },
  { id: "7d", label: "7 天", ms: 7 * 24 * 3600 * 1000 },
  { id: "30d", label: "30 天", ms: 30 * 24 * 3600 * 1000 },
]

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined)

/// <summary>
/// 命中率按账本口径计算：缓存读取占全部 prompt token。
/// </summary>
function hitOf(row) {
  const read = num(row.cache_read) ?? 0
  const input = num(row.in) ?? 0
  const write = num(row.cache_write) ?? 0
  const prompt = input + read + write
  return { prompt, read, write, hit: prompt > 0 ? read / prompt : 0 }
}

/// <summary>
/// 按宿主用量页选取可测的输出与生成时段，剔除隐藏推理和集中回传的不可靠计时。
/// </summary>
function timedOf(row) {
  if (!row || typeof row !== "object" || Number(row.status) >= 400 || row.err) return null
  const out = num(row.out)
  const ms = num(row.ms)
  const ttft = num(row.ttft_ms)
  const reasoning = num(row.reasoning) ?? 0
  const firstText = num(row.first_text_ms) ?? 0
  const firstReasoning = num(row.first_reasoning_ms) ?? 0
  const flow = num(row.flow_ms) ?? 0
  if (![out, ms, ttft].every(Number.isFinite) || ttft <= 0) return null
  if (row.reasoning_hidden && firstText <= 0) return null
  const think = reasoning > 0
  const visible = think && firstText <= 0 && firstReasoning >= ttft && flow > 0 && reasoning <= out
  const tokens = think && !visible ? out - reasoning : out
  const from = visible ? firstReasoning : think ? firstText : ttft
  const decodeMs = ms - from
  if (!(tokens > 0 && from > 0 && decodeMs >= 100 && tokens * 1000 <= 10000 * decodeMs)) return null
  if (flow > 0 && flow * 4 < decodeMs) return null
  if (think && firstText > 0 && tokens * (firstText - ttft) > 20 * reasoning * decodeMs) return null
  if (row.source === "log" && row.agent === "codex" && (decodeMs < 1000 || tokens < 100)) return null
  return { tokens, decodeMs }
}

/// <summary>
/// 归一化一条账本记录，看板统计不看阈值，只看是否成功。
/// </summary>
function sampleRow(row) {
  if (!row || typeof row !== "object") return null
  if (row.status !== undefined && Number(row.status) !== 200) return null
  const provider = row.provider ?? "?"
  const agent = row.agent ?? "?"
  const model = row.model ?? "?"
  const key = `${provider}/${agent}/${model}`
  const { prompt, read, write, hit } = hitOf(row)
  return {
    key,
    provider,
    agent,
    model,
    t: Date.parse(row.t) || Date.now(),
    prompt,
    read,
    write,
    hit,
    timed: timedOf(row),
    session: row.session || row.native_session || "",
  }
}

const tpsOf = (tokens, decodeMs) => (decodeMs > 0 ? (tokens * 1000) / decodeMs : null)

/// <summary>
/// 一个范围的起点：今天按本机零点算，其余从当前时间往回推。
/// </summary>
function cutoffOf(range, now) {
  if (!range.today) return now - range.ms
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return start.getTime()
}

/// <summary>
/// 影响样本队列的配置指纹，过滤条件变了就整份重算。
/// </summary>
function configSignature(cfg) {
  return `${cfg.minPrompt}|${(cfg.ignore || []).join(",")}`
}

/// <summary>
/// 账本当前字节数，读不到按 0 处理，用来判断是否被截断或轮转。
/// </summary>
function ledgerSize(ledger) {
  try {
    return fs.statSync(ledger).size
  } catch {
    return 0
  }
}

/// <summary>
/// 单遍原地压缩，去掉所有早于起点的样本；账本时间可能乱序，不能按头部有序假设剪枝。
/// </summary>
function pruneQueue(queue, cutoff) {
  let keep = 0
  for (let i = 0; i < queue.length; i += 1) {
    const sample = queue[i]
    if (sample.t >= cutoff) {
      queue[keep] = sample
      keep += 1
    }
  }
  queue.length = keep
}

/// <summary>
/// 把一条样本放进起点仍然有效的各范围队列。
/// </summary>
function pushSample(state, sample, now) {
  for (const range of RANGES) {
    if (sample.t < cutoffOf(range, now)) continue
    state.queues[range.id].push(sample)
  }
}

/// <summary>
/// 把一个时间窗内的样本聚合成页面结构，计时、写入都只报实测到的正数观测。
/// </summary>
function summarize(samples, cfg) {
  const groups = new Map()
  let requests = 0
  let read = 0
  let write = 0
  let prompt = 0
  let replies = 0
  let tokens = 0
  let decodeMs = 0
  for (const sample of samples) {
    requests += 1
    read += sample.read
    write += sample.write
    prompt += sample.prompt
    if (sample.timed) {
      replies += 1
      tokens += sample.timed.tokens
      decodeMs += sample.timed.decodeMs
    }
    let acc = groups.get(sample.key)
    if (!acc) {
      acc = { provider: sample.provider, agent: sample.agent, model: sample.model, count: 0, read: 0, write: 0, prompt: 0, replies: 0, tokens: 0, decodeMs: 0, writeMax: 0 }
      groups.set(sample.key, acc)
    }
    acc.count += 1
    acc.read += sample.read
    acc.write += sample.write
    acc.prompt += sample.prompt
    if (sample.timed) {
      acc.replies += 1
      acc.tokens += sample.timed.tokens
      acc.decodeMs += sample.timed.decodeMs
    }
    if (sample.write > acc.writeMax) acc.writeMax = sample.write
  }
  const listed = []
  let hidden = 0
  let writeZeroGroups = 0
  for (const acc of groups.values()) {
    if (acc.writeMax === 0) writeZeroGroups += 1
    if (acc.count < (cfg.minRequests ?? 10)) {
      hidden += 1
      continue
    }
    listed.push({
      provider: acc.provider,
      agent: acc.agent,
      model: acc.model,
      count: acc.count,
      read: acc.read,
      write: acc.write,
      prompt: acc.prompt,
      hit: acc.prompt > 0 ? (100 * acc.read) / acc.prompt : 0,
      replies: acc.replies,
      tokens: acc.tokens,
      decodeMs: acc.decodeMs,
      tps: tpsOf(acc.tokens, acc.decodeMs),
      coverage: acc.count > 0 ? acc.replies / acc.count : 0,
      writeMax: acc.writeMax,
    })
  }
  listed.sort((a, b) => a.hit - b.hit || b.count - a.count)
  return {
    requests,
    read,
    write,
    prompt,
    hit: prompt > 0 ? (100 * read) / prompt : 0,
    hidden,
    writeSeen: write > 0,
    writeZeroGroups,
    speed: {
      replies,
      tokens,
      decodeMs,
      tps: tpsOf(tokens, decodeMs),
      requests,
      coverage: requests > 0 ? replies / requests : 0,
    },
    groups: listed,
  }
}

/// <summary>
/// 告警用的样本：在看板样本基础上按 token 下限和忽略前缀过滤。
/// </summary>
function toSample(row, cfg) {
  const sample = sampleRow(row)
  if (!sample) return null
  if (cfg.ignore?.some((p) => sample.key.startsWith(p))) return null
  if (sample.prompt < cfg.minPrompt) return null
  return sample
}

const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor((s.length - 1) / 2)]
}

/// <summary>
/// 判断最近 N 次请求是否连续低于阈值，返回告警内容或 null。
/// </summary>
function evaluate(samples, cfg) {
  const n = Math.max(2, cfg.consecutive)
  if (samples.length < n) return null
  const tail = samples.slice(-n)
  if (!tail.every((s) => s.hit < cfg.threshold)) return null
  const hit = tail.reduce((a, s) => a + s.hit, 0) / n
  const reads = median(tail.map((s) => s.read))
  const prompts = median(tail.map((s) => s.prompt))
  const writes = median(tail.map((s) => s.write))
  const noSession = tail.every((s) => !s.session)
  const hints = []
  if (writes > reads) hints.push("每轮重写缓存")
  if (reads < 6000 && prompts > 20000) hints.push("只复用固定小前缀")
  if (noSession) hints.push("客户端没报会话")
  const name = tail[0].key
  const rule = { threshold: cfg.threshold, consecutive: n, minPrompt: cfg.minPrompt }
  const observed = {
    requests: tail.length,
    belowThreshold: tail.filter((s) => s.hit < rule.threshold).length,
    hitMin: Math.min(...tail.map((s) => s.hit)),
    hitMax: Math.max(...tail.map((s) => s.hit)),
    promptMin: Math.min(...tail.map((s) => s.prompt)),
  }
  const detail = `最近 ${n} 次平均命中 ${(hit * 100).toFixed(1)}%（阈值 ${(rule.threshold * 100).toFixed(1)}%），连续低于阈值 ${observed.belowThreshold}/${n} 次，读中位 ${reads}，prompt 中位 ${prompts}`
  return { key: name, hit, reads, prompts, writes, hints, rule, observed, message: `${name} 缓存命中偏低：${detail}${hints.length ? "；" + hints.join("、") : ""}` }
}

/// <summary>
/// 把账本文本切成完整行，返回行数组和未结束的尾巴。
/// </summary>
function splitLines(text) {
  const lines = text.split("\n")
  const rest = lines.pop() ?? ""
  return { lines: lines.filter((l) => l.trim()), rest }
}

/// <summary>
/// 读出上次位置之后的新记录；账本被截断时清掉半行缓存并交给调用方整份重建。
/// </summary>
function readNew(ledger, state) {
  let size = 0
  try {
    size = fs.statSync(ledger).size
  } catch {
    return []
  }
  if (size < state.offset) {
    state.offset = 0
    state.pending = ""
    return []
  }
  if (size === state.offset) return []
  const fd = fs.openSync(ledger, "r")
  try {
    const len = size - state.offset
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, state.offset)
    state.offset = size
    const { lines, rest } = splitLines(state.pending + buf.toString("utf8"))
    state.pending = rest
    const out = []
    for (const line of lines) {
      try {
        out.push(JSON.parse(line))
      } catch {
        // 账本偶尔有半行，跳过。
      }
    }
    return out
  } finally {
    fs.closeSync(fd)
  }
}

/// <summary>
/// 整份账本重新统计，刷新时用，末尾未写完的半行留到下一次增量读取。
/// </summary>
function rescan(ledger, state, cfg) {
  let buf
  try {
    buf = fs.readFileSync(ledger)
  } catch {
    buf = Buffer.alloc(0)
  }
  for (const queue of Object.values(state.queues)) queue.length = 0
  state.offset = buf.length
  const { lines, rest } = splitLines(buf.toString("utf8"))
  state.pending = rest
  const now = Date.now()
  for (const line of lines) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const sample = toSample(row, cfg)
    if (sample) pushSample(state, sample, now)
  }
}

function log(input, level, message) {
  try {
    input?.client?.app?.log?.({ body: { service: "cache-guard", level, message } })
  } catch {
    // 老版本宿主没有这个接口，忽略。
  }
}

/// <summary>
/// 读取本插件在 plugins.json 里的选项，页面保存后下一次轮询即生效。
/// </summary>
function loadOptions(input, boot) {
  const base = { ...DEFAULTS, ...(boot || {}) }
  try {
    const file = path.join(input.directory || path.join(os.homedir(), ".config", "magpie"), "plugins.json")
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    const entry = (raw.plugins || []).find((plugin) => {
      const spec = String(plugin?.spec || "")
      if (/^magpie-cache-guard(?:@[^/]+)?$/.test(spec)) return true
      try {
        const directory = spec.startsWith("file:") ? fileURLToPath(spec) : spec
        return fs.realpathSync(directory) === fs.realpathSync(HERE)
      } catch { return false }
    })
    if (entry?.options && typeof entry.options === "object") Object.assign(base, entry.options)
  } catch {
    // 读不到就用默认值。
  }
  if (base.threshold > 1) base.threshold = base.threshold / 100
  return base
}

const TOAST_PS1 = String.raw`param([string]$Title, [string]$Message)
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $template.GetElementsByTagName("text")
  $texts.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
  $texts.Item(1).AppendChild($template.CreateTextNode($Message)) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("magpie cache guard").Show($toast)
} catch {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Warning
    $icon.Visible = $true
    $icon.ShowBalloonTip(8000, $Title, $Message, [System.Windows.Forms.ToolTipIcon]::Warning)
    Start-Sleep -Seconds 2
    $icon.Dispose()
  } catch {}
}`

/// <summary>
/// 先写日志，再交给 magpie 弹提示；notify 为 os 时额外弹系统通知。
/// </summary>
async function notify(input, cfg, alert) {
  log(input, "warn", alert.message)
  if (cfg.notify === "log") return
  try {
    input?.client?.tui?.showToast?.({ body: { title: "magpie 缓存告警", message: alert.message.slice(0, 300), variant: "warning" } })
  } catch {
    // 宿主不支持 toast 时只留日志。
  }
  if (cfg.notify !== "os") return
  const dir = path.join(input.directory || path.join(os.homedir(), ".config", "magpie"), "cache-guard")
  try {
    fs.mkdirSync(dir, { recursive: true })
    const script = path.join(dir, "toast.ps1")
    if (!fs.existsSync(script)) fs.writeFileSync(script, TOAST_PS1)
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Title", "magpie 缓存告警", "-Message", alert.message.slice(0, 300)]
    if (typeof Bun !== "undefined") {
      Bun.spawn(["powershell.exe", ...args], { stdout: "ignore", stderr: "ignore", windowsHide: true })
    } else {
      const { spawn } = await import("node:child_process")
      spawn("powershell.exe", args, { windowsHide: true, stdio: "ignore", detached: true }).unref()
    }
  } catch {
    // 弹窗失败不影响记录。
  }
}

/// <summary>
/// 写一条告警到历史文件，方便回看。
/// </summary>
function persist(input, alert) {
  try {
    const dir = path.join(input.directory || path.join(os.homedir(), ".config", "magpie"), "cache-guard")
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, "alerts.jsonl"), JSON.stringify({ t: new Date().toISOString(), ...alert }) + "\n")
  } catch {
    // 落盘失败不阻塞告警。
  }
}

/// <summary>
/// 把一个范围整理成页面直接可用的结构，出窗样本先丢掉再聚合。
/// </summary>
function rangePayload(state, range, cfg, now) {
  const queue = state.queues[range.id]
  pruneQueue(queue, cutoffOf(range, now))
  return { id: range.id, label: range.label, ...summarize(queue, cfg) }
}

/// <summary>
/// 组装看板数据，不碰文件，测试可直接调用。
/// </summary>
function buildPayload(state, cfg, now) {
  return {
    updatedAt: new Date(now).toISOString(),
    startedAt: new Date(state.startedAt).toISOString(),
    ranges: RANGES.map((range) => rangePayload(state, range, cfg, now)),
    alerts: state.recent.slice(-20).reverse(),
    speedMethod: "magpie-decode-v1",
    config: {
      threshold: cfg.threshold,
      consecutive: cfg.consecutive,
      minPrompt: cfg.minPrompt,
      minRequests: cfg.minRequests,
      pollSec: cfg.pollSec,
      cooldownSec: cfg.cooldownSec,
      maxAlertsPerHour: cfg.maxAlertsPerHour,
      notify: cfg.notify,
      ignore: cfg.ignore,
    },
  }
}

/// <summary>
/// 把当前配置、各时间范围的统计和最近告警写成页面可加载的脚本。
/// </summary>
function writeState(state, cfg) {
  const payload = buildPayload(state, cfg, Date.now())
  try {
    fs.mkdirSync(PAGE_DIR, { recursive: true })
    const file = path.join(PAGE_DIR, "state.js")
    const tmp = file + ".tmp"
    fs.writeFileSync(tmp, `window.__cacheGuardState = ${JSON.stringify(payload)}\n`)
    fs.renameSync(tmp, file)
  } catch {
    // 页面状态写不出去不影响告警。
  }
}

const STARTED = new Set()

/// <summary>
/// 启动监视器：增量统计实时范围，刷新时整份重算，并把看板数据写给页面。
/// </summary>
export const CacheGuardPlugin = async (input, options) => {
  const boot = loadOptions(input, options)
  if (!boot.enabled) return {}

  const ledger = path.join(input.directory || path.join(os.homedir(), ".config", "magpie"), "usage.jsonl")
  if (STARTED.has(ledger)) return {}
  STARTED.add(ledger)

  const state = {
    offset: 0,
    pending: "",
    startedAt: Date.now(),
    samples: new Map(),
    lastAlert: new Map(),
    rate: [],
    recent: [],
    queues: { "1h": [], today: [], "7d": [], "30d": [] },
  }

  const signature = configSignature
  let currentSignature = signature(boot)

  rescan(ledger, state, boot)

  const tick = () => {
    const cfg = loadOptions(input, options)
    // 账本被截断或轮转时整份重建，避免旧队列继续累加出重复样本。
    if (ledgerSize(ledger) < state.offset) {
      currentSignature = signature(cfg)
      rescan(ledger, state, cfg)
      writeState(state, cfg)
      return
    }
    if (signature(cfg) !== currentSignature) {
      currentSignature = signature(cfg)
      rescan(ledger, state, cfg)
    }
    const now = Date.now()
    for (const row of readNew(ledger, state)) {
      const sample = toSample(row, cfg)
      if (!sample) continue
      pushSample(state, sample, now)

      const list = state.samples.get(sample.key) || []
      list.push(sample)
      while (list.length > Math.max(cfg.consecutive * 4, 20)) list.shift()
      state.samples.set(sample.key, list)

      const alert = evaluate(list, cfg)
      if (!alert) continue
      const last = state.lastAlert.get(alert.key) || 0
      if (Date.now() - last < cfg.cooldownSec * 1000) continue
      const hourAgo = Date.now() - 3600 * 1000
      state.rate = state.rate.filter((t) => t > hourAgo)
      if (state.rate.length >= cfg.maxAlertsPerHour) continue
      state.rate.push(Date.now())
      state.lastAlert.set(alert.key, Date.now())
      state.recent.push({ t: new Date().toISOString(), ...alert })
      while (state.recent.length > 50) state.recent.shift()
      persist(input, alert)
      notify(input, cfg, alert)
    }
    writeState(state, cfg)
  }

  tick()
  let lastTick = Date.now()

  // 每秒看一眼：到了刷新周期就跑一轮，页面点「刷新」则整份重算。
  let seenRefresh = Number(boot._refreshAt) || 0
  const loop = setInterval(() => {
    const cfg = loadOptions(input, options)
    const at = Number(cfg._refreshAt) || 0
    if (at > seenRefresh) {
      seenRefresh = at
      // 手动刷新已整份重算，指纹同步落账，避免下一轮再白扫一次。
      currentSignature = signature(cfg)
      rescan(ledger, state, cfg)
      writeState(state, cfg)
      lastTick = Date.now()
      return
    }
    if (Date.now() - lastTick < Math.max(2, Number(cfg.pollSec) || 10) * 1000) return
    lastTick = Date.now()
    tick()
  }, 1000)
  if (loop && typeof loop.unref === "function") loop.unref()

  return {}
}

/// <summary>
/// 导出给测试用的纯函数。
/// </summary>
export const _internal = {
  hitOf,
  toSample,
  evaluate,
  splitLines,
  timedOf,
  tpsOf,
  cutoffOf,
  configSignature,
  ledgerSize,
  loadOptions,
  readNew,
  rescan,
  pruneQueue,
  pushSample,
  summarize,
  rangePayload,
  buildPayload,
  DEFAULTS,
  RANGES,
}
