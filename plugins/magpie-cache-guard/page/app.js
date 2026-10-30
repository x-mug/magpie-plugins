const $ = (id) => document.getElementById(id)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DEFAULTS = { threshold: 0.8, consecutive: 5, minPrompt: 15000, minRequests: 10, cooldownSec: 1800, notify: "toast", ignore: [], pollSec: 10 }
const SPEED_METHOD = "magpie-decode-v1"
const SPEED_DESCRIPTION = "按 magpie 用量页计时规则：可测输出 token ÷ 可测生成时长，剔除隐藏推理、过短与集中回传等无效计时；本页仍按 Prompt 下限、忽略组和客户端分组统计。"
const PERIODS = [{ id: "1h", label: "1小时" }, { id: "today", label: "今天" }, { id: "7d", label: "7天" }, { id: "30d", label: "30天" }]
const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
const numberFormat = new Intl.NumberFormat("zh-CN")
let view = null
let activeRange = "1h"
let pickedDefault = false
let savedForm = ""
let optionsReady = false
let initialAlerts = true
let stateRequest = null
let optionQueue = Promise.resolve()
let lastOptionWrite = 0
let savedCadence = DEFAULTS.pollSec
let savingSettings = false
let columnWidths = null

function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function svgIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("class", "icon")
  svg.setAttribute("aria-hidden", "true")
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use")
  use.setAttribute("href", `#i-${name}`)
  svg.append(use)
  return svg
}

function compact(value) {
  const n = Number(value) || 0
  const unit = n >= 1e9 ? [1e9, "B"] : n >= 1e6 ? [1e6, "M"] : n >= 1e3 ? [1e3, "K"] : [1, ""]
  return { value: unit[0] === 1 ? numberFormat.format(n) : (n / unit[0]).toFixed(1), unit: unit[1] }
}

function percent(value) { return `${(Number(value) || 0).toFixed(1)}%` }
function fullNumber(value) { return numberFormat.format(Number(value) || 0) }
function validDate(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date : null }
function clock(value) { const date = validDate(value); return date ? timeFormat.format(date) : "—" }
function threshold() { const n = Number(view?.config?.threshold ?? DEFAULTS.threshold); return (n > 1 ? n : n * 100) }
function tone(hit) { return Number(hit) >= threshold() ? "tone-ok" : "tone-low" }

function notice(message = "", error = false) {
  $("notice").textContent = message
  $("notice").hidden = !message
  $("notice").dataset.tone = error ? "error" : "info"
}

function fillCadence(seconds) {
  const select = $("cadence")
  const value = String(Math.max(2, Number(seconds) || DEFAULTS.pollSec))
  if (![...select.options].some((option) => option.value === value)) select.append(new Option(`${value} 秒`, value))
  select.value = value
}

function fill(options) {
  const cfg = { ...DEFAULTS, ...options }
  const rate = Number(cfg.threshold)
  $("threshold").value = Number((rate <= 1 ? rate * 100 : rate).toFixed(1))
  for (const id of ["consecutive", "minPrompt", "minRequests", "cooldownSec", "notify"]) $(id).value = cfg[id]
  $("ignore").value = Array.isArray(cfg.ignore) ? cfg.ignore.join(", ") : ""
  fillCadence(cfg.pollSec)
  savedCadence = Number(cfg.pollSec) || DEFAULTS.pollSec
  savedForm = JSON.stringify(collect())
  optionsReady = true
  updateDirty()
}

function collect() {
  return {
    threshold: Number($("threshold").value) / 100,
    consecutive: Number($("consecutive").value),
    minPrompt: Number($("minPrompt").value),
    minRequests: Number($("minRequests").value),
    cooldownSec: Number($("cooldownSec").value),
    notify: $("notify").value,
    ignore: $("ignore").value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean),
  }
}

function updateDirty(event) {
  event?.target?.removeAttribute?.("aria-invalid")
  const dirty = JSON.stringify(collect()) !== savedForm
  $("save").disabled = !optionsReady || !dirty || savingSettings
  if (savingSettings) return
  $("saved").dataset.tone = ""
  $("saved").textContent = dirty ? "有未保存的更改" : "保存后自动生效"
}

