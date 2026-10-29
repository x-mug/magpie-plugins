# 客户端图标来源

「客户端」列的图标只用于标识一次请求来自哪个 agent。全部取自本机安装资源，页面运行时不发任何外链请求。

图标集是有限集合：**只按 `agent` 名映射，未知 agent 一律回退到 `client.svg`，不按模型名特判。**

| 文件 | 用途 | 来源 |
|---|---|---|
| `dsh.svg` | agent `dsh` | DeepSeek Harness 安装包 `resources/app.asar` → `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg`（DSH 官方 favicon） |
| `openai.svg` | agent `codex`（Codex 属 OpenAI） | Busy Magpie 安装包 `resources/app/assets/brands/openai.svg`（lobe-icons 品牌标） |
| `claudecode-color.svg` | agent `claude` | Busy Magpie `resources/app/assets/brands/claudecode-color.svg`（品牌色 `#D97757`） |
| `cursor.svg` | agent `cursor` | Busy Magpie `resources/app/assets/brands/cursor.svg`（lobe-icons 品牌标） |
| `qoder.svg` | agent `qoder` | Busy Magpie `resources/app/assets/brands/qoder.svg`（lobe-icons 品牌标） |
| `kimi.svg` | agent `kimi` | Busy Magpie `resources/app/assets/brands/kimi.svg`（lobe-icons 品牌标） |
| `magpie.png` | agent `magpie` | Busy Magpie 主程序 exe 图标 |
| `zed.png` | agent `zed` | Zed 主程序 exe 图标 |
| `client.svg` | 其他 / 未知 agent 的统一 glyph | 本页自绘，描边风格与页面图标集一致 |

映射表见 `page/app.js` 的 `CLIENT_ICONS`。

## 主题适配

- 单色标（`dsh.svg`、`openai.svg`、`cursor.svg`、`qoder.svg`、`kimi.svg`、`client.svg`）在暗色主题下由 CSS `filter: invert(1)` 反色（`style.css` 的 `.entity-avatar[data-mono="true"]`），同一份文件在亮/暗主题都可见。
- 品牌色标（`claudecode-color.svg`）与位图应用图标（`magpie.png`、`zed.png`）不加滤镜。
- `<img>` 加载失败时先回退到 `client.svg`，再失败则隐藏元素，不会出现破图。

## 许可与归属

- `LICENSE.lobe-icons`：品牌标 `openai.svg`、`claudecode-color.svg`、`cursor.svg`、`qoder.svg`、`kimi.svg` 出自 lobe-icons，MIT，Copyright (c) 2023 LobeHub。
- `LICENSE.dsh`：`dsh.svg` 随 DSH 前端包分发，许可随该文件保留。
- `magpie.png`、`zed.png` 为对应客户端自身的应用图标，仅用于标识该客户端。

图标提取（asar 读取、exe 图标导出）是本地一次性操作：不进 `package.json` 的 `scripts`，不参与插件安装或运行时。
