// 真实账本只读校验：用生产 rescan/buildPayload 跑一遍，再用原始 JSON 独立复算逐项对照。
// 只读 usage.jsonl，不写任何文件；配置可过滤，用来验证过滤真的生效。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { _internal } from "../index.mjs"

const { toSample, timedOf, cutoffOf, configSignature, rescan, buildPayload, DEFAULTS, RANGES } = _internal

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const ledger = argOf("ledger", path.join(os.homedir(), ".config", "magpie", "usage.jsonl"))
const rangeId = argOf("range", "30d")
const ignore = argOf("ignore", "").split(",").filter(Boolean)
const minPrompt = Number(argOf("min-prompt", DEFAULTS.minPrompt))
const minRequests = Number(argOf("min-requests", DEFAULTS.minRequests))
const pollSec = Number(argOf("poll-sec", DEFAULTS.pollSec))
const showTop = Number(argOf("top", 5))

if (!fs.existsSync(ledger)) {
  console.error("账本不存在：" + ledger)
  process.exit(2)
}

const cfg = { ...DEFAULTS, minPrompt, minRequests, ignore, pollSec }
const range = RANGES.find((r) => r.id === rangeId)
if (!range) {
  console.error("未知范围：" + rangeId + "，可选 " + RANGES.map((r) => r.id).join("/"))
  process.exit(2)
}

// 账本在读取期间仍在追加，先冻结一份快照，生产路径与独立复算都用同一份字节。
const snapshot = fs.readFileSync(ledger)
const snapshotFile = path.join(os.tmpdir(), `cache-guard-snapshot-${process.pid}.jsonl`)
fs.writeFileSync(snapshotFile, snapshot)

const rows = []
for (const line of snapshot.toString("utf8").split("\n")) {
  if (!line.trim()) continue
  try {
    rows.push(JSON.parse(line))
  } catch {
    // 半行跳过，与生产一致。
  }
}

// --- 生产路径：真实 rescan 建队列，再取 payload -------------------------------
const state = { offset: 0, pending: "", startedAt: Date.now(), samples: new Map(), lastAlert: new Map(), rate: [], recent: [], queues: { "1h": [], today: [], "7d": [], "30d": [] } }
rescan(snapshotFile, state, cfg)
const now = Date.now()
const payload = buildPayload(state, cfg, now)
const actual = payload.ranges.find((r) => r.id === rangeId)
fs.rmSync(snapshotFile, { force: true })

// --- 独立复算：只碰原始 JSON 字段，不复用 summarize ---------------------------
const cutoff = cutoffOf(range, now)
const windowSec = range.today ? Math.round((now - cutoff) / 1000) : range.ms / 1000
const keyOf = (r) => `${r.provider ?? "?"}/${r.agent ?? "?"}/${r.model ?? "?"}`
const promptOf = (r) => (Number(r.in) || 0) + (Number(r.cache_read) || 0) + (Number(r.cache_write) || 0)
const kept = []
for (const row of rows) {
  if (row.status !== undefined && Number(row.status) !== 200) continue
  if (ignore.some((p) => keyOf(row).startsWith(p))) continue
  if (promptOf(row) < minPrompt) continue
  const t = Date.parse(row.t) || now
  if (t < cutoff) continue
  kept.push(row)
}

const expected = { requests: kept.length, read: 0, write: 0, prompt: 0, replies: 0, tokens: 0, decodeMs: 0, groups: new Map() }
for (const row of kept) {
  const prompt = promptOf(row)
  const read = Number(row.cache_read) || 0
  const write = Number(row.cache_write) || 0
  expected.read += read
  expected.write += write
  expected.prompt += prompt
  const key = keyOf(row)
  const acc = expected.groups.get(key) || { count: 0, read: 0, prompt: 0, writeMax: 0 }
  acc.count += 1
  acc.read += read
  acc.prompt += prompt
  acc.writeMax = Math.max(acc.writeMax, write)
  expected.groups.set(key, acc)
  const timed = timedOf(row)
  if (timed) {
    expected.replies += 1
    expected.tokens += timed.tokens
    expected.decodeMs += timed.decodeMs
  }
}
expected.hit = expected.prompt > 0 ? (100 * expected.read) / expected.prompt : 0
expected.tps = expected.decodeMs > 0 ? (expected.tokens * 1000) / expected.decodeMs : null
expected.hidden = [...expected.groups.values()].filter((g) => g.count < minRequests).length
expected.writeZeroGroups = [...expected.groups.values()].filter((g) => g.writeMax === 0).length