// 插件页 iframe 只开 allow-scripts，表单提交会被浏览器直接拦掉，所以逐项校验后手动保存。
function validateSettings() {
  const fields = [...$("settings").querySelectorAll("input[type=number]")]
  let invalid = null
  for (const field of fields) {
    field.removeAttribute("aria-invalid")
    if (!field.validity.valid && !invalid) invalid = field
  }
  if (!invalid) return true
  const label = document.querySelector(`label[for="${invalid.id}"] strong`)?.textContent ?? "设置值"
  const validity = invalid.validity
  const reason = validity.badInput || validity.valueMissing ? "请输入数字"
    : validity.rangeUnderflow ? `不能小于 ${invalid.min}`
    : validity.rangeOverflow ? `不能大于 ${invalid.max}`
    : validity.stepMismatch ? `请按 ${invalid.step} 的步长填写`
    : "请检查输入"
  invalid.setAttribute("aria-invalid", "true")
  invalid.focus()
  $("saved").dataset.tone = "error"
  $("saved").textContent = `${label}：${reason}`
  return false
}

function patchOptions(patch) {
  const run = optionQueue.catch(() => {}).then(async () => {
    const pause = Math.max(0, 1050 - (Date.now() - lastOptionWrite))
    if (pause) await sleep(pause)
    const previous = (await magpie.options.get()) ?? {}
    lastOptionWrite = Date.now()
    await magpie.options.set({ ...previous, ...patch })
    return { ...previous, ...patch }
  })
  optionQueue = run
  return run
}

function renderTabs() {
  for (const id of ["tabs", "detailTabs"]) {
    $(id).replaceChildren(...PERIODS.map((period, index) => {
      const button = node("button", "", period.label)
      button.type = "button"
      button.id = `${id}-${period.id}`
      button.role = "tab"
      button.dataset.range = period.id
      button.setAttribute("aria-controls", "stats groups")
      button.setAttribute("aria-selected", String(period.id === activeRange))
      button.tabIndex = period.id === activeRange ? 0 : -1
      button.addEventListener("click", () => { activeRange = period.id; renderDashboard() })
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
        event.preventDefault()
        const next = event.key === "Home" ? 0 : event.key === "End" ? PERIODS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + PERIODS.length) % PERIODS.length
        activeRange = PERIODS[next].id
        renderDashboard()
        $(`${id}-${activeRange}`).focus()
      })
      return button
    }))
  }
}

function metric(label, value, unit, meta, metaTone = "", title = "") {
  const card = node("div", "metric")
  if (title) card.title = title
  card.append(node("div", "metric-label", label))
  const valueNode = node("div", "metric-value", value)
  if (unit) valueNode.append(node("span", "metric-unit", unit))
  if (/[^\d.,%+\-\s—]/.test(String(value))) valueNode.classList.add("is-text")
  card.append(valueNode)
  const caption = node("div", `metric-meta ${metaTone}`)
  if (metaTone) caption.append(node("span", "status-dot"))
  caption.append(document.createTextNode(meta))
  card.append(caption)
  return card
}

