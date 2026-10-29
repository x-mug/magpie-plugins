# Magpie 插件仓库

面向 [Magpie](https://usemagpie.ai) 的插件集合，与 [DSH 插件仓库](https://github.com/x-mug/dsh-plugins) 分开维护。插件放在 `plugins/` 下，各自版本、独立安装包；仓库 Release 汇总安装包和 SHA256。当前已核对 **Magpie 0.1.1989**。

| 插件 | 版本 | 功能 | 说明 |
| --- | --- | --- | --- |
| `magpie-cache-guard` 缓存看守 | 0.8.0 | 按供应商 / 客户端 / 模型统计命中率，连续低命中告警；含 Magpie 内嵌看板与设置 | [使用说明](plugins/magpie-cache-guard/README.md) |

![缓存看守：概览与明细的时间范围双向同步](docs/cache-guard-light.png)

截图使用合成测试数据。

## 安装

1. 打开 [Releases](https://github.com/x-mug/magpie-plugins/releases)，下载需要的插件 `.tgz` 和可选的 `SHA256SUMS.txt`。
2. 将 `.tgz` 解压到固定目录，得到 `package` 文件夹；不要把插件留在下载器的临时解压目录。
3. 在 Magpie 打开 **Plugins → 添加插件**，输入该 `package` 文件夹的本机绝对路径。装好后侧边栏会出现 **缓存看守**。
4. 阈值、通知、忽略组、刷新周期都在 Magpie 的插件页面内调整。升级时替换该目录的文件，后端逻辑变更后在 Magpie 中停用再启用插件。

Magpie 支持加载本地插件目录。本仓库根目录是开发工具包，**不能把根目录或 `x-mug/magpie-plugins` 当作单个插件安装**；当前 Git 仓库 spec 按根目录解析，不支持这里的插件子目录。安装方式依据 [Magpie 官方插件文档](https://usemagpie.ai/docs/plugins#run)。

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
```

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