// --- 对照 ---------------------------------------------------------------------
const checks = []
const eq = (name, a, b) => {
  const same = typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b
  checks.push({ name, same, a, b })
}
eq("requests", actual.requests, expected.requests)
eq("prompt", actual.prompt, expected.prompt)
eq("read", actual.read, expected.read)
eq("write", actual.write, expected.write)
eq("hit(%)", actual.hit, expected.hit)
eq("speed.replies", actual.speed.replies, expected.replies)
eq("speed.tokens", actual.speed.tokens, expected.tokens)
eq("speed.decodeMs", actual.speed.decodeMs, expected.decodeMs)
eq("speed.tps", actual.speed.tps, expected.tps)
eq("speed.coverage", actual.speed.coverage, expected.requests > 0 ? expected.replies / expected.requests : 0)
eq("hidden", actual.hidden, expected.hidden)
eq("writeSeen", actual.writeSeen, expected.write > 0)
eq("writeZeroGroups", actual.writeZeroGroups, expected.writeZeroGroups)
eq("groups.length", actual.groups.length, expected.groups.size - expected.hidden)

const listed = [...expected.groups.values()].filter((g) => g.count >= minRequests)
const hiddenRows = [...expected.groups.values()].filter((g) => g.count < minRequests).reduce((a, g) => a + g.count, 0)
const sums = actual.groups.reduce((a, g) => ({ count: a.count + g.count, read: a.read + g.read, prompt: a.prompt + g.prompt }), { count: 0, read: 0, prompt: 0 })
eq("listed count sum", sums.count, expected.requests - hiddenRows)
eq("listed read sum", sums.read, listed.reduce((a, g) => a + g.read, 0))
eq("listed prompt sum", sums.prompt, listed.reduce((a, g) => a + g.prompt, 0))

console.log(`账本：${ledger}`)
console.log(`范围：${range.id}  窗口：${range.today ? "今天零点起" : windowSec + "s"}  配置：minPrompt=${minPrompt} minRequests=${minRequests} pollSec=${pollSec} ignore=[${ignore.join(",")}]`)
console.log(`指纹：${configSignature(cfg)}  行数：${rows.length} → 有效 ${kept.length}`)
console.log("")
for (const c of checks) console.log(`${c.same ? "PASS" : "FAIL"}  ${c.name.padEnd(42)} 生产=${c.a} 复算=${c.b}`)
console.log("")
if (showTop > 0) {
  console.log("按 tps 排序的组（生产值）：")
  for (const g of [...actual.groups].sort((x, y) => (y.tps ?? -1) - (x.tps ?? -1)).slice(0, showTop)) {
    console.log(`  ${(g.provider + "/" + g.agent + "/" + g.model).padEnd(42)} n=${String(g.count).padStart(5)} 计时=${String(g.replies).padStart(5)} cov=${(100 * g.coverage).toFixed(0).padStart(3)}% tps=${g.tps == null ? "-" : g.tps.toFixed(1)} writeMax=${g.writeMax}`)
  }
  console.log(`  ↳ 汇总 tps=${actual.speed.tps == null ? "-" : actual.speed.tps.toFixed(2)}  覆盖=${(100 * actual.speed.coverage).toFixed(1)}%  writeSeen=${actual.writeSeen}`)
}

const failed = checks.filter((c) => !c.same).length
if (argOf("json", "") === "1" || process.argv.includes("--json")) {
  console.log(JSON.stringify({
    ledger,
    range: range.id,
    windowSec,
    cfg: { minPrompt, minRequests, pollSec, ignore },
    rows: rows.length,
    summary: {
      requests: actual.requests,
      read: actual.read,
      write: actual.write,
      prompt: actual.prompt,
      hit: actual.hit,
      hidden: actual.hidden,
      writeSeen: actual.writeSeen,
      writeZeroGroups: actual.writeZeroGroups,
      speed: actual.speed,
    },
    groups: actual.groups,
    checks: { total: checks.length, failed },
  }, null, 2))
  process.exit(failed ? 1 : 0)
}
console.log(`\n${checks.length - failed}/${checks.length} 项一致（真实账本只读，未写任何文件）`)
process.exit(failed ? 1 : 0)
