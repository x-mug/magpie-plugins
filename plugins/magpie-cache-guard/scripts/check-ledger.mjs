// 用真实账本回放，验证告警规则会命中。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { _internal } from "../index.mjs"

const ledger = path.join(os.homedir(), ".config", "magpie", "usage.jsonl")
const cfg = { ..._internal.DEFAULTS, minPrompt: 15000, threshold: 0.8, consecutive: 5 }

const rows = fs
  .readFileSync(ledger, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter(Boolean)

rows.sort((a, b) => (a.t < b.t ? -1 : 1))
const samples = new Map()
const alerts = []
for (const row of rows) {
  const sample = _internal.toSample(row, cfg)
  if (!sample) continue
  const list = samples.get(sample.key) || []
  list.push(sample)
  if (list.length > 20) list.shift()
  samples.set(sample.key, list)
  const alert = _internal.evaluate(list, cfg)
  if (alert) alerts.push({ t: sample.t, ...alert })
}

const byKey = new Map()
for (const alert of alerts) byKey.set(alert.key, (byKey.get(alert.key) || 0) + 1)

console.log(`rows=${rows.length} alerts=${alerts.length} groups=${byKey.size}`)
for (const [key, n] of [...byKey.entries()].sort((a, b) => b[1] - a[1])) {
  const sample = alerts.find((a) => a.key === key)
  console.log(`${key.padEnd(46)} alerts=${String(n).padStart(4)}  first=${new Date(sample.t).toISOString().slice(0, 16)}  ${sample.message}`)
}