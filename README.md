# Magpie 插件仓库

面向 [Magpie](https://usemagpie.ai) 的插件集合，与 [DSH 插件仓库](https://github.com/x-mug/dsh-plugins) 分开维护。插件放在 `plugins/` 下，各自版本、独立安装包；仓库 Release 汇总安装包和 SHA256。当前已核对 **Magpie 0.1.1989**。

| 插件 | 版本 | 功能 | 说明 |
| --- | --- | --- | --- |
| `magpie-cache-guard` 缓存看守 | 0.8.1 | 按供应商 / 客户端 / 模型统计命中率，连续低命中告警；含 Magpie 内嵌看板与设置 | [使用说明](plugins/magpie-cache-guard/README.md) · [安装仓库](https://github.com/x-mug/magpie-cache-guard) |

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
.github/workflows/sync-releases.yml # CI 通过后同步独立安装仓库
```

## 发布同步

本仓库是唯一源码入口。`main` 的推送通过 CI 后，`Sync install repositories` 使用 `git subtree split` 将 `plugins/magpie-cache-guard` 原样同步到 `x-mug/magpie-cache-guard` 的 `main`，保留该子目录的提交历史；也支持手动触发。部署密钥只具备目标仓库写入权限，私钥保存在主仓库的 `CACHE_GUARD_DEPLOY_KEY` Actions Secret 中，工作流只对主分支的成功 push 执行，不在 PR 中运行。目标仓库的 `magpie-plugin` Topic 用于 GitHub 自动发现。

同步失败会保留上一次可安装版本，在主仓库 Actions 修复并重新运行即可；不要直接修改发布仓库，否则后续普通推送会因历史分叉而拒绝同步。

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
