// 纯函数自检：速度口径、窗口滚动、半行/截断账本、写入观测，全程不碰真实账本与页面状态。
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { _internal } from "../index.mjs"

if (process.argv.some((a) => a.startsWith("--ledger"))) {
  console.error("真实账本校验在 backend-real.mjs：node verification/backend-real.mjs --range=30d [--json]")
  process.exit(2)
}

const { hitOf, toSample, evaluate, splitLines, timedOf, tpsOf, cutoffOf, configSignature, ledgerSize, readNew, rescan, pruneQueue, pushSample, summarize, rangePayload, buildPayload, DEFAULTS, RANGES } = _internal

const cfg = { ...DEFAULTS, minRequests: 1, minPrompt: 0, pollSec: 10 }
const ISO = (ms) => new Date(ms).toISOString()
const at = (msAgo, extra) => ({ t: ISO(Date.now() - msAgo), status: 200, in: 0, out: 0, cache_read: 0, cache_write: 0, ms: 0, provider: "p", agent: "a", model: "m", ...extra })

const fresh = () => ({ offset: 0, pending: "", startedAt: Date.now(), samples: new Map(), lastAlert: new Map(), rate: [], recent: [], queues: { "1h": [], today: [], "7d": [], "30d": [] } })
const ingest = (state, rows, now = Date.now()) => {
  for (const row of rows) {
    const sample = toSample(row, cfg)
    if (sample) pushSample(state, sample, now)
  }
  return state
}

