import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const plugins = fs.readdirSync(path.join(root, "plugins"), {withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name)
function run(directory, args) {
  const result = spawnSync(process.execPath,args,{cwd:directory,stdio:"inherit"})
  if (result.error) throw result.error
  assert.equal(result.status,0,`node ${args.join(" ")} failed`)
}
for (const name of plugins) {
  const dir = path.join(root,"plugins",name)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir,"package.json"),"utf8"))
  assert.equal(manifest.name,name)
  assert.ok(manifest.version && manifest.magpie?.page?.file)
  for (const file of [manifest.main,manifest.magpie.page.file,manifest.magpie.page.icon,"README.md","LICENSE"]) {
    assert.ok(file && !file.split(/[\\/]/).includes("..") && fs.existsSync(path.join(dir,file)),`Missing ${name}/${file}`)
  }
  for (const file of [manifest.main,"page/app.js","verification/run-browser.mjs"]) run(dir,["--check",file])
  run(dir,["verification/backend-speed.mjs"])
  const html=fs.readFileSync(path.join(dir,manifest.magpie.page.file),"utf8")
  assert.ok(html.includes('id="tabs"') && html.includes('id="detailTabs"'),"Both cards need range controls")
  assert.ok(!/<form\b/i.test(html),"The host sandbox blocks forms")
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html),"The host requires external script files")
  const app=fs.readFileSync(path.join(dir,"page/app.js"),"utf8")
  assert.ok(!/\b(?:fetch|WebSocket|EventSource)\s*\(/.test(app),"Page network access is blocked by Magpie")
  console.log(`Verified ${name}@${manifest.version}`)
}
console.log(`${plugins.length} plugin(s) verified`)