function renderStats(range) {
  const hasData = Boolean(range?.requests)
  const read = compact(range?.read)
  const prompt = compact(range?.prompt)
  const speed = range?.speed
  const tps = view?.speedMethod === SPEED_METHOD ? formatTps(speed?.tps) : null
  const speedMeta = tps
    ? `计时 ${Number.isFinite(Number(speed.replies)) ? fullNumber(speed.replies) : "—"}/${Number.isFinite(Number(speed.requests)) ? fullNumber(speed.requests) : "—"} 次 · 覆盖率 ${Number.isFinite(Number(speed.coverage)) ? `${Math.round(Number(speed.coverage) * 100)}%` : "—"}`
    : view && view.speedMethod !== SPEED_METHOD ? "速度口径待更新" : "暂无有效计时"
  const writeSeen = range?.writeSeen
  const write = compact(range?.write)
  $("stats").setAttribute("aria-busy", String(!view))
  $("stats").replaceChildren(
    metric("缓存命中率", hasData ? Number(range.hit).toFixed(1) : "—", hasData ? "%" : "", hasData ? `${Number(range.hit) >= threshold() ? "达到" : "低于"} ${threshold()}% 阈值` : "等待符合规则的请求", hasData ? tone(range.hit) : ""),
    metric("缓存读取", view ? read.value : "—", read.unit, "复用的 Prompt token"),
    writeSeen === false
      ? metric("缓存写入", "未观测到写入", "", "无 cache_write>0 记录", "", "该时段没有任何 cache_write>0 记录：无法区分「上游未上报」与「确实为 0」")
      : metric("缓存写入", view ? write.value : "—", write.unit, "新写入的缓存 token"),
    metric("Prompt 总量", view ? prompt.value : "—", prompt.unit, view ? `${fullNumber(range?.requests)} 次有效请求` : "—"),
    metric("平均速度", tps ?? "—", tps ? "t/s" : "", speedMeta, "", SPEED_DESCRIPTION),
  )
}

// 客户端图标映射：agent → icons/<file>，来源、用途与许可见 icons/README.md。
// 单色标用 data-mono 交给 CSS 处理暗色反差；未列出的 agent 统一回退 client.svg。
const CLIENT_ICONS = {
  dsh: { file: "icons/dsh.svg", mono: true },
  codex: { file: "icons/openai.svg", mono: true },
  openai: { file: "icons/openai.svg", mono: true },
  claude: { file: "icons/claudecode-color.svg" },
  "claude-code": { file: "icons/claudecode-color.svg" },
  cursor: { file: "icons/cursor.svg", mono: true },
  qoder: { file: "icons/qoder.svg", mono: true },
  kimi: { file: "icons/kimi.svg", mono: true },
  magpie: { file: "icons/magpie.png" },
  zed: { file: "icons/zed.png" },
}
const CLIENT_FALLBACK = "icons/client.svg"

function clientAvatar(name) {
  const icon = CLIENT_ICONS[String(name ?? "").trim().toLowerCase()] ?? { file: CLIENT_FALLBACK, mono: true }
  const image = document.createElement("img")
  image.className = "entity-avatar"
  image.src = icon.file
  image.alt = ""
  image.setAttribute("aria-hidden", "true")
  image.decoding = "async"
  if (icon.mono) image.dataset.mono = "true"
  image.addEventListener("error", () => {
    if (!image.dataset.fallback) {
      image.dataset.fallback = "true"
      image.dataset.mono = "true"
      image.src = CLIENT_FALLBACK
      return
    }
    image.hidden = true
  })
  return image
}

function entityTag(name, type) {
  const tag = node("span", `entity-tag ${type}`)
  const label = String(name ?? "未知")
  tag.title = label
  if (type === "client") tag.append(clientAvatar(name))
  tag.append(node("span", "entity-name", label))
  return tag
}

function numericCell(value, token = false) {
  const formatted = compact(value)
  const cell = node("td", `numeric ${token ? "token-value" : ""} ${Number(value) === 0 ? "token-zero" : ""}`, `${formatted.value}${formatted.unit}`)
  cell.title = fullNumber(value)
  return cell
}

// 零写入标为未观测，避免把账本默认值解释成上游真值。
function writeCell(group, range) {
  const value = Number(group?.write) || 0
  const writeSeen = range?.writeSeen
  const writeMax = Number(group?.writeMax)
  const unobserved = value === 0 && (writeSeen === false || writeMax === 0)
  if (!unobserved) return numericCell(value, true)
  const cell = node("td", "numeric token-unobserved", "—")
  cell.title = writeSeen === false
    ? "该时段没有任何 cache_write>0 记录：无法区分「上游未上报」与「确实为 0」"
    : "该组没有 cache_write>0 记录：无法区分「上游未上报」与「确实为 0」"
  return cell
}

// 平均速度只展示宿主计时规则已确认的数据。
function formatTps(tps) {
  const value = Number(tps)
  if (!Number.isFinite(value) || value <= 0) return null
  return String(Math.round(value))
}

