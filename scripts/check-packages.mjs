import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"
import { fileURLToPath } from "node:url"
import os from "node:os"
import { spawnSync } from "node:child_process"

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..")
const plugins=fs.readdirSync(path.join(root,"plugins"),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name)
const sums=[]
for(const name of plugins){
  const dir=path.join(root,"plugins",name)
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,"package.json"),"utf8"))
  const filename=`${manifest.name.replace(/^@/,"").replace(/\//g,"-")}-${manifest.version}.tgz`
  const bytes=fs.readFileSync(path.join(root,"dist",filename))
  const tar=gunzipSync(bytes)
  const files=new Map()
  for(let offset=0;offset+512<=tar.length;){
    const header=tar.subarray(offset,offset+512)
    const entry=header.subarray(0,100).toString("utf8").replace(/\0.*$/s,"")
    if(!entry)break
    const size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,"").trim(),8)||0
    assert.ok(offset+512+size<=tar.length,"Truncated package")
    assert.ok(header[156]===0||header[156]===48,`Unexpected tar entry type: ${entry}`)
    assert.ok(entry.startsWith("package/")&&!entry.split("/").includes(".."),`Unexpected path: ${entry}`)
    const relative=entry.slice(8)
    assert.ok(!/^(?:\.git\/|node_modules\/|verification\/)|(?:^|\/)state\.js(?:\.tmp)?$|(?:^|\/)usage\.jsonl$|(?:^|\/)alerts\.jsonl$/.test(relative),`Private or test data packed: ${entry}`)
    assert.ok(!files.has(relative),`Duplicate entry: ${entry}`)
    const actual=tar.subarray(offset+512,offset+512+size)
    const expected=fs.readFileSync(path.join(dir,relative))
    if(relative==="package.json")assert.deepEqual(JSON.parse(actual),JSON.parse(expected))
    else assert.ok(actual.equals(expected),`Packed bytes differ: ${entry}`)
    files.set(relative,actual)
    offset+=512+Math.ceil(size/512)*512
  }
  for(const required of ["index.mjs","package.json","README.md","LICENSE","page/index.html","page/app.js","page/style.css","page/icon.svg","page/icons/client.svg","page/icons/LICENSE.lobe-icons","page/icons/LICENSE.dsh"]){
    assert.ok(files.has(required),`Missing ${name}/${required}`)
  }
  const html=files.get("page/index.html").toString()
  for(const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)){
    if(match[1].startsWith("_magpie/"))continue
    assert.ok(files.has(`page/${match[1]}`),`Missing page resource: ${match[1]}`)
  }
  const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),"magpie-package-"))
  try {
    const installed=path.join(sandbox,"package")
    for(const [relative,data] of files){
      const output=path.join(installed,relative)
      fs.mkdirSync(path.dirname(output),{recursive:true})
      fs.writeFileSync(output,data)
    }
    const smoke=spawnSync(process.execPath,["--input-type=module","-e",`
      import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
      const directory=process.cwd();const plugin=path.join(directory,'package');const config=path.join(directory,'config');fs.mkdirSync(config);
      fs.writeFileSync(path.join(config,'plugins.json'),JSON.stringify({plugins:[{spec:plugin,options:{threshold:.7,notify:'log'}}]}));
      fs.writeFileSync(path.join(config,'usage.jsonl'),JSON.stringify({t:new Date().toISOString(),status:200,provider:'test',agent:'test',model:'test',in:1000,cache_read:39000,cache_write:0,out:100,ms:1500,ttft_ms:500})+'\\n');
      const {CacheGuardPlugin}=await import(pathToFileURL(path.join(plugin,'index.mjs')).href);await CacheGuardPlugin({directory:config},{});
      const text=fs.readFileSync(path.join(plugin,'page','state.js'),'utf8');const state=JSON.parse(text.slice(text.indexOf('=')+1).trim().replace(/;$/,''));
      assert.equal(state.config.threshold,.7);assert.equal(state.speedMethod,'magpie-decode-v1');assert.equal(state.ranges.find(r=>r.id==='today').requests,1);
    `],{cwd:sandbox,stdio:"inherit"})
    if(smoke.error)throw smoke.error
    assert.equal(smoke.status,0,"Extracted package smoke test failed")
  } finally {
    assert.ok(sandbox.startsWith(path.join(os.tmpdir(),"magpie-package-")))
    fs.rmSync(sandbox,{recursive:true,force:true})
  }
  sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${filename}`)
  console.log(`${filename}: ${files.size} verified files, ${bytes.length} bytes, extracted smoke passed`)
}
fs.writeFileSync(path.join(root,"dist","SHA256SUMS.txt"),`${sums.join("\n")}\n`)
console.log(sums.join("\n"))