const results = []
const test = (name, fn) => {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
  }
}
const withLedger = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-guard-"))
  try {
    fn(path.join(dir, "usage.jsonl"), dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// --- 1. 速度口径 -------------------------------------------------------------
test("无推理回复按可测输出与生成时长加权，且逐项过滤", () => {
  const good = [at(60000, { out: 100, ms: 1000, ttft_ms: 500 }), at(50000, { out: 300, ms: 2000, ttft_ms: 1000 })]
  const bad = [
    at(40000, { out: 0, ms: 1000, ttft_ms: 500 }),
    at(30000, { out: 100, ms: 1000, ttft_ms: 0 }),
    at(20000, { out: 100, ms: 1000, ttft_ms: 1000 }),
    at(10000, { out: 100, ms: 900, ttft_ms: 1200 }),
  ]
  for (const row of bad) assert.equal(timedOf(row), null, "不该计入计时：" + JSON.stringify(row))
  const range = rangePayload(ingest(fresh(), [...good, ...bad]), RANGES[2], cfg, Date.now())
  assert.equal(range.speed.replies, 2)
  assert.equal(range.speed.tokens, 400)
  assert.equal(range.speed.decodeMs, 1500)
  assert.equal(range.speed.tps, (400 * 1000) / 1500)
  assert.equal(range.speed.requests, 6)
  assert.equal(range.speed.coverage, 2 / 6)
})

test("非 200 记录整条不进统计", () => {
  assert.equal(toSample(at(1000, { status: 499, out: 100, ms: 1000, ttft_ms: 100 }), cfg), null)
  const range = rangePayload(ingest(fresh(), [at(1000, { status: 499, out: 100, ms: 1000, ttft_ms: 100 }), at(900, { out: 10, ms: 500, ttft_ms: 100 })]), RANGES[2], cfg, Date.now())
  assert.equal(range.requests, 1)
  assert.equal(range.speed.replies, 1)
})

test("tps 分母非正时返回 null 而不是 Infinity", () => {
  assert.equal(tpsOf(100, 0), null)
  assert.equal(tpsOf(0, 100), 0)
  assert.equal(tpsOf(250, 1000), 250)
})

test("有首正文时只计正文 token 和正文生成时间", () => {
  assert.deepEqual(timedOf(at(0, {out:1000,reasoning:700,ms:6000,ttft_ms:1000,first_text_ms:3000,flow_ms:3000,reasoning_hidden:true})),{tokens:300,decodeMs:3000})
  assert.equal(timedOf(at(0, {out:1000,reasoning:700,ms:6000,ttft_ms:1000,reasoning_hidden:true})),null)
})

test("无首正文时要求可见推理与持续流证据", () => {
  const row = at(0,{out:1000,reasoning:700,ms:6000,ttft_ms:1000,first_reasoning_ms:1200,flow_ms:4800})
  assert.deepEqual(timedOf(row),{tokens:1000,decodeMs:4800})
  assert.equal(timedOf({...row,flow_ms:0}),null)
  assert.equal(timedOf({...row,first_reasoning_ms:900}),null)
  assert.equal(timedOf({...row,reasoning_hidden:true}),null)
})

test("计时剔除短窗口、速度异常及集中回传，并保留边界", () => {
  const row=at(0,{out:100,ms:1100,ttft_ms:1000,flow_ms:25})
  assert.deepEqual(timedOf(row),{tokens:100,decodeMs:100})
  assert.equal(timedOf({...row,ms:1099}),null)
  assert.equal(timedOf({...row,out:1001}),null)
  assert.equal(timedOf({...row,flow_ms:24}),null)
  const think=at(0,{out:300,reasoning:100,ms:3100,ttft_ms:1000,first_text_ms:3000,flow_ms:100})
  assert.equal(timedOf(think),null)
  assert.deepEqual(timedOf({...think,first_text_ms:2000,ms:2100}),{tokens:200,decodeMs:100})
})

test("错误回复和会话文件中不足以测速的 Codex 回合不参与计时", () => {
  const row=at(0,{out:100,ms:2000,ttft_ms:1000,source:"log",agent:"codex"})
  assert.deepEqual(timedOf(row),{tokens:100,decodeMs:1000})
  assert.equal(timedOf({...row,ms:1999}),null)
  assert.equal(timedOf({...row,out:99}),null)
  assert.equal(timedOf({...row,err:"failed"}),null)
  assert.equal(timedOf({...row,status:400}),null)
  assert.equal(timedOf({...row,ms:Infinity}),null)
})

// --- 2. 真实 rescan / readNew ------------------------------------------------
test("rescan 保留末尾半行，readNew 追加后不重复也不丢", () => withLedger((ledger) => {
  const line = (i) => JSON.stringify(at(3600e3 + i * 1000, { out: 10, ms: 500, ttft_ms: 100 })) + "\n"
  const third = line(2)
  fs.writeFileSync(ledger, line(0) + line(1) + third.slice(0, 20))

  const state = fresh()
  rescan(ledger, state, cfg)
  assert.equal(state.queues["30d"].length, 2, "半行不该被计入")
  assert.ok(state.pending.length > 0, "半行应留在 pending")
  assert.equal(state.offset, fs.statSync(ledger).size, "offset 必须是实际字节数")

  fs.appendFileSync(ledger, third.slice(20) + line(3))
  const rows = readNew(ledger, state)
  assert.equal(rows.length, 2, "应补上第 3、4 行")
  ingest(state, rows)
  assert.equal(state.queues["30d"].length, 4)
  assert.equal(state.pending, "", "完整行消费后 pending 应为空")
}))

test("readNew 遇到账本变短会清 pending 且不吐行", () => withLedger((ledger) => {
  fs.writeFileSync(ledger, JSON.stringify(at(1000, { out: 1 })) + "\n")
  const state = fresh()
  state.offset = 1e9
  state.pending = "上一轮残留的半行"
  const rows = readNew(ledger, state)
  assert.deepEqual(rows, [])
  assert.equal(state.pending, "", "截断时必须清掉半行缓存")
  assert.equal(state.offset, 0, "offset 归零交给重建")
}))

test("账本轮转后 rescan 重建队列，不重复累加", () => withLedger((ledger) => {
  const line = (i) => JSON.stringify(at(3600e3 + i * 1000, { out: 10 })) + "\n"
  fs.writeFileSync(ledger, line(0) + line(1) + line(2))
  const state = fresh()
  rescan(ledger, state, cfg)
  assert.equal(state.queues["30d"].length, 3)

  fs.writeFileSync(ledger, line(7))
  assert.ok(ledgerSize(ledger) < state.offset, "新账本应比原偏移短")
  rescan(ledger, state, cfg)
  assert.equal(state.queues["30d"].length, 1, "重建后只剩新账本的行")

  fs.appendFileSync(ledger, line(8))
  ingest(state, readNew(ledger, state))
  assert.equal(state.queues["30d"].length, 2, "重建后增量不应重复旧行")
}))

// --- 3. 窗口滚动与乱序 -------------------------------------------------------
test("pruneQueue 单遍剔除任意位置的过期样本并保序", () => {
  const queue = [{ t: 900 }, { t: 100 }, { t: 800 }, { t: 50 }]
  pruneQueue(queue, 500)
  assert.deepEqual(queue.map((x) => x.t), [900, 800], "乱序样本也要删干净，且保持相对顺序")
})

test("乱序账本里旧样本夹在新样本之后也要出窗", () => {
  const state = ingest(fresh(), [at(39 * 60e3), at(45 * 60e3), at(55 * 60e3)])
  assert.equal(state.queues["1h"].length, 3, "三分钟内都还在 1 小时窗内")
  const range = rangePayload(state, RANGES[0], cfg, Date.now() + 20 * 60e3)
  assert.equal(range.requests, 1, "推进 20 分钟后只剩最近的样本")
  assert.equal(state.queues["1h"].length, 1)
})

test("今天从本机零点起算，不是滚动 24 小时", () => {
  const now = new Date(2026, 9, 29, 9, 30, 0, 0).getTime()
  assert.equal(cutoffOf(RANGES[1], now), new Date(2026, 9, 29, 0, 0, 0, 0).getTime())
  assert.equal(cutoffOf(RANGES[0], now), now - 3600e3)
  assert.equal(cutoffOf(RANGES[2], now), now - 7 * 86400e3)
})

test("今天的队列只收零点之后的样本，7 天窗口包含更早记录", () => {
  const now = new Date(2026, 9, 29, 9, 30, 0, 0).getTime()
  const rowAt = (stamp) => ({ ...at(0), t: stamp.toISOString(), out: 10 })
  const state = fresh()
  for (const stamp of [new Date(2026, 9, 29, 1, 0), new Date(2026, 9, 28, 23, 0), new Date(2026, 9, 27, 10, 0)]) {
    const sample = toSample(rowAt(stamp), cfg)
    if (sample) pushSample(state, sample, now)
  }
  assert.equal(state.queues.today.length, 1)
  assert.equal(rangePayload(state, RANGES[1], cfg, now).requests, 1)
  assert.equal(rangePayload(state, RANGES[2], cfg, now).requests, 3, "7 天窗口保留昨天与前天")
})

test("1 小时窗口按滚动时长计算，不受轮询周期影响", () => {
  const state = ingest(fresh(), [at(30 * 60e3, { out: 10 }), at(90 * 60e3, { out: 10 })])
  assert.equal(state.queues["1h"].length, 1, "插入时超过 1 小时的样本不进队列")
  const now = Date.now()
  assert.equal(rangePayload(state, RANGES[0], cfg, now).requests, 1)
  assert.equal(rangePayload(state, RANGES[0], cfg, now + 3600e3).requests, 0, "推进 1 小时后出窗")
})

test("配置指纹只看过滤条件，改轮询周期不触发重算", () => {
  assert.equal(configSignature({ ...cfg, pollSec: 10 }), configSignature({ ...cfg, pollSec: 60 }))
  assert.notEqual(configSignature({ ...cfg, minPrompt: 1 }), configSignature({ ...cfg, minPrompt: 2 }))
  assert.notEqual(configSignature({ ...cfg, ignore: ["a"] }), configSignature({ ...cfg, ignore: [] }))
})

// --- 4. 写入观测 -------------------------------------------------------------
test("全 0 写入不算已观测，正数才给 writeMax", () => {
  const range = rangePayload(ingest(fresh(), [
    at(1000, { cache_read: 100, cache_write: 0, provider: "codex" }),
    at(900, { cache_read: 100, cache_write: 0, provider: "codex" }),
    at(800, { cache_read: 100, cache_write: 5000, provider: "cursor" }),
  ]), RANGES[2], cfg, Date.now())
  assert.equal(range.write, 5000)
  assert.equal(range.writeSeen, true)
  assert.equal(range.writeZeroGroups, 1)
  assert.equal(range.groups.find((g) => g.provider === "codex").writeMax, 0)
  assert.equal(range.groups.find((g) => g.provider === "cursor").writeMax, 5000)
})

test("整窗都没写入时 writeSeen 为 false", () => {
  const range = rangePayload(ingest(fresh(), [at(1000, { cache_write: 0 }), at(900, { cache_write: 0 })]), RANGES[2], cfg, Date.now())
  assert.equal(range.writeSeen, false)
  assert.equal(range.writeZeroGroups, 1)
})

// --- 5. 既有口径不回退 --------------------------------------------------------
test("命中率与 prompt 口径保持不变", () => {
  const row = at(1000, { in: 164310, cache_read: 208006733, cache_write: 82787979 })
  const hit = hitOf(row)
  assert.equal(hit.prompt, 164310 + 208006733 + 82787979)
  assert.equal(hit.hit, 208006733 / hit.prompt)
  const range = rangePayload(ingest(fresh(), [row]), RANGES[2], cfg, Date.now())
  assert.equal(range.hit, (100 * 208006733) / hit.prompt)
  assert.equal(range.groups[0].coverage, 0)
})

test("minRequests 只影响是否列出，不影响合计", () => {
  const state = ingest(fresh(), [at(1000, { provider: "x" }), at(900, { provider: "x" }), at(800, { provider: "y" })])
  const small = rangePayload(state, RANGES[2], { ...cfg, minRequests: 3 }, Date.now())
  assert.equal(small.requests, 3)
  assert.equal(small.hidden, 2)
  assert.equal(small.groups.length, 0)
  const loose = rangePayload(state, RANGES[2], { ...cfg, minRequests: 1 }, Date.now())
  assert.equal(loose.hidden, 0)
  assert.equal(loose.groups.length, 2)
})

// --- 6. payload 形状 ---------------------------------------------------------
test("buildPayload 产出 speed/writeSeen 且不依赖文件系统", () => {
  const state = ingest(fresh(), [at(1000, { out: 100, ms: 1000, ttft_ms: 400, cache_write: 0 })])
  const payload = buildPayload(state, cfg, Date.now())
  assert.equal(payload.speedMethod, "magpie-decode-v1")
  assert.equal(payload.ranges.length, RANGES.length)
  const week = payload.ranges.find((r) => r.id === "7d")
  assert.deepEqual(Object.keys(week.speed).sort(), ["coverage", "decodeMs", "replies", "requests", "tokens", "tps"].sort())
  assert.equal(week.speed.tps, (100 * 1000) / 600)
  assert.equal(week.writeSeen, false)
  for (const key of ["replies", "tokens", "decodeMs", "tps", "coverage", "writeMax"]) assert.ok(key in week.groups[0], "group 缺字段 " + key)
  assert.ok(Array.isArray(payload.alerts))
})

test("不同目录名和 file URL 安装都读取自身设置，不匹配相似目录后缀", () => withLedger((ledger, dir) => {
  const pluginDir = fileURLToPath(new URL("../", import.meta.url))
  const config=path.join(dir,"plugins.json")
  fs.writeFileSync(config,JSON.stringify({plugins:[{spec:path.join(dir,"other-magpie-cache-guard"),options:{threshold:.1}},{spec:pluginDir,options:{threshold:.72,pollSec:30}}]}))
  assert.equal(_internal.loadOptions({directory:dir},{}).threshold,.72)
  assert.equal(_internal.loadOptions({directory:dir},{}).pollSec,30)
  fs.writeFileSync(config,JSON.stringify({plugins:[{spec:new URL("../",import.meta.url).href,options:{threshold:.65}}]}))
  assert.equal(_internal.loadOptions({directory:dir},{}).threshold,.65)
}))

test("splitLines 只把最后一段当尾巴", () => {
  const { lines, rest } = splitLines("a\nb\nc")
  assert.deepEqual(lines, ["a", "b"])
  assert.equal(rest, "c")
})

test("告警保存触发规则与逐次实际值，不随后续配置变化", () => {
  const alertConfig = { ...DEFAULTS, consecutive: 3, threshold: .8, minPrompt: 15000 }
  const samples = [.1, .2, .3].map((hit, index) => ({ key: "p/a/m", hit, read: hit * 40000, prompt: 40000 + index * 1000, write: 0, session: "s" }))
  const alert = evaluate(samples, alertConfig)
  assert.deepEqual(alert.rule, {threshold:.8, consecutive:3, minPrompt:15000})
  assert.deepEqual(alert.observed, {requests:3, belowThreshold:3, hitMin:.1, hitMax:.3, promptMin:40000})
  assert.ok(Math.abs(alert.hit - .2) < 1e-10)
  alertConfig.threshold = .6
  alertConfig.consecutive = 5
  assert.equal(alert.rule.threshold, .8)
  assert.equal(alert.rule.consecutive, 3)
  assert.match(alert.message, /阈值 80.0%/)
  assert.match(alert.message, /连续低于阈值 3\/3 次/)
})

test("告警需要每次都低于阈值，平均低于阈值仍不足以触发", () => {
  const samples = [.01,.01,.8].map(hit=>({key:"p/a/m",hit,read:100,prompt:40000,write:0,session:"s"}))
  assert.equal(evaluate(samples,{...DEFAULTS,consecutive:3,threshold:.8}),null)
  assert.equal(evaluate(samples.slice(0,2),{...DEFAULTS,consecutive:3,threshold:.8}),null)
})

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  -> " + r.error}`)
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