function speedCell(group) {
  const currentMethod = view?.speedMethod === SPEED_METHOD
  const tps = currentMethod ? formatTps(group?.tps) : null
  const cell = node("td", "numeric speed-cell")
  if (tps === null) {
    cell.append(node("span", "speed-null", "—"))
    cell.title = currentMethod ? "暂无有效计时" : "速度口径待更新，请停用再启用本插件"
    return cell
  }
  cell.append(node("span", "speed-value", tps), node("span", "speed-unit", "t/s"))
  const replies = Number(group?.replies)
  const coverage = Number(group?.coverage)
  cell.title = `计时 ${Number.isFinite(replies) ? fullNumber(replies) : "—"}/${fullNumber(group?.count)} 次 · 覆盖率 ${Number.isFinite(coverage) ? `${Math.round(coverage * 100)}%` : "—"}；${SPEED_DESCRIPTION}`
  return cell
}

function hitCell(hit) {
  const cell = node("td", "numeric")
  const wrap = node("div", `hit-cell ${tone(hit)}`)
  const track = node("span", "hit-track")
  track.setAttribute("aria-hidden", "true")
  const fill = node("span", "hit-fill")
  fill.style.width = `${Math.min(100, Math.max(0, Number(hit) || 0))}%`
  track.append(fill)
  wrap.append(track, node("span", "hit-number", percent(hit)))
  cell.append(wrap)
  return cell
}

function groupRow(group, range) {
  const row = node("tr")
  const client = node("td")
  client.append(entityTag(group.agent, "client"))
  const provider = node("td")
  provider.append(entityTag(group.provider, "provider"))
  const model = node("td")
  const modelName = node("span", "model-name", group.model)
  modelName.title = group.model
  model.append(modelName)
  row.append(client, provider, model, numericCell(group.count), hitCell(group.hit), speedCell(group), numericCell(group.read, true), writeCell(group, range))
  return row
}

function sizeTableColumns() {
  const table = $("groups")
  const scroller = table.closest(".table-scroll")
  const probe = node("table", "table-sizing")
  probe.setAttribute("aria-hidden", "true")
  probe.append(table.querySelector("thead").cloneNode(true))
  const body = node("tbody")
  for (const range of view?.ranges ?? []) {
    for (const group of range.groups ?? []) body.append(groupRow(group, range))
  }
  probe.append(body)
  document.body.append(probe)
  const natural = Array.from(probe.querySelectorAll("th"), cell => Math.ceil(cell.getBoundingClientRect().width))
  probe.remove()
  // 列宽由内容决定；卡片更宽时按各列比例均摊余量，避免某一列被拉出大片空白。
  const total = natural.reduce((sum, width) => sum + width, 0)
  const spare = Math.max(0, (scroller?.clientWidth ?? total) - total)
  const widths = natural.map(width => width + (spare ? (spare * width) / total : 0))
  columnWidths = widths
  table.dataset.naturalWidths = natural.join(",")
  Array.from(table.querySelectorAll("col")).forEach((col, index) => { col.style.width = `${widths[index]}px` })
  table.style.setProperty("--table-width", `${Math.max(scroller?.clientWidth ?? total, total)}px`)
  table.dataset.sized = "1"
}

