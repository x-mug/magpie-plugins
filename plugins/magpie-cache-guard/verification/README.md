# 验证

默认测试全部使用临时账本与合成页面状态：

```sh
node verification/backend-speed.mjs
node verification/run-browser.mjs --browser /path/to/chrome
```

页面脚本需要 Node.js 24 和已安装的 Chrome / Edge，Windows 默认尝试 Chrome 标准路径，也可用 `CHROME_PATH` 或 `--browser` 指定。结果与截图写到 `verification/output/`，该目录不会提交或打包。浏览器通过 CDP 拦截本地虚拟页面请求，不启动 Web 服务，不操作已安装的 Magpie，不发送模型请求。

当前版本通过 25 项后端检查与 67 项页面检查。页面涵盖浅色/深色、桌面/窄窗口、双向同步的时间范围和键盘导航、按内容测量的列宽、搜索、长模型名、空状态、保存失败与重试、旧后端提示。截图为合成数据，不等同于安装客户端的人工验收。

可选的真实账本只读对账：

```sh
node verification/backend-real.mjs --range=today --ledger=/path/to/usage.jsonl
```

它检查生产聚合与复算是否一致；逐条测速选择复用生产函数，不独立证明测速规则。

可选的宿主实现对照（适用于包含 `ledDecode` 文本的 Magpie Windows EXE）：

```sh
node verification/backend-host-speed.mjs --binary=/path/to/magpie.exe --ledger=/path/to/usage.jsonl
```

该脚本提取 EXE 内真实的 `ledDecode` JavaScript，与插件 `timedOf` 对每行账本核对。若宿主升级后函数、依赖或边界改变，应重新核查规则。测速按可测输出 token / 可测生成时长加权；有正文时间的推理请求只算 `out-reasoning` 与 `ms-first_text_ms`，无充分证据、过短窗口和集中回传不计入。无推理使用 `out` 与 `ms-ttft_ms`。`flow_ms` 用于可靠性过滤，不直接作分母。

所有脚本均不发模型请求。真实数据、用户目录、请求记录和宿主二进制不随仓库发布。
