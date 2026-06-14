# SiteDeck

[English](README.md) · [한국어](README.ko.md) · [Español](README.es.md) · [中文](README.zh.md) · **日本語**

[![CI](https://github.com/writingdeveloper/SiteDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/writingdeveloper/SiteDeck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**すべての Google Analytics 4 (GA4) プロパティの主要指標を 1 画面にまとめて表示**するローカルダッシュボード — プロパティごとに開く手間はもう不要。

- **指標** — アクティブユーザー、セッション、主要イベント（前期比 Δ% ▲▼）、トップページ、トップチャネル、日次トレンドのスパークライン
- **期間** — 7 / 28 / 90 日の切り替え、列ソート対応
- **認証** — OAuth 2.0 loopback：Google アカウントで 1 回サインインするだけで、アクセス可能なすべての GA4 プロパティが自動的に収集される
- **コスト** — 無料（GA API の無料枠内）

## 動作要件

- Node.js ≥ 20（v22 で開発）

## インストール

```bash
npm install
```

## Google Cloud の設定（初回のみ、約 5 分）

1. [Google Cloud Console](https://console.cloud.google.com) で新しいプロジェクトを作成する。
2. **Google Analytics Admin API** と **Google Analytics Data API** を有効化する。
3. OAuth 同意画面を設定する：**External** を選択し、自分を**テストユーザー**として追加する。
4. 認証情報を作成 → **OAuth client ID** → **Desktop app** → JSON をダウンロードする。
5. プロジェクトルートに `credentials.json` として保存する（git 管理外）。フォーマットは [`credentials.json.example`](credentials.json.example) を参照。

## 実行

```bash
npm start        # http://localhost:4317
```

初回起動時に Google でサインインすると、リフレッシュトークンは `~/.sitedeck/token.json` のみに保存される。

## パフォーマンス（PageSpeed）

**パフォーマンス**タブでは、PageSpeed Insights API を通じて各サイトの Lighthouse スコア（パフォーマンス、アクセシビリティ、
ベストプラクティス、SEO）を追跡する — アプリ実行中に 1 日 1 回自動測定されるほか、手動の**측정**（今すぐ測定）ボタンも用意されている。スコアは
`~/.sitedeck/insights.json` にローカル保存され、URL は各 GA4 プロパティのウェブデータストリームから自動的に取得される。

有効にするには、PageSpeed Insights API キーを追加する：

1. 同じ GCP プロジェクトで **PageSpeed Insights API** を有効化する。
2. **API key** を作成する（API とサービス → 認証情報 → 認証情報を作成 → API キー）。
3. `~/.sitedeck/config.json` に保存する：
   ```json
   { "psiApiKey": "YOUR_API_KEY" }
   ```
   （または環境変数 `SITEDECK_PSI_KEY` を設定する）。

## デスクトップアプリ（Electron）

ブラウザではなくネイティブのデスクトップウィンドウとして実行する：

```bash
npm run electron
```

Google サインインはデフォルトブラウザで開かれる（Google は埋め込み webview 内の OAuth をブロックする）；認証後にアプリを更新する。

### インストーラーのビルド

```bash
npm run dist          # release/ にインストーラーをビルド
```

デスクトップビルドは GitHub Releases から**自動更新**される（`electron-updater` 経由）。インストール済みアプリが更新するリリースを公開するには：

```bash
npm version patch                 # バージョンをバンプ + タグを作成
GH_TOKEN=<token> npm run release  # ビルド + GitHub Releases に公開
```

または `v*` タグをプッシュして、[リリースワークフロー](.github/workflows/release.yml)にビルドと公開を任せる。

> パッケージ化/インストール済みのアプリでは、`credentials.json` を `~/.sitedeck/` に配置する（ソースから実行する場合のみプロジェクトルートが確認される）。

## スクリプト

| スクリプト | 説明 |
| --- | --- |
| `npm start` | ダッシュボードサーバーを起動 |
| `npm run dev` | ファイル変更時に再起動 |
| `npm run electron` | デスクトップ（Electron）ウィンドウとして起動 |
| `npm run dist` | デスクトップインストーラーをパッケージ化 |
| `npm run release` | ビルド + GitHub へリリース公開 |
| `npm test` | ユニットテスト（vitest） |
| `npm run typecheck` | 型チェック |

## プロジェクト構成

```
src/
  config.ts    定数、ローカルパス、OAuth スコープ
  server.ts    HTTP サーバー（/ ダッシュボード、/api/summary、OAuth コールバック）
  periods.ts   期間 → 現在/前期の日付範囲の計算
  auth.ts      OAuth loopback + トークンキャッシュ
  ga.ts        Admin プロパティ一覧 + Data API runReport
  summary.ts   サイトごとのサマリー + Δ% の組み立て
public/        ダッシュボードフロントエンド（HTML/CSS/JS、ダークテーマ）
electron/      デスクトップラッパー（Electron main + 自動アップデーター）
```

## 動作の仕組み

- 各プロパティについて、現在期間と前期間を並行した `runReport` 呼び出しで取得する；プロパティも並行して収集される。
- 完全な日付のみカウントされる（本日は不完全なためカウント外）。
- `credentials.json` とトークン（`~/.sitedeck/token.json`）はローカルマシンに留まり、コミットされることはない。
- 読み取り専用スコープ `analytics.readonly` のみリクエストする。

## コントリビュート

PR 歓迎。`npm run typecheck` と `npm test` が通過することを確認してください。純粋なロジックはテストファースト（TDD）で記述する。

## ライセンス

[MIT](LICENSE) © Si Hyeong Lee