function renderTable(range) {
  if (!columnWidths) {
    delete $("groups").dataset.sized
    sizeTableColumns()
  }
  const groups = range?.groups ?? []
  const query = $("search").value.trim().toLocaleLowerCase()
  const visible = groups.filter((group) => [group.agent, group.provider, group.model].some((s) => String(s).toLocaleLowerCase().includes(query)))
  $("groups").querySelector("tbody").replaceChildren(...visible.map((group) => groupRow(group, range)))
  $("groupCount").textContent = query ? `${visible.length} / ${groups.length}` : String(groups.length)
  $("tableEmpty").hidden = visible.length > 0
  if (!visible.length) {
    if (query) {
      $("emptyTitle").textContent = "没有匹配的结果"
      $("emptyText").textContent = "试试其他客户端、供应商或模型名称。"
    } else if (!view) {
      $("emptyTitle").textContent = "等待数据"
      $("emptyText").textContent = "首次统计完成后，数据会自动出现在这里。"
    } else if (range?.requests) {
      $("emptyTitle").textContent = "暂无达到样本下限的组"
      $("emptyText").textContent = `明细仅展示至少 ${view.config?.minRequests ?? DEFAULTS.minRequests} 次请求的组，可在监控设置中调整。`
    } else {
      $("emptyTitle").textContent = activeRange === "1h" ? "最近一小时暂无有效请求" : "这个时段暂无有效请求"
      $("emptyText").textContent = "数据会自动更新；小请求与忽略的组已按设置过滤。"
    }
  }
  const minPrompt = view?.config?.minPrompt ?? DEFAULTS.minPrompt
  $("filterHint").textContent = `Prompt ≥ ${fullNumber(minPrompt)} token · 明细 ≥ ${view?.config?.minRequests ?? DEFAULTS.minRequests} 次`
  $("hidden").textContent = range?.hidden ? `${range.hidden} 组样本不足，未展示` : "按命中率升序"
}

function renderDashboard() {
  const ranges = view?.ranges ?? []
  for (const button of document.querySelectorAll(".period-tabs button")) {
    const selected = button.dataset.range === activeRange
    button.setAttribute("aria-selected", String(selected))
    button.tabIndex = selected ? 0 : -1
  }
  const range = ranges.find((item) => item.id === activeRange)
  $("stats").setAttribute("aria-labelledby", `tabs-${activeRange}`)
  renderStats(range)
  renderTable(range)
  const label = PERIODS.find((item) => item.id === activeRange)?.label ?? ""
  $("rangeHint").textContent = activeRange === "1h" ? "最近 1 小时 · 滚动统计" : activeRange === "today" ? "今天 00:00 起" : `最近 ${label} · 滚动统计`
}

function alertMeasure(label, value, unit, comparison, detail, className = "") {
  const item = node("div", `alert-measure ${className}`)
  item.append(node("dt", "", label))
  const actual = node("dd", "alert-actual", value)
  if (unit) actual.append(node("span", "alert-unit", unit))
  item.append(actual, node("div", "alert-comparison", comparison))
  if (detail) item.append(node("div", "alert-measure-note", detail))
  return item
}

function alertEvidence(alert) {
  const evidence = node("dl", "alert-evidence")
  const rule = alert.rule
  const observed = alert.observed
  const recorded = typeof rule?.threshold === "number" && Number.isFinite(rule.threshold)
  const limit = recorded ? rule.threshold * 100 : threshold()
  const count = Number.isInteger(rule?.consecutive) ? rule.consecutive : null
  const measured = Number.isInteger(observed?.belowThreshold) ? observed.belowThreshold : null
  const minPrompt = typeof rule?.minPrompt === "number" && Number.isFinite(rule.minPrompt) ? rule.minPrompt : null
  const promptMin = typeof observed?.promptMin === "number" && Number.isFinite(observed.promptMin) ? observed.promptMin : null
  const rateNote = recorded ? `低于阈值 ${Math.max(0, limit - alert.hit * 100).toFixed(1)} 个百分点` : "旧记录未保存触发时阈值"
  evidence.append(alertMeasure(count === null ? "平均命中率" : `最近 ${fullNumber(count)} 次平均命中率`, percent(alert.hit * 100), "", `${recorded ? "触发" : "当前"}阈值 ${percent(limit)}`, rateNote, "alert-measure-rate"))
  if (!recorded) {
    evidence.classList.add("is-legacy")
    return evidence
  }
  const hitRange = typeof observed?.hitMin === "number" && typeof observed?.hitMax === "number"
    ? `单次范围 ${percent(observed.hitMin * 100)}–${percent(observed.hitMax * 100)}` : "旧记录未保存逐次命中率"
  evidence.append(alertMeasure("连续低命中", measured === null ? "—" : fullNumber(measured), measured === null ? "" : "次", count === null ? "触发次数未记录" : `触发条件 ≥ ${fullNumber(count)} 次`, hitRange))
  evidence.append(alertMeasure("样本最小 Prompt", promptMin === null ? "—" : fullNumber(promptMin), promptMin === null ? "" : "token", minPrompt === null ? "过滤下限未记录" : `过滤下限 ≥ ${fullNumber(minPrompt)} token`, promptMin === null ? "旧记录未保存最小值" : `${fullNumber(observed.requests)} 次请求均达到过滤下限`))
  return evidence
}

