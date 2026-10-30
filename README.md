# Magpie 插件仓库

面向 [Magpie](https://usemagpie.ai) 的插件集合，与 [DSH 插件仓库](https://github.com/x-mug/dsh-plugins) 分开维护。插件放在 `plugins/` 下，各自版本、独立安装包；仓库 Release 汇总安装包和 SHA256。当前已核对 **Magpie 0.1.1989**。

| 插件 | 版本 | 功能 | 说明 |
| --- | --- | --- | --- |
| `magpie-cache-guard` 缓存看守 | 0.8.6 | 按供应商 / 客户端 / 模型统计命中率，连续低命中告警；含 Magpie 内嵌看板与设置 | [使用说明](plugins/magpie-cache-guard/README.md) · [安装仓库](https://github.com/x-mug/magpie-cache-guard) |

![缓存看守：概览与明细的时间范围双向同步](docs/cache-guard-light.png)

截图使用合成测试数据。

## 安装

在 Magpie 的 **Plugins → 添加插件** 输入 `github:x-mug/magpie-cache-guard`，或在 **Discover → Unofficial, on GitHub** 搜索 `magpie-cache-guard`。命令行也可安装：

```sh
magpie plugin add github:x-mug/magpie-cache-guard
```

[独立安装仓库](https://github.com/x-mug/magpie-cache-guard) 由本仓库的插件子目录自动生成；它的根目录就是完整插件，支持 Magpie 直接安装。首次出现在发现页需等待 GitHub 搜索索引与 Magpie 十分钟缓存刷新。

阈值、通知、忽略组、刷新周期都在 Magpie 页面内调整。离线安装可从 [Releases](https://github.com/x-mug/magpie-cache-guard/releases) 下载 `.tgz`，先解压到固定目录，再添加其中 `package` 文件夹的绝对路径。

本源码仓库根目录仍是工具包，**不能把 `x-mug/magpie-plugins` 当作单个插件安装**。安装方式依据 [Magpie 官方插件文档](https://usemagpie.ai/docs/plugins#run)。

开发者也可克隆源码后添加具体插件目录：

```sh
git clone https://github.com/x-mug/magpie-plugins.git
magpie plugin add ./magpie-plugins/plugins/magpie-cache-guard
```

## 仓库结构

```text
plugins/
  magpie-cache-guard/      # 缓存看守：宿主统计、页面、测试
scripts/verify.mjs        # 语法、后端与静态页面约束检查
scripts/check-packages.mjs # 安装包内容与 SHA256 检查
.github/workflows/ci.yml  # Linux / Windows Node.js 24 验证
.github/workflows/sync-releases.yml # CI 通过后同步安装仓库并发源码 Release
plugins/magpie-cache-guard/.github/workflows/release.yml # 同步到安装仓库后发安装包 Release
```

## 两个仓库怎么配合

| 仓库 | 角色 | 维护方式 |
| --- | --- | --- |
| [magpie-plugins](https://github.com/x-mug/magpie-plugins)（本仓库） | 唯一源码入口，插件都在 `plugins/` 下 | 只改这里 |
| [magpie-cache-guard](https://github.com/x-mug/magpie-cache-guard) | 缓存看守的安装镜像，仓库根目录就是插件 | 自动生成，不要手工改 |

Magpie 装插件时认的是「仓库根目录就是插件」，而合集仓库根目录是工具包，装不了其中某个插件，所以合集里的插件要拆出一份根目录即插件的镜像仓库。这里用 `git subtree split` 而不是 submodule：镜像仓库拿到的是本仓库子目录的真实提交历史，安装端能按提交正常更新；submodule 只指向另一个仓库，仓库根目录仍然没有插件文件，Magpie 装不了。镜像仓库是构建产物，手改会让下次同步变成历史分叉。

## 发布流水线

一次 `main` 推送分三段，前一段不成功后面不跑：

1. **CI**（`.github/workflows/ci.yml`）：Linux / Windows 校验语法、后端与页面约束，打包并校验包内容，Windows 另跑浏览器回归。CI 失败时同步不会启动，安装端保持上一次可安装版本。
2. **同步 + 源码发版**（`.github/workflows/sync-releases.yml`）：CI 成功后 `git subtree split` 把插件子目录推到安装仓库 `main`，随后按 `plugins/magpie-cache-guard/package.json` 的版本发本仓库的 tag 与 Release，附件是 `.tgz` 和 `SHA256SUMS.txt`。同版本 tag 已存在时跳过，重复触发安全。
3. **安装仓库发版**：`plugins/magpie-cache-guard/.github/workflows/release.yml` 随子目录同步进安装仓库根目录后生效，按同一版本号在安装仓库发 tag 与 Release，附件是安装用 `.tgz` 和 `SHA256SUMS.txt`。

两个仓库的 tag 都是 `v<版本>`，来自同一次源码提交。部署密钥 `CACHE_GUARD_DEPLOY_KEY` 只具备安装仓库写入权限，保存在本仓库 Actions Secret 中；工作流只对本仓库 `main` 的成功 push 执行，不在 PR 中运行。安装仓库的 `magpie-plugin` Topic 用于 GitHub 自动发现。

版本号三处必须一致：`plugins/magpie-cache-guard/package.json` 的 `version`、`page/index.html` 的 `data-build` 与顶部 `#build` 徽章。`node scripts/verify.mjs` 会校验，不一致时 CI 直接失败。

### 更新是怎么被发现的

Magpie 判断插件有没有更新，读的是**独立安装仓库** `x-mug/magpie-cache-guard` 的 HEAD，不是本仓库的 `main`。本仓库推了 `main` 而同步没发生，安装端就会一直显示「已是最新」。

安装目录里的 `.bun-tag`（形如 `x-mug-magpie-cache-guard-<短sha>`）记录的就是安装当时的独立仓库提交，可以和 `git ls-remote` 对照。

本仓库是唯一源码入口，不要在独立仓库直接改文件：那会让后续同步因历史分叉被拒。

### 发版清单

1. 改代码；
2. 升版本：`plugins/magpie-cache-guard/package.json` 的 `version`、`page/index.html` 的 `data-build` 与顶部 `#build` 徽章，三处写成同一个版本（页面资源按版本缓存，不升版本安装在端可能拿旧资源）；
3. 本地验证：`node scripts/verify.mjs`；改了页面再跑 `node plugins/magpie-cache-guard/verification/run-browser.mjs`；
4. 推送 `main`，等 CI 通过、`Sync install repositories` 完成；
5. 核对两个仓库都有 `v<版本>` 的 tag 和 Release，安装仓库 HEAD 停在刚推送的提交：

   ```sh
   git ls-remote https://github.com/x-mug/magpie-cache-guard.git refs/heads/main
   gh release list -R x-mug/magpie-plugins -L 1
   gh release list -R x-mug/magpie-cache-guard -L 1
   ```

6. 在 Magpie 插件页点「检查更新」。

版本没变、只改文档时，同步照常推送；tag 已存在，两处发版都会跳过。

### 某一段没跑成时

先在本地复刻工作流的 split，推送前必须确认是快进：

```sh
git subtree split -P plugins/magpie-cache-guard -b cache-guard-sync
git merge-base --is-ancestor <独立仓库当前HEAD> cache-guard-sync   # 成功才继续
git push https://github.com/x-mug/magpie-cache-guard.git cache-guard-sync:main
```

祖先关系不成立说明两边已经分叉，此时不要强推，先查清安装仓库上有没有人直接提交。

同步或发版没跑成时，去 Actions 查原因：CI 是否失败、工作流是否被禁用、`CACHE_GUARD_DEPLOY_KEY` 是否失效。修好后用 `gh workflow run sync-releases.yml` 重跑；版本号没变时重跑会补发漏掉的 tag 和 Release，已存在的会跳过。只补源码侧漏掉的 tag 时，也可以直接 `gh release create v<版本> --target <提交>` 手动建。

## 开发和验证

需要 **Node.js 24**，核心验证不需要第三方依赖：

```sh
node scripts/verify.mjs
```

页面验证使用已安装的 Chrome / Edge，运行脚本会创建独立的无头浏览器配置和合成数据，不读取用户账本、不操作已安装的 Magpie 插件：

```sh
node plugins/magpie-cache-guard/verification/run-browser.mjs --browser /path/to/chrome
```

本机另可选择只读账本对账和与 Magpie EXE 的测速函数对照，见 [验证说明](plugins/magpie-cache-guard/verification/README.md)。这些不属于默认 CI。

打包前运行验证，在仓库根目录创建 `dist` 后进入插件目录：

```sh
npm pack --ignore-scripts --pack-destination ../../dist
```

回到仓库根目录，运行 `node scripts/check-packages.mjs` 验证安装包并生成 `dist/SHA256SUMS.txt`。

## 数据与兼容性

- 插件只读 Magpie 用量账本，不发送模型请求；页面只保存本插件选项。生成的页面状态和告警保留在用户本机，不进入源码或安装包。
- 命中率按 Prompt token 加权；测速遵循已核对的 Magpie 0.1.1989 计时规则，显示有效样本数与覆盖率。宿主升级后可重新对照。
- 概览和明细的时间范围按钮双向同步；1 小时为滚动窗口，今天从本机零点起算。
- 源码与运行时文件采用 MIT；第三方图标的许可与归属见 [图标说明](plugins/magpie-cache-guard/page/icons/README.md)。
