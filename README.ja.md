<p align="center">
  <img src="assets/hero.png" alt="seekx — AI エージェントとあなたのためのコンテキスト検索" width="100%">
  <h1 align="center">seekx</h1>
  <p align="center">
    AI エージェントと人間のためのコンテキスト検索エンジン。<br/>
    真実はあなたのファイルにあり、seekx はインデックスにすぎません。<br/>
    <b>GPU 不要。ハイブリッド検索。リアルタイムインデックス。</b>
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/seekx"><img src="https://img.shields.io/npm/v/seekx" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/seekx"><img src="https://img.shields.io/npm/dm/seekx" alt="npm downloads"></a>
    <a href="https://github.com/oceanbase/seekx/stargazers"><img src="https://img.shields.io/github/stars/oceanbase/seekx" alt="GitHub stars"></a>
    <a href="https://github.com/oceanbase/seekx/blob/main/LICENSE"><img src="https://img.shields.io/github/license/oceanbase/seekx" alt="license"></a>
  </p>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <b>日本語</b> |
  <a href="README.ko.md">한국어</a>
</p>

---

一度インデックスすれば、何でも見つかる。seekx はローカル文書にハイブリッド検索をもたらします — ファイルとコマンド一つだけで。

```
seekx add ~/notes
seekx search "how do agents use tool calling"
```

以上です。メモがインデックスされ、検索できるようになります。