function renderAlerts(alerts) {
  const panel = $("alertPanel")
  panel.dataset.hasAlerts = String(alerts.length > 0)
  $("alertIcon").setAttribute("href", alerts.length ? "#i-alert" : "#i-check")
  $("alertCount").hidden = !alerts.length
  $("alertCount").textContent = alerts.length
  $("alertSummary").textContent = alerts.length ? `最近记录 ${clock(alerts[0].t)}` : "暂无告警记录"
  if (initialAlerts) { panel.open = alerts.length > 0; initialAlerts = false }
  if (!alerts.length) {
    $("alerts").replaceChildren(node("p", "quiet-empty", "连续低命中达到告警条件后，会在这里记录。"))
    return
  }
  $("alerts").replaceChildren(...alerts.map((alert) => {
    const row = node("article", "alert-row")
    const [provider, client, ...modelParts] = String(alert.key || "").split("/")
    const head = node("div", "alert-row-head")
    if (client) head.append(entityTag(client, "client"))
    if (provider) head.append(entityTag(provider, "provider"))
    head.append(node("span", "alert-row-model", modelParts.join("/") || "缓存命中偏低"))
    const date = node("time", "", clock(alert.t))
    date.title = validDate(alert.t)?.toLocaleString("zh-CN") ?? ""
    row.append(head, date)
    if (Number.isFinite(alert.hit)) {
      row.append(alertEvidence(alert))
      const detail = node("p", "alert-row-detail", `读取中位 ${fullNumber(alert.reads)} token · Prompt 中位 ${fullNumber(alert.prompts)} token`)
      detail.title = alert.message || ""
      row.append(detail)
    } else row.append(node("p", "alert-row-detail", alert.message || "连续低命中请求达到告警条件。"))
    return row
  }))
}

function applyState(state) {
  if (!state || !Array.isArray(state.ranges)) return false
  if (view?.updatedAt === state.updatedAt) return true
  const known = state.ranges.filter((range) => PERIODS.some((period) => period.id === range.id))
  if (!known.length) return false
  view = state
  columnWidths = null
  // 宿主还是旧时间范围时提示补齐，已支持的时段照常显示。
  const missing = PERIODS.filter((period) => !state.ranges.some((range) => range.id === period.id))
  if (missing.length) {
    notice(`宿主还没有「${missing.map((period) => period.label)}」的统计，请在 magpie 中停用再启用本插件。`)
    $("notice").dataset.kind = "host"
  } else if (state.speedMethod !== SPEED_METHOD) {
    notice("速度统计规则已更新，请在 magpie 中停用再启用本插件。")
    $("notice").dataset.kind = "host"
  } else if ($("notice").dataset.kind === "host") {
    notice()
    delete $("notice").dataset.kind
  }
  if (!pickedDefault) {
    const first = known.find((range) => range.id === "1h")
    if (!first?.requests) activeRange = known.find((range) => range.groups?.length)?.id ?? "1h"
    pickedDefault = true
  }
  const date = validDate(state.updatedAt)
  $("updated").textContent = clock(state.updatedAt)
  $("updated").dateTime = date?.toISOString() ?? ""
  $("updated").title = date ? `最近刷新：${date.toLocaleString("zh-CN")}` : "尚未刷新"
  renderDashboard()
  renderAlerts(state.alerts ?? [])
  return true
}

