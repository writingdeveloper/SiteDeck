# SiteDeck

[English](README.md) · [한국어](README.ko.md) · [Español](README.es.md) · **中文** · [日本語](README.ja.md)

[![CI](https://github.com/writingdeveloper/SiteDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/writingdeveloper/SiteDeck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个本地仪表盘，可在**单个屏幕上汇总所有 Google Analytics 4 (GA4) 媒体资源的关键指标** — 无需逐一打开每个媒体资源。

- **指标** — 活跃用户、会话次数、关键事件（含环比 Δ% ▲▼）、热门页面、热门渠道及每日趋势迷你图
- **时间段** — 7 / 28 / 90 天切换，列可排序
- **认证** — OAuth 2.0 loopback：使用 Google 账号登录一次，即可自动收集您有权访问的所有 GA4 媒体资源
- **费用** — 免费，在 GA API 配额范围内

## 环境要求

- Node.js ≥ 20（基于 v22 开发）

## 安装

```bash
npm install
```

## Google Cloud 设置（一次性，约 5 分钟）

1. 在 [Google Cloud Console](https://console.cloud.google.com) 中创建新项目。
2. 启用 **Google Analytics Admin API** 和 **Google Analytics Data API**。
3. 配置 OAuth 同意屏幕：选择 **External**，并将自己添加为**测试用户**。
4. 创建凭据 → **OAuth client ID** → **Desktop app** → 下载 JSON 文件。
5. 将其保存为项目根目录下的 `credentials.json`（已添加到 .gitignore）。格式请参考 [`credentials.json.example`](credentials.json.example)。

## 运行

```bash
npm start        # http://localhost:4317
```

首次启动时使用 Google 账号登录一次；刷新令牌仅存储在 `~/.sitedeck/token.json` 中。

## 性能（PageSpeed）

**性能**标签页通过 PageSpeed Insights API 追踪每个站点的 Lighthouse 评分（性能、无障碍、
最佳实践、SEO）— 在应用运行期间每天自动测量一次，另有手动**측정**（立即测量）按钮。评分存储
在本地 `~/.sitedeck/insights.json` 中，URL 从每个 GA4 媒体资源的网络数据流中自动提取。

要启用此功能，请添加 PageSpeed Insights API 密钥：

1. 在同一 GCP 项目中，启用 **PageSpeed Insights API**。
2. 创建 **API key**（API 和服务 → 凭据 → 创建凭据 → API 密钥）。
3. 将其保存到 `~/.sitedeck/config.json`：
   ```json
   { "psiApiKey": "YOUR_API_KEY" }
   ```
   （或设置环境变量 `SITEDECK_PSI_KEY`）。

## 桌面应用（Electron）

以原生桌面窗口方式运行，而非在浏览器中：

```bash
npm run electron
```

Google 登录将在默认浏览器中打开（Google 会阻止在嵌入式 webview 中进行 OAuth）；认证完成后，刷新应用即可。

### 构建安装包

```bash
npm run dist          # 在 release/ 目录中构建安装包
```

桌面版本支持从 GitHub Releases **自动更新**（通过 `electron-updater`）。要发布已安装应用将更新到的版本：

```bash
npm version patch                 # 升级版本号 + 创建标签
GH_TOKEN=<token> npm run release  # 构建 + 发布到 GitHub Releases
```

或推送 `v*` 标签，让[发布工作流](.github/workflows/release.yml)自动构建并发布。

> 对于打包/安装后的应用，请将 `credentials.json` 放在 `~/.sitedeck/` 目录下（仅从源码运行时才检查项目根目录）。

## 脚本

| 脚本 | 说明 |
| --- | --- |
| `npm start` | 运行仪表盘服务器 |
| `npm run dev` | 文件变更时自动重启 |
| `npm run electron` | 以桌面（Electron）窗口方式运行 |
| `npm run dist` | 打包桌面安装包 |
| `npm run release` | 构建 + 发布到 GitHub |
| `npm test` | 单元测试（vitest） |
| `npm run typecheck` | 类型检查 |

## 项目结构

```
src/
  config.ts    常量、本地路径、OAuth 范围
  server.ts    HTTP 服务器（/ 仪表盘、/api/summary、OAuth 回调）
  periods.ts   时间段 → 当前/上一时间段日期范围计算
  auth.ts      OAuth loopback + 令牌缓存
  ga.ts        Admin 媒体资源列表 + Data API runReport
  summary.ts   每个站点的摘要 + Δ% 组装
public/        仪表盘前端（HTML/CSS/JS，深色主题）
electron/      桌面包装器（Electron main + 自动更新程序）
```

## 工作原理

- 对于每个媒体资源，当前和上一时间段通过并行 `runReport` 调用获取；媒体资源也并行收集。
- 仅统计完整天数（今天为不完整数据，已排除）。
- `credentials.json` 和令牌（`~/.sitedeck/token.json`）保留在本地计算机上，不会被提交。
- 仅请求只读范围 `analytics.readonly`。

## 贡献

欢迎提交 PR。请确保 `npm run typecheck` 和 `npm test` 通过。纯逻辑代码采用测试驱动开发（TDD）编写。

## 许可证

[MIT](LICENSE) © Si Hyeong Lee
