import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { _internal } from "../index.mjs"

const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const binary = option("binary", path.join(os.homedir(), "Downloads", "magpie-windows-amd64.exe"))
const ledger = option("ledger", path.join(os.homedir(), ".config", "magpie", "usage.jsonl"))
const source = fs.readFileSync(binary).toString("latin1")
const start = source.indexOf("const ledDecode = (r) => {")
assert.ok(start >= 0, "宿主未找到 ledDecode，请重新核查用量页实现")
const end = source.indexOf("\n};", start)
assert.ok(end > start, "宿主 ledDecode 的边界已变化")
const failed = source.match(/const ledFailed_ = \(r\) => [^;]+;/)?.[0]
const codex = source.match(/const ledCodexTurn = \(r\) => [^;]+;/)?.[0]
const limits = source.match(/const LED_CODEX_WINDOW_MS = \d+, LED_CODEX_BODY = \d+;/)?.[0]
assert.ok(failed && codex && limits, "宿主计时依赖已变化，请重新核查")
const decode = vm.runInNewContext(`${failed}\n${limits}\n${codex}\n${source.slice(start, end + 3)}\nledDecode`, Object.create(null), {timeout:1000})
const rows = fs.readFileSync(ledger, "utf8").split("\n").flatMap(line => {
  try { return line.trim() ? [JSON.parse(line)] : [] } catch { return [] }
})
const since = new Date()
since.setHours(0,0,0,0)
const groups = new Map()
let accepted = 0
for (const [index, row] of rows.entries()) {
  const host = decode(row)
  const actual = _internal.timedOf(row)
  assert.deepEqual(actual, host ? {tokens:host.n, decodeMs:host.w} : null, `第 ${index + 1} 行的计时与宿主实现不一致`)
  if (actual) accepted++
  if (Date.parse(row.t) < +since) continue
  const key = `${row.provider}/${row.model}`
  const group = groups.get(key) ?? {model:key, all:{n:0,tokens:0,ms:0}, filtered:{n:0,tokens:0,ms:0}, old:{n:0,tokens:0,ms:0}}
  const filtered = _internal.toSample(row, _internal.DEFAULTS)
  if (actual) {
    group.all.n++; group.all.tokens += actual.tokens; group.all.ms += actual.decodeMs
    if (filtered) { group.filtered.n++; group.filtered.tokens += actual.tokens; group.filtered.ms += actual.decodeMs }
  }
  if (filtered && row.out > 0 && row.ttft_ms > 0 && row.ms > row.ttft_ms) {
    group.old.n++; group.old.tokens += row.out; group.old.ms += row.ms - row.ttft_ms
  }
  groups.set(key,group)
}
console.log(JSON.stringify({passed:true, binary, sourceOffset:start, rows:rows.length, accepted, since:since.toISOString(), today:[...groups.values()].map(group=>({model:group.model,...Object.fromEntries(["all","filtered","old"].map(key=>[key,{...group[key],tps:group[key].ms>0?group[key].tokens*1000/group[key].ms:null}]))}))},null,2))