seekx が役に立ったと感じたら、[GitHub](https://github.com/oceanbase/seekx) で ⭐ を付けていただけるととても助かります！

## なぜ seekx か？

Markdown、メモ、ドキュメントが何百もあり、フォルダに散らばっている。Spotlight はファイル名を、Grep は完全一致の文字列を見つける。どちらも、あなたが*本当に探しているもの*を理解しない。

seekx は理解します。

| 得られること | 仕組み |
|---|---|
| **キーワードだけでなく意味で探せる** | ハイブリッド検索は BM25 のキーワード一致とベクトルによる意味検索を RRF で融合 — 正確な言い回しを覚えていなくても結果が得られます。 |
| **約 2 分で動かせる** | GPU 不要、モデルダウンロード不要、Docker 不要。OpenAI 互換 API を指定するだけ。 |
| **常に同期** | ファイルを編集すればすぐ検索可能。インデックスは作業に合わせて更新 — 手動のフル再構築は不要。 |
| **中国語・日本語・韓国語に対応** | Jieba ベースのトークナイズを内蔵。CJK の全文検索がそのまま使えます。 |

## 機能

- **クロスエンコーダによる再ランキング** — 任意の rerank API で精度を向上
- **クエリ拡張** — LLM による自動クエリ書き換えでリコール向上
- **HyDE** — Hypothetical Document Embeddings による意味検索の強化
- **コンテキストを意識したチャンク分割** — Markdown は見出し単位、プレーンテキストは段落単位
- **増分インデックス** — SHA-1 コンテンツハッシュで未変更ファイルをスキップ、変更分だけ再埋め込み
- **JSON 出力** — すべてのコマンドが `--json` に対応（スクリプト・パイプ向け）

## クイックスタート

### 前提条件

- [Bun](https://bun.sh) ≥ 1.1.0
- OpenAI 互換の埋め込み API（SiliconFlow、Jina、Ollama、OpenAI など）

### インストール

**npm から（推奨）** — CLI とライブラリは npm に公開されています：[`seekx`](https://www.npmjs.com/package/seekx)（CLI）は [`seekx-core`](https://www.npmjs.com/package/seekx-core) に依存。CLI をグローバルにインストールすれば、`seekx-core` は自動で取得されます。

```bash
npm install -g seekx
# または: bun add -g seekx
```

実行時には引き続き `PATH` に [Bun](https://bun.sh) が必要です — 公開 CLI は Node ではなく Bun で動きます。

**ソースから** — 開発や未リリースのコミットを実行する場合：

```bash
git clone https://github.com/oceanbase/seekx.git
cd seekx
bun install
bun link --cwd packages/cli   # グローバルに seekx を利用可能に
```

### セットアップ

```bash
seekx onboard    # 対話式 — API の設定、環境チェック
```

`onboard` は API キー、埋め込みモデルの選択、ベクトル検索用の macOS SQLite 設定を案内します。

### インデックスと検索

```bash
# ディレクトリをインデックスに追加
seekx add ~/notes
seekx add ~/Documents/obsidian --name obsidian

# ハイブリッド検索（BM25 + ベクトル + RRF）
seekx search "vector database embedding"

# 自動クエリ拡張付き検索
seekx query "how does RRF fusion work"

# 純粋な意味（ベクトル）検索
seekx vsearch "semantic similarity"
```

### インデックスを最新に保つ

```bash
seekx watch          # インデックス済みコレクションをすべて監視
```

## 検索の流れ

```
クエリ
  │
  ├─── [クエリ拡張] ──► 拡張クエリ
  │                         │
  ▼                         ▼
  元のクエリ            拡張クエリ
  │                         │
  ├─► BM25（重み 2×）       ├─► BM25（重み 1×）
  ├─► ベクトル（重み 2×）    ├─► ベクトル（重み 1×）
  │                         │
  │   [HyDE] ──► ベクトル（1×） │
  │                         │
  └────────── すべてのリスト ───┘
                  │
              RRF 融合
                  │
              [再ランキング]
                  │
               最終結果
```

1. **クエリ拡張**（任意）：LLM がクエリを複数のバリアントに書き換え、リコールを改善します。
2. 元のクエリと拡張バリアントすべてを、**BM25** と **ベクトル** インデックスに並列実行。融合では元の結果に 2×、拡張結果に 1× の重みを付けます。
3. **HyDE**（任意）：仮想の回答を生成し埋め込み、追加のベクトル検索パスとして使います。
4. すべての結果リストを **Reciprocal Rank Fusion**（RRF）でマージします。
5. **再ランキング**（任意）：クロスエンコーダが融合後の候補を再スコアし、位置を考慮したブレンディングを行います。

## CLI リファレンス

| コマンド | 説明 |
|---|---|
| `seekx onboard` | 対話式セットアップウィザード |
| `seekx add <path>` | ディレクトリをインデックス（コレクション作成） |
| `seekx collections` | インデックス済みコレクション一覧 |
| `seekx remove <name>` | コレクションを削除 |
| `seekx reindex [name]` | コレクションのインデックスを再構築 |
| `seekx search <query>` | ハイブリッド検索（BM25 + ベクトル + RRF） |
| `seekx query <query>` | クエリ拡張付きハイブリッド検索 |
| `seekx vsearch <query>` | ベクトル検索のみ |
| `seekx get <id>` | ID でドキュメント取得 |
| `seekx watch` | リアルタイムファイルウォッチャー起動 |
| `seekx status` | インデックス統計とヘルス表示 |
| `seekx config` | 設定の表示・更新 |

すべてのコマンドが `--json` で機械可読出力に対応しています。

## 設定

設定ファイル：`~/.seekx/config.yml`

```yaml
# サービス間で共有するプロバイダー既定
provider:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-...

# 埋め込み — ベクトル検索に必須
embed:
  model: BAAI/bge-m3

# クロスエンコーダ再ランキング — 任意
rerank:
  model: BAAI/bge-reranker-v2-m3

# クエリ拡張 — 任意
expand:
  model: Qwen/Qwen3-8B

# 検索の既定値
search:
  default_limit: 10
  rerank: true
  min_score: 0.3

# ファイルウォッチャー
watch:
  debounce_ms: 500
  ignore:
    - node_modules
    - .git
```

プロバイダーが異なる場合、各サービス（`embed`、`rerank`、`expand`）で `base_url`、`api_key`、`model` を個別に上書きできます。

### 環境変数

| 変数 | 説明 |
|---|---|
| `SEEKX_API_KEY` | API キー（設定より優先） |
| `SEEKX_BASE_URL` | Base URL（設定より優先） |
| `SEEKX_DB_PATH` | SQLite DB パス（既定：`~/.seekx/index.sqlite`） |
| `SEEKX_CONFIG_PATH` | 設定ファイルパス（既定：`~/.seekx/config.yml`） |
| `SEEKX_SQLITE_PATH` | `libsqlite3.dylib` のパス（macOS、拡張ロード用） |

### macOS：ベクトル検索のセットアップ

macOS 付属の SQLite は拡張ロードが無効です。ベクトル検索（`sqlite-vec`）には：

```bash
brew install sqlite
```

seekx は標準的な Homebrew パス（Apple Silicon / Intel）を自動検出します。失敗する場合：

```bash
export SEEKX_SQLITE_PATH="$(brew --prefix sqlite)/lib/libsqlite3.dylib"
```

`seekx onboard` がこれを確認し案内します。

## 開発

```bash
bun test --recursive packages/   # 全テスト実行
bun run typecheck                # tsc -b
bun run lint                     # biome check
bun run format                   # biome format --write
```

## ロードマップ

- [ ] MCP サーバー — ナレッジベースを AI エージェント（Claude Desktop、Cursor など）に公開
- [ ] PDF / DOCX 対応
- [ ] マルチテナンシー（ユーザー／ワークスペースごとの分離インデックス）
- [ ] 検索とコレクション管理の Web UI
- [ ] カスタムファイルパーサー用プラグインシステム

## ライセンス

MIT
