import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"

const here = path.dirname(fileURLToPath(import.meta.url))
const pageDir = path.resolve(here, "../page")
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(name)
  return i < 0 ? fallback : args[i + 1]
}
const browser = option("--browser", process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
const cdpEndpoint = option("--cdp", null)
const hostSandbox = !args.includes("--unsandboxed")
if (cdpEndpoint && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(cdpEndpoint).hostname)) {
  throw new Error("CDP endpoint must be loopback")
}
const outputDir = path.resolve(here, option("--out", "output"))
if (!outputDir.startsWith(here + path.sep)) throw new Error("Output must stay within verification")
const fixture = JSON.parse(await fs.readFile(path.resolve(here, option("--fixture", "fixture.json")), "utf8"))
const profileDir = path.join(outputDir, `chrome-profile-${process.pid}`)
const virtualOrigin = "http://magpie-cache-guard.preview.invalid"
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sources = new Map()
async function collectSources(directory, prefix = "") {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isDirectory()) await collectSources(path.join(directory, entry.name), `${name}/`)
    else if (!name.startsWith("state.js") && /\.(?:html|css|js|svg|png|webp|ico)$/.test(name)) sources.set(name, await fs.readFile(path.join(directory, entry.name)))
  }
}
await collectSources(pageDir)
await fs.mkdir(profileDir, { recursive: true })
const report = {
  evidence: "Local mock preview only; not an installed Magpie client verification",
  mechanism: "Existing Chrome headless, built-in Node WebSocket/CDP, Fetch interception; no UI server",
  sandbox: hostSandbox ? "CSP sandbox allow-scripts; forms and same-origin privileges disabled like Magpie" : "Unsandboxed diagnostic preview",
  browser,
  node: process.version,
  createdAt: new Date().toISOString(),
  sourceHashes: Object.fromEntries([...sources].map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")])),
  screenshots: [],
  checks: [],
  pageErrors: [],
  blockedRequests: [],
}

class CDP {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
        else pending.resolve(message.result)
      } else {
        for (const handler of this.listeners.get(message.method) ?? []) {
          Promise.resolve(handler(message.params, message.sessionId)).catch((error) => {
            report.pageErrors.push({ source: "CDP event handler", message: error.message })
          })
        }
      }
    })
  }
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true })
      socket.addEventListener("error", reject, { once: true })
    })
    return new CDP(socket)
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 15000)
      this.pending.set(id, { resolve, reject, timer, method })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  on(method, handler) {
    const current = this.listeners.get(method) ?? []
    this.listeners.set(method, [...current, handler])
  }
}

const browserLog = cdpEndpoint ? null : await fs.open(path.join(outputDir, "browser.log"), "w")
report.browserLog = cdpEndpoint ? null : path.join(outputDir, "browser.log")
report.connection = cdpEndpoint ? "existing loopback CDP endpoint; runner creates and closes one isolated browser context" : "runner-owned isolated Chrome process"
const child = cdpEndpoint ? null : spawn(browser, [
  "--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--disable-sync",
  "--disable-crash-reporter", "--disable-breakpad", "--disable-extensions",
  "--metrics-recording-only", "--password-store=basic", "--disable-gpu", "about:blank",
], { stdio: ["ignore", browserLog.fd, browserLog.fd], windowsHide: true })
let spawnError = null
child?.on("error", (error) => { spawnError = error })
let cdp
let browserContextId
let currentTheme = "light"
let currentFixture = fixture
let stateVersion = 0
const check = (name, pass, details) => report.checks.push({ name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) })

function mockBridge() {
  return `(() => {
    document.documentElement.dataset.theme = ${JSON.stringify(currentTheme)};
    document.documentElement.style.colorScheme = ${JSON.stringify(currentTheme)};
    window.__verification = { evidence: "mock-preview", calls: [], options: ${JSON.stringify(fixture.config)}, refreshes: 0 };
    const copy = value => JSON.parse(JSON.stringify(value));
    window.magpie = {
      ready: Promise.resolve(),
      options: {
        get: async () => { window.__verification.calls.push({method: "get"}); return copy(window.__verification.options); },
        set: async value => {
          window.__verification.calls.push({method: "set", value: copy(value)});
          if (window.__verification.failNextSet) { window.__verification.failNextSet = false; throw new Error("Simulated bridge write failure"); }
          window.__verification.options = copy(value);
          if (value._refreshAt) {
            window.__verification.refreshes++;
            await fetch("/__verification/refresh", {method: "POST"});
          }
          return copy(value);
        }
      }
    };
  })();`
}