function loadState() {
  if (stateRequest) return stateRequest
  stateRequest = new Promise((resolve) => {
    const script = document.createElement("script")
    let timeout
    const finish = (state) => { clearTimeout(timeout); script.remove(); resolve(state) }
    script.src = `state.js?v=${Date.now()}`
    script.onload = () => finish(window.__cacheGuardState ?? null)
    script.onerror = () => finish(null)
    timeout = setTimeout(() => finish(null), 4000)
    document.head.append(script)
  }).finally(() => { stateRequest = null })
  return stateRequest
}

async function pull() {
  if (document.hidden) return
  const state = await loadState()
  if (applyState(state)) {
    if ($("notice").dataset.kind === "data") notice()
  } else if (!view) {
    notice("正在等待统计数据，页面会自动重试。")
    $("notice").dataset.kind = "data"
  }
}

async function refreshNow() {
  const button = $("refresh")
  if (button.disabled) return
  const before = view?.updatedAt
  button.disabled = true
  button.setAttribute("aria-busy", "true")
  try {
    await patchOptions({ _refreshAt: Date.now() })
    let changed = false
    for (let i = 0; i < 16; i++) {
      const state = await loadState()
      if (state?.updatedAt && state.updatedAt !== before && applyState(state)) { changed = true; break }
      await sleep(250)
    }
    if (!changed) throw new Error("refresh-pending")
    notice()
  } catch {
    notice("刷新暂未完成，请稍后重试。", true)
  } finally {
    button.disabled = false
    button.setAttribute("aria-busy", "false")
  }
}

async function applyCadence() {
  const select = $("cadence")
  const previous = savedCadence
  select.disabled = true
  try {
    await patchOptions({ pollSec: Number(select.value) })
    savedCadence = Number(select.value)
    notice()
  } catch {
    fillCadence(previous)
    notice("刷新周期未保存，请重试。", true)
  } finally { select.disabled = false }
}

async function saveSettings() {
  if (!optionsReady || savingSettings || !validateSettings()) return
  const button = $("save")
  const patch = collect()
  savingSettings = true
  button.disabled = true
  button.textContent = "保存中…"
  $("saved").dataset.tone = ""
  $("saved").textContent = "正在保存设置…"
  let saved = false
  try {
    await patchOptions(patch)
    savedForm = JSON.stringify(patch)
    saved = true
  } catch {
    saved = false
  } finally {
    savingSettings = false
    button.textContent = "保存设置"
    updateDirty()
    if (saved) $("saved").textContent = JSON.stringify(collect()) === savedForm ? "设置已保存" : "已保存，仍有新的更改"
    else {
      $("saved").textContent = "保存失败，请重试"
      $("saved").dataset.tone = "error"
      button.disabled = false
    }
  }
}

async function main() {
  renderTabs()
  renderDashboard()
  fill(DEFAULTS)
  optionsReady = false
  $("save").disabled = true
  $("search").addEventListener("input", renderDashboard)
  $("settings").addEventListener("input", updateDirty)
  $("settings").addEventListener("change", updateDirty)
  $("save").addEventListener("click", saveSettings)
  $("settings").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.target.tagName !== "INPUT") return
    event.preventDefault()
    if (!$("save").disabled) saveSettings()
  })
  $("refresh").addEventListener("click", refreshNow)
  $("cadence").addEventListener("change", applyCadence)
  let layoutFrame
  const refreshColumns = () => {
    cancelAnimationFrame(layoutFrame)
    layoutFrame = requestAnimationFrame(sizeTableColumns)
  }
  window.addEventListener("resize", refreshColumns)
  document.fonts.ready.then(refreshColumns)
  const pageHeader = document.querySelector(".page-header")
const syncHeaderStuck = () => pageHeader?.classList.toggle("is-stuck", window.scrollY > 8)
window.addEventListener("scroll", syncHeaderStuck, { passive: true })
syncHeaderStuck()
document.addEventListener("visibilitychange", () => { if (!document.hidden) pull() })
  try {
    await magpie.ready
    fill((await magpie.options.get()) ?? {})
  } catch {
    notice("暂时无法读取设置，请重新打开插件页面。", true)
  }
  await pull()
  setInterval(pull, 1000)
}

main().catch(() => notice("页面加载未完成，请重新打开。", true))