try {
  let websocketUrl = cdpEndpoint
  if (cdpEndpoint?.startsWith("http")) {
    const metadata = await fetch(new URL("/json/version", cdpEndpoint), { signal: AbortSignal.timeout(5000) }).then((response) => response.json())
    websocketUrl = metadata.webSocketDebuggerUrl
  }
  if (!websocketUrl) {
    let portText
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null) throw new Error(`Browser exited with code ${child.exitCode}`)
      try { portText = await fs.readFile(path.join(profileDir, "DevToolsActivePort"), "utf8"); break } catch {}
      await pause(100)
    }
    if (!portText) throw new Error("Browser did not publish DevToolsActivePort")
    const [port, endpoint] = portText.trim().split(/\r?\n/)
    websocketUrl = `ws://127.0.0.1:${port}${endpoint}`
  }
  cdp = await CDP.connect(websocketUrl)
  report.browserVersion = await cdp.send("Browser.getVersion")
  if (cdpEndpoint) ({ browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true }))
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", ...(browserContextId ? { browserContextId } : {}) })
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true })
  const send = (method, params) => cdp.send(method, params, sessionId)
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  const waitFor = async (expression, message, timeout = 8000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await evaluate(expression)) return
      await pause(80)
    }
    throw new Error(message)
  }
  cdp.on("Runtime.exceptionThrown", (event, eventSession) => {
    if (eventSession === sessionId) report.pageErrors.push({ source: "page", message: event.exceptionDetails.exception?.description || event.exceptionDetails.text })
  })
  cdp.on("Fetch.requestPaused", async (event, eventSession) => {
    if (eventSession !== sessionId) return
    const url = new URL(event.request.url)
    let bytes
    let mime = "text/plain; charset=utf-8"
    let status = 200
    if (url.origin !== virtualOrigin) {
      report.blockedRequests.push(event.request.url)
      status = 403
      bytes = Buffer.from("External request blocked by local verification")
    } else if (url.pathname === "/_magpie/bridge.js") {
      mime = "text/javascript; charset=utf-8"
      bytes = Buffer.from(mockBridge())
    } else if (url.pathname === "/state.js") {
      mime = "text/javascript; charset=utf-8"
      const state = { ...currentFixture, updatedAt: new Date(Date.parse(currentFixture.updatedAt) + stateVersion * 1000).toISOString() }
      bytes = Buffer.from(`window.__cacheGuardState = ${JSON.stringify(state)};`)
    } else if (url.pathname === "/__verification/refresh") {
      stateVersion++
      bytes = Buffer.from("ok")
    } else if (url.pathname === "/favicon.ico") {
      status = 204
      bytes = Buffer.alloc(0)
    } else {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
      bytes = sources.get(name)
      if (!bytes) { status = 404; bytes = Buffer.from("No mock asset") }
      mime = name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".css") ? "text/css; charset=utf-8" : name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : name.endsWith(".ico") ? "image/x-icon" : "image/svg+xml"
    }
    await send("Fetch.fulfillRequest", {
      requestId: event.requestId, responseCode: status,
      responseHeaders: [{ name: "Content-Type", value: mime }, { name: "Cache-Control", value: "no-store" }, ...(hostSandbox && url.pathname === "/index.html" ? [{name:"Content-Security-Policy",value:"sandbox allow-scripts"}] : [])],
      body: bytes.toString("base64"),
    })
  })
  await send("Page.enable")
  await send("Runtime.enable")
  await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] })
  await send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Shanghai" })
  await send("Emulation.setLocaleOverride", { locale: "zh-CN" })

  async function capturePreview(name, width) {
    const metrics = await send("Page.getLayoutMetrics")
    const content = metrics.cssContentSize || metrics.contentSize
    const capture = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.ceil(content.height), scale: 1 } })
    const file = path.join(outputDir, `${name}.png`)
    await fs.writeFile(file, Buffer.from(capture.data, "base64"))
    report.screenshots.push({ name, theme: currentTheme, width, height: Math.ceil(content.height), file })
  }

  async function openPreview(theme, width, height = 1000) {
    currentTheme = theme
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] })
    await send("Emulation.setDefaultBackgroundColorOverride", { color: theme === "dark" ? { r: 10, g: 11, b: 13, a: 1 } : { r: 255, g: 255, b: 255, a: 1 } })
    await send("Page.navigate", { url: `${virtualOrigin}/index.html?theme=${theme}&width=${width}` })
    await waitFor('document.querySelectorAll("#tabs button").length === 4 && !!window.__verification && !!window.__cacheGuardState && document.querySelector("#stats")?.getAttribute("aria-busy") !== "true"', "Preview did not render four ranges and fixture state")
    await evaluate('document.fonts.ready.then(() => true)')
    await pause(120)
  }

  for (const [name, theme, width, height] of [
    ["desktop-light", "light", 1440, 1000], ["desktop-dark", "dark", 1440, 1000],
    ["narrow-light", "light", 640, 1000], ["narrow-dark", "dark", 640, 1000],
  ]) {
    await openPreview(theme, width, height)
    await evaluate('document.querySelector(\'#tabs button[data-range="today"]\').click()')
    const layout = await evaluate(`({width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, theme: document.documentElement.dataset.theme, stats: document.querySelectorAll("#stats .stat, #stats .metric").length, rows: document.querySelectorAll("#groups tbody tr").length, background: getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim()})`)
    check(`${name}: rendered stats and rows`, layout.stats === 5 && layout.rows === fixture.ranges[1].groups.length, layout)
    check(`${name}: no viewport horizontal overflow`, layout.scrollWidth <= width, layout)
    const panels = await evaluate(`(() => {
      const overview = document.querySelector(".dashboard"), details = document.querySelector(".requests-panel");
      const a = overview.getBoundingClientRect(), b = details.getBoundingClientRect();
      return {siblings:overview.nextElementSibling===details, gap:b.top-a.bottom, left:a.left-b.left, width:a.width-b.width, overviewBorder:getComputedStyle(overview).borderBottomWidth, detailsBorder:getComputedStyle(details).borderTopWidth, detailRange:document.querySelector('#detailTabs button[aria-selected="true"]')?.textContent, metricsOnly:!overview.querySelector("#groups")&&!!details.querySelector("#groups")};
    })()`)
    check(`${name}: overview and requests are separate aligned cards with a visible gap`, panels.siblings && panels.gap >= 20 && Math.abs(panels.left) < .6 && Math.abs(panels.width) < .6 && panels.overviewBorder === "1px" && panels.detailsBorder === "1px" && panels.metricsOnly && panels.detailRange === "今天", panels)
    if (name === "desktop-light") {
      const clip = await evaluate(`(() => {
        const overview=document.querySelector(".dashboard").getBoundingClientRect(), details=document.querySelector(".requests-panel").getBoundingClientRect();
        return {x:overview.left-12,y:overview.top+scrollY-12,width:overview.width+24,height:details.bottom-overview.top+24,scale:1};
      })()`)
      const split = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip })
      const file = path.join(outputDir, "separate-cards-light.png")
      await fs.writeFile(file, Buffer.from(split.data, "base64"))
      report.screenshots.push({name:"separate-cards-light", theme, width:clip.width, height:clip.height, file})
    }
    const metrics = await send("Page.getLayoutMetrics")
    const content = metrics.cssContentSize || metrics.contentSize
    const capture = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.ceil(content.height), scale: 1 } })
    const filename = `${name}.png`
    await fs.writeFile(path.join(outputDir, filename), Buffer.from(capture.data, "base64"))
    report.screenshots.push({ name, theme, width, height: Math.ceil(content.height), file: path.join(outputDir, filename) })
  }

  for (const [theme, width] of [["light", 640], ["dark", 390]]) {
    await openPreview(theme, width)
    await evaluate('document.getElementById("settingsPanel").open = true')
    await capturePreview(`settings-${theme}-${width}`, width)
    const overflow = await evaluate('document.documentElement.scrollWidth <= innerWidth')
    check(`Expanded settings ${width}px has no page overflow`, overflow)
  }

  currentFixture = { ...fixture, config: { ...fixture.config, threshold: .95 } }
  await openPreview("light", 1000)
  await evaluate('document.querySelector(\'#tabs button[data-range="today"]\').click()')
  const thresholdTone = await evaluate('Array.from(document.querySelectorAll("#groups tbody tr")).find(row => row.innerText.includes("codex-auto-review"))?.querySelector(".hit-cell")?.classList.contains("tone-low")')
  check("Table tone uses configured threshold rather than fixed 80 percent", thresholdTone)
  const alertComparison = await evaluate('Array.from(document.querySelectorAll(".alert-row"),row=>({text:row.innerText,measures:row.querySelectorAll(".alert-measure").length,legacy:!!row.querySelector(".is-legacy")}))')
  check("Alerts compare actual values with rules captured at trigger time",alertComparison[0].text.includes("42.1%")&&alertComparison[0].text.includes("触发阈值 80.0%")&&!alertComparison[0].text.includes("95.0%")&&alertComparison[0].text.includes("5 次")&&alertComparison[0].text.includes("30,000")&&alertComparison[0].text.includes("15,000")&&alertComparison[0].measures===3,alertComparison[0])
  check("Legacy alerts identify current threshold without inventing historical rules",alertComparison[1].legacy&&alertComparison[1].text.includes("当前阈值 95.0%")&&alertComparison[1].text.includes("未保存触发时阈值")&&alertComparison[1].measures===1,alertComparison[1])
  const narrowAlert = {t:fixture.alerts[0].t,key:"codex/dsh/gpt-6.1-sol",hit:.088,reads:3968,prompts:47388,rule:{threshold:.8,consecutive:5,minPrompt:15000},observed:{requests:5,belowThreshold:5,hitMin:.06,hitMax:.11,promptMin:42000}}
  currentFixture = {...fixture,alerts:[narrowAlert]}
  for (const [theme,width] of [["light",1220],["dark",1220],["light",390]]) {
    await openPreview(theme,width)
    check(`Alert comparison ${theme} ${width}px stays in viewport`,await evaluate('document.documentElement.scrollWidth<=innerWidth && Array.from(document.querySelectorAll(".alert-measure")).every(item=>item.getBoundingClientRect().right<=innerWidth)'),width)
    await capturePreview(`alert-comparison-${theme}-${width}`,width)
  }
  currentFixture = fixture
  await openPreview("light", 1440)
  const tabs = await evaluate(`(() => {
    const results = [];
    for (const button of document.querySelectorAll("#tabs button")) {
      button.click();
      results.push({id:button.dataset.range, label:button.textContent, detailRange:document.querySelector('#detailTabs button[aria-selected="true"]')?.textContent, selected:button.getAttribute("aria-selected"), rows:document.querySelectorAll("#groups tbody tr").length, stats:document.querySelector("#stats").innerText});
    }
    return results;
  })()`)
  check("All four range tabs select and render their own data", tabs.every((tab) => tab.selected === "true" && tab.rows === fixture.ranges.find((range) => range.id === tab.id).groups.length && tab.detailRange === tab.label), tabs)

  const columns = await evaluate(`(() => {
    const snapshots = [];
    for (const tab of document.querySelectorAll("#tabs button")) {
      tab.click();
      const table = document.getElementById("groups");
      const bounds = table.getBoundingClientRect();
      const head = Array.from(table.querySelectorAll("th"), cell => ({x:cell.getBoundingClientRect().x-bounds.x,width:cell.getBoundingClientRect().width}));
      const row = table.querySelector("tbody tr");
      const body = row ? Array.from(row.cells, cell => ({x:cell.getBoundingClientRect().x-bounds.x,width:cell.getBoundingClientRect().width})) : [];
      snapshots.push({id:tab.dataset.range, width:bounds.width, head, body, layout:getComputedStyle(table).tableLayout});
    }
    return snapshots;
  })()`)
  const sameColumns = (left, right) => left.length === right.length && left.every((cell, index) => Math.abs(cell.x - right[index].x) < .6 && Math.abs(cell.width - right[index].width) < .6)
  check("All tabs keep identical fixed table and header widths", columns.every(item => item.layout === "fixed" && Math.abs(item.width-columns[0].width)<.6 && sameColumns(item.head,columns[0].head)), columns)
  check("Headers and data rows share the same column boundaries", columns.every(item => !item.body.length || sameColumns(item.head,item.body)), columns)

  await evaluate('document.querySelector(\'#tabs button[data-range="today"]\').click()')
  const dataCells = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll("#groups tbody tr"));
    const timed = rows.find(row => row.innerText.includes("claude-opus-5-5@300k"));
    const untimed = rows.find(row => row.innerText.includes("codex-auto-review"));
    const zeroWrite = rows.find(row => row.innerText.includes("dfmodel"));
    return {
      headers:Array.from(document.querySelectorAll("#groups th"),cell=>cell.textContent),
      headerCount:document.querySelectorAll("#groups th").length,
      timed:timed?.cells[5]?.innerText, timedTitle:timed?.cells[5]?.title,
      untimed:untimed?.cells[5]?.innerText, read:timed?.cells[6]?.innerText, writeZero:zeroWrite?.cells[7]?.innerText,
      summary:document.getElementById("stats").innerText,
      icons:rows.map(row => ({text:row.cells[0].innerText, svg:!!row.cells[0].querySelector("svg use"), image:!!row.cells[0].querySelector("img"), monogram:!!row.cells[0].querySelector(".entity-monogram")}))
    };
  })()`)
  check("Headers and row values follow requests, hit, speed, read, write order",dataCells.headers.join("|") === "客户端|供应商|模型|请求数|命中率|平均速度|缓存读取|缓存写入" && dataCells.read === "8.5M",dataCells)
  check("Speed has its own column and summary metric", dataCells.headerCount === 8 && /130/.test(dataCells.summary) && /127/.test(dataCells.timed), dataCells)
  check("Missing timings are shown as unavailable rather than zero speed", /—|暂无|无计时/.test(dataCells.untimed ?? ""), dataCells)
  check("All-zero writes are labeled as unobserved rather than proven zero", /—|未观测/.test(dataCells.writeZero ?? ""), dataCells)
  check("Client names have icons rather than first-letter monograms", dataCells.icons.every(item => (item.svg || item.image) && !item.monogram), dataCells.icons)

  const search = await evaluate(`(() => {
    const field = document.getElementById("search");
    if (!field) return null;
    field.value = "codex-auto-review"; field.dispatchEvent(new Event("input", {bubbles:true}));
    const matched = document.querySelectorAll("#groups tbody tr").length;
    field.value = "no-such-client-model"; field.dispatchEvent(new Event("input", {bubbles:true}));
    const emptyVisible = !document.getElementById("tableEmpty").hidden;
    field.value = ""; field.dispatchEvent(new Event("input", {bubbles:true}));
    return {matched, emptyVisible, restored:document.querySelectorAll("#groups tbody tr").length};
  })()`)
  if (search) check("Client/model search filters, shows no-result state, and clears", search.matched === 1 && search.emptyVisible && search.restored === fixture.ranges[1].groups.length, search)
  const keyboardTab = await evaluate(`(() => {
    const tab = document.querySelector('#tabs button[data-range="today"]');
    tab.focus(); tab.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowRight",bubbles:true}));
    return {selected:document.querySelector('#tabs button[aria-selected="true"]')?.dataset.range, focused:document.activeElement?.dataset.range};
  })()`)
  check("Arrow key moves selected and focused range tab", keyboardTab.selected === "7d" && keyboardTab.focused === "7d", keyboardTab)
  const detailTabs = await evaluate(`(() => {
    const results=[];
    for (const button of document.querySelectorAll('#detailTabs button')) {
      button.click();
      results.push({id:button.dataset.range,top:document.querySelector('#tabs button[aria-selected="true"]')?.dataset.range,bottom:document.querySelector('#detailTabs button[aria-selected="true"]')?.dataset.range,rows:document.querySelectorAll('#groups tbody tr').length,stats:document.querySelector('#stats').textContent});
    }
    const tab=document.querySelector('#detailTabs button[data-range="today"]');
    tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    return {results,focus:document.activeElement?.id,top:document.querySelector('#tabs button[aria-selected="true"]')?.dataset.range,bottom:document.querySelector('#detailTabs button[aria-selected="true"]')?.dataset.range,idsUnique:new Set(Array.from(document.querySelectorAll('[id]'),el=>el.id)).size===document.querySelectorAll('[id]').length};
  })()`)
  check("Detail tabs update both cards and keep keyboard focus in the lower control",detailTabs.idsUnique&&detailTabs.focus==="detailTabs-7d"&&detailTabs.top==="7d"&&detailTabs.bottom==="7d"&&detailTabs.results.every(tab=>tab.id===tab.top&&tab.id===tab.bottom&&tab.rows===fixture.ranges.find(range=>range.id===tab.id).groups.length),detailTabs)

  await evaluate(`(() => {
    const panel = document.getElementById("settingsPanel"); panel.open = true;
    document.getElementById("notify").value = "os";
    document.getElementById("notify").dispatchEvent(new Event("change",{bubbles:true}));
    document.getElementById("save").click();
    document.getElementById("save").click();
  })()`)
  await waitFor('window.__verification.options.notify === "os" && document.getElementById("saved").textContent === "设置已保存"',"Screenshot notification change did not save with default numeric fields")
  const notificationSave = await evaluate('({options:window.__verification.options,writes:window.__verification.calls.filter(call=>call.method==="set").length,buttonType:document.getElementById("save").type,forms:document.querySelectorAll("form").length})')
  check("Notification-only change saves from a button click with default values",notificationSave.options.notify==="os"&&notificationSave.options.minPrompt===15000&&notificationSave.options.minRequests===10,notificationSave)
  check("Repeated Save clicks write once and never submit a form",notificationSave.writes===1&&notificationSave.buttonType==="button"&&notificationSave.forms===0,notificationSave)
  await evaluate('document.getElementById("notify").value="toast";document.getElementById("notify").dispatchEvent(new Event("change",{bubbles:true}));document.getElementById("consecutive").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))')
  await waitFor('window.__verification.options.notify === "toast" && document.getElementById("saved").textContent === "设置已保存"',"Enter key did not save settings")
  check("Enter in settings inputs saves through the same button handler",true)

  await evaluate(`(() => {
    const select = document.getElementById("cadence"); select.value = "30"; select.dispatchEvent(new Event("change", {bubbles:true}));
  })()`)
  await waitFor('window.__verification.calls.some(call => call.method === "set" && call.value.pollSec === 30)', "Cadence did not call mock options.set")
  const cadence = await evaluate('window.__verification.options')
  check("Cadence persists pollSec through mock bridge and preserves other options", cadence.pollSec === 30 && cadence.threshold === fixture.config.threshold, cadence)

  await evaluate(`(() => {
    const panel = document.getElementById("settingsPanel"); if (panel) panel.open = true;
    document.getElementById("threshold").value = "75";
    document.getElementById("consecutive").value = "7";
    document.getElementById("minPrompt").value = "20000";
    document.getElementById("minRequests").value = "12";
    document.getElementById("cooldownSec").value = "2400";
    document.getElementById("notify").value = "log";
    document.getElementById("ignore").value = " qoder/codex/,  cursor/dsh/ , ";
    document.getElementById("settings").dispatchEvent(new Event("input", {bubbles:true}));
    document.getElementById("save").click();
  })()`)
  await waitFor('window.__verification.options.threshold === 0.75 && document.getElementById("saved").textContent.includes("已保存")', "Save did not settle through mock bridge")
  const saved = await evaluate('window.__verification.options')
  check("Settings submit normalizes percent and ignore prefixes", saved.threshold === 0.75 && saved.consecutive === 7 && saved.minPrompt === 20000 && saved.minRequests === 12 && saved.cooldownSec === 2400 && saved.notify === "log" && saved.ignore.join("|") === "qoder/codex/|cursor/dsh/", saved)
  check("Settings preserve host-only options and selected cadence", saved.maxAlertsPerHour === fixture.config.maxAlertsPerHour && saved.pollSec === 30, saved)

  await evaluate('document.getElementById("refresh").click()')
  await waitFor('window.__verification.refreshes > 0 && !document.getElementById("refresh").disabled', "Refresh did not finish")
  const refresh = await evaluate('({calls:window.__verification.refreshes,marker:window.__verification.options._refreshAt,updated:document.getElementById("updated").textContent})')
  check("Manual refresh sends mock marker and returns button to enabled", refresh.calls === 1 && Number.isFinite(refresh.marker), refresh)

  const disclosure = await evaluate(`(() => {
    const panel = document.getElementById("alertPanel");
    const before = panel.open; panel.querySelector("summary").click();
    const after = panel.open; panel.querySelector("summary").click();
    return {before, after, restored:panel.open};
  })()`)
  check("Alert disclosure collapses and expands", disclosure.before !== disclosure.after && disclosure.restored === disclosure.before, disclosure)

  const writesBeforeInvalid = await evaluate('window.__verification.calls.filter(call => call.method === "set").length')
  await evaluate(`(() => {
    const field = document.getElementById("threshold"); field.value = "101";
    field.dispatchEvent(new Event("input", {bubbles:true}));
    document.getElementById("save").click();
  })()`)
  const invalid = await evaluate('({invalid:!document.getElementById("threshold").checkValidity(),writes:window.__verification.calls.filter(call => call.method === "set").length,feedback:document.getElementById("saved").textContent,focused:document.activeElement?.id,aria:document.getElementById("threshold").getAttribute("aria-invalid")})')
  check("Invalid threshold cannot write settings", invalid.invalid && invalid.writes === writesBeforeInvalid, invalid)
  check("Invalid input shows feedback beside Save and focuses the field",invalid.feedback.includes("命中率阈值") && invalid.focused === "threshold" && invalid.aria === "true",invalid)

  await evaluate(`(() => {
    const field = document.getElementById("threshold"); field.value = "76";
    field.dispatchEvent(new Event("input", {bubbles:true}));
    window.__verification.failNextSet = true;
    document.getElementById("save").click();
  })()`)
  await waitFor('document.getElementById("saved").textContent.includes("保存失败")', "Mocked options failure did not show save feedback")
  const failedSave = await evaluate('({message:document.getElementById("saved").textContent,enabled:!document.getElementById("save").disabled,threshold:window.__verification.options.threshold})')
  check("Bridge save failure displays feedback and permits retry", failedSave.enabled && failedSave.threshold === 0.75, failedSave)
  await evaluate('document.getElementById("save").click()')
  await waitFor('window.__verification.options.threshold === .76', "Save retry did not succeed")
  check("Failed save can be retried without losing edited values", await evaluate('document.getElementById("threshold").value === "76"'))

  await evaluate(`(() => {
    document.getElementById("minPrompt").value = "0";
    document.getElementById("settings").dispatchEvent(new Event("input", {bubbles:true}));
    document.getElementById("save").click();
  })()`)
  await waitFor('window.__verification.options.minPrompt === 0', "Zero token minimum was not preserved")
  check("Zero token minimum saves without reverting to default", true)

  await evaluate(`(() => {
    const cadence = document.getElementById("cadence");
    window.__verification.failNextSet = true;
    cadence.value = "60"; cadence.dispatchEvent(new Event("change", {bubbles:true}));
  })()`)
  await waitFor('!document.getElementById("cadence").disabled && document.getElementById("notice").textContent.includes("未保存")', "Cadence failure feedback missing")
  check("Cadence failure restores the last successfully saved value", await evaluate('document.getElementById("cadence").value === "30"'))

  await evaluate('window.__verification.failNextSet = true; document.getElementById("refresh").click()')
  await waitFor('!document.getElementById("refresh").disabled && document.getElementById("notice").textContent.includes("刷新暂未完成")', "Refresh failure did not recover")
  check("Refresh write failure restores the button and reports error", true)

  currentFixture = { ...fixture, alerts: [], ranges: fixture.ranges.map((range) => ({ ...range, requests: 0, read: 0, write: 0, prompt: 0, hit: 0, hidden: 0, writeSeen: false, writeZeroGroups: 0, speed: {replies:0,tokens:0,decodeMs:0,tps:null,requests:0,coverage:0}, groups: [] })) }
  await openPreview("light", 640)
  const empty = await evaluate('({emptyVisible:!(document.getElementById("tableEmpty") || document.getElementById("empty")).hidden,alert:document.getElementById("alerts").textContent,rows:document.querySelectorAll("#groups tbody tr").length})')
  check("Zero-request fixture shows empty states", empty.emptyVisible && empty.rows === 0, empty)
  const emptyCards = await evaluate('(() => {const a=document.querySelector(".dashboard"),b=document.querySelector(".requests-panel");return {separate:!a.contains(document.getElementById("tableEmpty"))&&b.contains(document.getElementById("tableEmpty")),gap:b.getBoundingClientRect().top-a.getBoundingClientRect().bottom};})()')
  check("Empty request details remain in their own card", emptyCards.separate && emptyCards.gap >= 20, emptyCards)
  await capturePreview("empty-light", 640)
  check("No-alert panel starts collapsed", await evaluate('!document.getElementById("alertPanel").open'))

  currentFixture = { ...fixture, ranges: fixture.ranges.map((range) => range.id === "1h" ? { ...range, requests: 0, groups: [] } : range) }
  await openPreview("dark", 1440)
  const fallback = await evaluate('document.querySelector(\'#tabs button[aria-selected="true"]\')?.dataset.range')
  check("Empty 1h range initially falls back to populated history", fallback === "today", fallback)

  const periodLabels = await evaluate('({labels:Array.from(document.querySelectorAll("#tabs button"),button=>button.textContent),hints:document.getElementById("rangeHint").textContent})')
  check("Period tabs are 1h, today, 7d and 30d", periodLabels.labels.join("|") === "1小时|今天|7天|30天", periodLabels)
  await evaluate('document.querySelector(\'#tabs button[data-range="today"]\').click()')
  check("Today range states its midnight start", await evaluate('document.getElementById("rangeHint").textContent.includes("今天 00:00 起")'))

  currentFixture = { ...fixture, ranges: fixture.ranges.map((range, index) => ({ ...range, id: ["live","1d","7d","30d"][index] })) }
  await openPreview("light", 1137)
  const staleHost = await evaluate('({notice:document.getElementById("notice").textContent,shown:!document.getElementById("notice").hidden,selected:document.querySelector(\'#tabs button[aria-selected="true"]\')?.dataset.range})')
  check("Stale host range ids announce the missing periods instead of failing silently", staleHost.shown && staleHost.notice.includes("1小时") && staleHost.notice.includes("今天") && staleHost.notice.includes("停用再启用") && staleHost.selected === "7d", staleHost)
  currentFixture = {...fixture,ranges:fixture.ranges.map(range=>range.id==="today"?{...range,speed:{...range.speed,tps:96.296677},groups:range.groups.map((group,index)=>index===0?{...group,tps:96.296677}:group)}:range)}
  await openPreview("light",1137)
  await evaluate('document.querySelector(\'#tabs button[data-range="today"]\').click()')
  const hostRounding = await evaluate('({summary:document.querySelector("#stats .metric:last-child .metric-value").textContent,speed:document.querySelector("#groups tbody tr").cells[5].textContent,title:document.querySelector("#groups tbody tr").cells[5].title})')
  check("Sub-100 speeds use host integer rounding and explain timing filters",hostRounding.summary==="96t/s"&&hostRounding.speed==="96t/s"&&hostRounding.title.includes("magpie 用量页")&&hostRounding.title.includes("Prompt 下限"),hostRounding)

  currentFixture = {...fixture, speedMethod:undefined}
  await openPreview("light",1137)
  const staleSpeed = await evaluate('({notice:document.getElementById("notice").textContent,summary:document.getElementById("stats").textContent,values:Array.from(document.querySelectorAll("#groups tbody tr"),row=>row.cells[5].innerText)})')
  check("Old backend speed values are hidden with a reload instruction",staleSpeed.notice.includes("停用再启用")&&staleSpeed.summary.includes("速度口径待更新")&&staleSpeed.values.every(value=>value==="—"),staleSpeed)

  const metricRows = `(() => {
    const box = document.getElementById("stats");
    const inner = box.getBoundingClientRect();
    const tabs = document.querySelector(".period-tabs").getBoundingClientRect();
    const firstLabel = document.querySelector(".metric .metric-label").getBoundingClientRect();
    const cells = Array.from(box.children, (cell) => {
      const rect = cell.getBoundingClientRect();
      const style = getComputedStyle(cell);
      const label = cell.querySelector(".metric-label").getBoundingClientRect();
      const value = cell.querySelector(".metric-value").getBoundingClientRect();
      const meta = cell.querySelector(".metric-meta").getBoundingClientRect();
      return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,label:label.top,value:value.top,meta:meta.top,overflow:cell.scrollWidth>cell.clientWidth,leftBorder:style.borderLeftWidth,topBorder:style.borderTopWidth,valueGap:value.top-label.bottom,metaGap:meta.top-value.bottom};
    });
    return {cells, rowGap:getComputedStyle(box).rowGap, align:Math.abs(firstLabel.left-tabs.left), bottom:inner.bottom-Math.max(...cells.map(cell=>cell.bottom)), rowsCount:new Set(cells.map(cell=>cell.top)).size, clipped:inner.right>innerWidth};
  })()`
  const wrapped = []
  for (const width of [1440, 1028, 880, 560, 390]) {
    currentFixture = fixture
    await openPreview("light", width)
    const measure = await evaluate(metricRows)
    wrapped.push({ width, ...measure })
    await capturePreview(`metrics-spacing-light-${width}`, width)
  }
  check("Metrics use consistent padding and spacing without internal cut lines", wrapped.every(entry=>entry.align<1&&entry.bottom>=16&&entry.rowGap==="24px"&&!entry.clipped&&entry.cells.every(cell=>cell.leftBorder==="0px"&&cell.topBorder==="0px"&&!cell.overflow&&Math.abs(cell.valueGap-8)<1&&Math.abs(cell.metaGap-8)<1)),wrapped)
  const compactGroups = [
    {...fixture.ranges[1].groups[2],count:642,hit:71.1},
    {...fixture.ranges[1].groups[5],count:479,hit:96.6},
  ]
  currentFixture = {...fixture,alerts:[],ranges:fixture.ranges.map(range=>({...range,write:0,writeSeen:false,groups:compactGroups}))}
  for (const [theme,width] of [["light",880],["dark",880],["light",622]]) {
    await openPreview(theme,width)
    const compact = await evaluate(`(() => {
      const table=document.getElementById("groups"),scroller=table.parentElement;
      const natural=table.dataset.naturalWidths.split(",").map(Number);
      const headers=Array.from(table.querySelectorAll("th"),cell=>cell.getBoundingClientRect().width);
      const contents=Array.from(table.querySelectorAll("tbody tr"),row=>Array.from(row.cells,cell=>({width:cell.clientWidth,scroll:cell.scrollWidth})));
      return {table:table.getBoundingClientRect().width,viewport:scroller.clientWidth,natural,naturalTotal:natural.reduce((sum,width)=>sum+width,0),headers,slack:headers.map((width,index)=>Math.round(width-natural[index])),contents,pageOverflow:document.documentElement.scrollWidth>innerWidth};
    })()`)
    check(`Short model rows ${theme} ${width}px size columns by content and share extra width evenly`,(compact.naturalTotal<=compact.viewport?Math.abs(compact.table-compact.viewport)<=1:compact.table>=compact.viewport-1)&&compact.slack.every(value=>value>=0&&value<=48)&&!compact.pageOverflow&&compact.contents.every(row=>row.every(cell=>cell.scroll<=cell.width)),compact)
    if (width === 622) {
      await send("Emulation.setDeviceMetricsOverride", {width,height:1000,deviceScaleFactor:2,mobile:false})
      await pause(120)
    }
    const clip = await evaluate('(() => {const a=document.querySelector(".dashboard").getBoundingClientRect(),b=document.querySelector(".requests-panel").getBoundingClientRect();return {x:a.left-8,y:a.top+scrollY-8,width:a.width+16,height:b.bottom-a.top+16,scale:1}})()')
    const capture = await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true,clip})
    const file=path.join(outputDir,`content-fit-${theme}-${width}.png`)
    await fs.writeFile(file,Buffer.from(capture.data,"base64"))
    report.screenshots.push({name:`content-fit-${theme}-${width}`,theme,width:clip.width,height:clip.height,file})
  }
  currentFixture = fixture

  const stressModel = "gpt-6.1-sol-" + "long-model-suffix-".repeat(20)
  const stressGroups = Array.from({length:32},(_,index) => ({...fixture.ranges[1].groups[index%fixture.ranges[1].groups.length],model:index===0?stressModel:`model-${index}`,agent:index===0?"unrecognized-client":fixture.ranges[1].groups[index%fixture.ranges[1].groups.length].agent}))
  currentFixture = {...fixture,ranges:fixture.ranges.map(range => range.id === "today" ? {...range,groups:stressGroups} : range)}
  await openPreview("light", 1137)
  const stress = await evaluate(`(() => {
    const snap = () => Array.from(document.querySelectorAll("#groups th"),cell => ({x:cell.getBoundingClientRect().x,width:cell.getBoundingClientRect().width}));
    document.querySelector('#tabs button[data-range="1h"]').click(); const short = snap();
    document.querySelector('#tabs button[data-range="today"]').click(); const many = snap();
    const first = document.querySelector("#groups tbody tr"); const model = first.cells[2].querySelector("[title]");
    const modelInfo = {title:model?.title,scroll:model?.scrollWidth,width:model?.clientWidth,overflow:model?getComputedStyle(model).textOverflow:null};
    const beforeSearch = snap(); const search = document.getElementById("search"); search.value="unrecognized-client"; search.dispatchEvent(new Event("input",{bubbles:true})); const filtered=snap();
    return {short,many,beforeSearch,filtered,model:modelInfo,unknownIcon:!!first.cells[0].querySelector("svg,img"),unknownName:first.cells[0].textContent,pageOverflow:document.documentElement.scrollWidth>innerWidth};
  })()`)
  check("Vertical scrollbar and long models do not move column boundaries", sameColumns(stress.short,stress.many) && sameColumns(stress.beforeSearch,stress.filtered),stress)
  check("Long model name is ellipsized with its full name available on hover",stress.model.title===stressModel && stress.model.scroll>stress.model.width && stress.model.overflow==="ellipsis",stress.model)
  check("Unknown clients retain a generic icon and original name",stress.unknownIcon && stress.unknownName.includes("unrecognized-client"),stress)
  check("Stress table remains inside page viewport",!stress.pageOverflow,stress)
  await capturePreview("stress-long-model-1137",1137)

  const appClients = ["magpie","zed","dsh","codex","claude","cursor","qoder","kimi","unrecognized-client"]
  currentFixture = {...fixture,ranges:fixture.ranges.map(range=>({...range,groups:appClients.map(agent=>({...fixture.ranges[1].groups[0],agent,model:`${agent}-icon-test`}))}))}
  await openPreview("light",1137)
  await pause(120)
  const appIcons = await evaluate('Array.from(document.querySelectorAll("#groups tbody tr"),row=>({name:row.cells[0].innerText,icon:!!row.cells[0].querySelector("svg use,img"),images:Array.from(row.cells[0].querySelectorAll("img"),image=>({src:image.getAttribute("src"),loaded:image.complete&&image.naturalWidth>0}))}))')
  check("Known local client icons load and unknown client falls back",appIcons.every(item=>item.icon&&item.images.every(image=>image.loaded)),appIcons)
  await capturePreview("client-icons-1137",1137)

  currentFixture = {...fixture,writeSeen:false,ranges:fixture.ranges.map(range=>({...range,write:0,writeSeen:false,groups:range.groups.map(group=>({...group,write:0,writeMax:0}))}))}
  await openPreview("light",1137)
  check("All-zero window does not claim proven zero writes",await evaluate('document.querySelectorAll("#stats .metric")[2]?.innerText.includes("未观测") || document.querySelectorAll("#stats .metric")[2]?.innerText.includes("—")'))
  await capturePreview("unobserved-write-1137",1137)
  check("No uncaught page exceptions", report.pageErrors.length === 0, report.pageErrors)
  check("No external page requests", report.blockedRequests.length === 0, report.blockedRequests)
} catch (error) {
  report.fatalError = error.stack || error.message
} finally {
  if (cdp) {
    try {
      if (browserContextId) await cdp.send("Target.disposeBrowserContext", { browserContextId })
      else if (!cdpEndpoint) await cdp.send("Browser.close")
    } catch {}
    cdp.socket.close()
  }
  if (child && child.exitCode === null) {
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), pause(2000)])
    if (child.exitCode === null) child.kill()
  }
  const resolvedProfile = path.resolve(profileDir)
  if (resolvedProfile.startsWith(outputDir + path.sep) && path.basename(resolvedProfile) === `chrome-profile-${process.pid}`) {
    try { await fs.rm(resolvedProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }) }
    catch (error) { report.profileCleanupWarning = error.message }
  }
  await browserLog?.close()
  report.passed = !report.fatalError && report.checks.every((entry) => entry.pass)
  await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.checks.filter((entry) => !entry.pass), fatalError: report.fatalError, report: path.join(outputDir, "report.json"), screenshots: report.screenshots }, null, 2))
  if (!report.passed) process.exitCode = 1
}
