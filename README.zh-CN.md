<p align="center">
  <img src="assets/hero.png" alt="seekx — 为 AI 智能体与你检索上下文" width="100%">
  <h1 align="center">seekx</h1>
  <p align="center">
    面向 AI 智能体与人类的上下文搜索引擎。<br/>
    你的文件即真相，seekx 只是索引。<br/>
    <b>无需 GPU。混合检索。实时索引。</b>
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
  <b>简体中文</b> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a>
</p>

---

索引一次，随处可搜。seekx 为本地文档带来混合检索——只需你的文件和一条命令。

```
seekx add ~/notes
seekx search "how do agents use tool calling"
```

就是这样。笔记被索引后，即可搜索。

如果你觉得 seekx 有用，欢迎在 [GitHub](https://github.com/oceanbase/seekx) 上给我们一颗 ⭐——这很有帮助！

## 为什么选择 seekx？

你有成百上千的 Markdown、笔记、文档——散落在各个文件夹里。Spotlight 找文件名，Grep 找精确字符串。它们都不理解你*真正想找什么*。

seekx 可以。

| 你能得到 | 方式 |
|---|---|
| **按语义查找，而不只是关键词** | 混合检索融合 BM25 关键词匹配与向量语义检索，并通过 RRF 合并——无论你是否记得原文措辞，都能得到结果。 |
| **约两分钟上手** | 无需 GPU、无需下载模型、无需 Docker。指向任意 OpenAI 兼容 API 即可开始。 |
| **始终同步** | 编辑文件后立即可搜。索引随工作实时更新——无需手动全量重建。 |
| **中文、日文、韩文开箱即用** | 内置基于 Jieba 的分词。CJK 全文检索可直接使用。 |

## 功能特性

- **Cross-encoder 重排序** — 可选的重排序 API，提升结果精度
- **查询扩展** — 通过 LLM 自动改写查询，提升召回
- **HyDE** — 假设文档嵌入（Hypothetical Document Embeddings），增强语义检索
- **内容感知分块** — Markdown 按标题切分；纯文本按段落切分
- **增量索引** — SHA-1 内容哈希跳过未变文件；仅对变更部分重新嵌入
- **JSON 输出** — 每条命令均支持 `--json`，便于脚本与管道

## 快速开始

### 前置要求

- [Bun](https://bun.sh) ≥ 1.1.0
- 任意 OpenAI 兼容的嵌入 API（SiliconFlow、Jina、Ollama、OpenAI 等）

### 安装

**通过 npm（推荐）** — CLI 与库发布在 npm：[`seekx`](https://www.npmjs.com/package/seekx)（CLI）依赖 [`seekx-core`](https://www.npmjs.com/package/seekx-core)。全局安装 CLI 即可；npm 会自动拉取 `seekx-core`。

```bash
npm install -g seekx
# 或: bun add -g seekx
```

运行时仍须在 `PATH` 中提供 [Bun](https://bun.sh) — 已发布的 CLI 通过 Bun 运行，而非 Node。

**从源码** — 用于开发或运行未发布提交：

```bash
git clone https://github.com/oceanbase/seekx.git
cd seekx
bun install
bun link --cwd packages/cli   # 全局可用 seekx 命令
```

### 配置

```bash
seekx onboard    # 交互式 — 配置 API、检查环境
```

`onboard` 会引导你完成 API 密钥、嵌入模型选择，以及 macOS 上用于向量检索的 SQLite 配置。

### 索引与搜索

```bash
# 将目录加入索引
seekx add ~/notes
seekx add ~/Documents/obsidian --name obsidian

# 混合检索（BM25 + 向量 + RRF）
seekx search "vector database embedding"

# 带自动查询扩展的搜索
seekx query "how does RRF fusion work"

# 纯语义检索
seekx vsearch "semantic similarity"
```

### 保持索引最新

```bash
seekx watch          # 监听所有已索引的 collection
```

## 检索如何工作

```
查询
  │
  ├─── [查询扩展] ──► 扩展后的查询
  │                        │
  ▼                        ▼
  原始查询            扩展后的查询
  │                        │
  ├─► BM25（权重 2×）        ├─► BM25（权重 1×）
  ├─► 向量（权重 2×）        ├─► 向量（权重 1×）
  │                        │
  │   [HyDE] ──► 向量（1×）   │
  │                        │
  └────────── 所有列表 ───────┘
                  │
              RRF 融合
                  │
              [重排序]
                  │
               最终结果
```

1. **查询扩展**（可选）：由 LLM 将查询改写为多个变体以提升召回。
2. 原始查询与所有扩展变体并行在 **BM25** 与 **向量** 索引上检索。融合时原始结果权重为 2×，扩展结果权重为 1×。
3. **HyDE**（可选）：生成假设答案并嵌入，作为额外的向量检索通道。
4. 所有结果列表通过 **倒数排名融合**（Reciprocal Rank Fusion，RRF）合并。
5. **重排序**（可选）：Cross-encoder 对融合后的候选重新打分，并与位置感知混合。

## CLI 参考

| 命令 | 说明 |
|---|---|
| `seekx onboard` | 交互式设置向导 |
| `seekx add <path>` | 索引目录（创建 collection） |
| `seekx collections` | 列出所有已索引 collection |
| `seekx remove <name>` | 移除 collection |
| `seekx reindex [name]` | 重建某 collection 的索引 |
| `seekx search <query>` | 混合检索（BM25 + 向量 + RRF） |
| `seekx query <query>` | 带查询扩展的混合检索 |
| `seekx vsearch <query>` | 纯向量检索 |
| `seekx get <id>` | 按 ID 获取文档 |
| `seekx watch` | 启动实时文件监听 |
| `seekx status` | 显示索引统计与健康状态 |
| `seekx config` | 查看或更新配置 |

所有命令均支持 `--json` 以输出机器可读格式。

## 配置

配置文件：`~/.seekx/config.yml`

```yaml
# 各服务共享的 Provider 默认值
provider:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-...

# 嵌入 — 向量检索必需
embed:
  model: BAAI/bge-m3

# Cross-encoder 重排序 — 可选
rerank:
  model: BAAI/bge-reranker-v2-m3

# 查询扩展 — 可选
expand:
  model: Qwen/Qwen3-8B

# 搜索默认项
search:
  default_limit: 10
  rerank: true
  min_score: 0.3

# 文件监听
watch:
  debounce_ms: 500
  ignore:
    - node_modules
    - .git
```

若各服务使用不同 Provider，每个服务（`embed`、`rerank`、`expand`）可单独覆盖 `base_url`、`api_key` 与 `model`。

### 环境变量

| 变量 | 说明 |
|---|---|
| `SEEKX_API_KEY` | API 密钥（覆盖配置文件） |
| `SEEKX_BASE_URL` | Base URL（覆盖配置文件） |
| `SEEKX_DB_PATH` | SQLite 数据库路径（默认：`~/.seekx/index.sqlite`） |
| `SEEKX_CONFIG_PATH` | 配置文件路径（默认：`~/.seekx/config.yml`） |
| `SEEKX_SQLITE_PATH` | `libsqlite3.dylib` 路径（macOS，用于加载扩展） |

### macOS：向量检索设置

macOS 系统自带的 SQLite 禁用了扩展加载。要进行向量检索（`sqlite-vec`）：

```bash
brew install sqlite
```

seekx 会自动检测常见 Homebrew 路径（Apple Silicon 与 Intel）。若自动检测失败：

```bash
export SEEKX_SQLITE_PATH="$(brew --prefix sqlite)/lib/libsqlite3.dylib"
```

`seekx onboard` 会检查此项并给出指引。

## 开发

```bash
bun test --recursive packages/   # 运行全部测试
bun run typecheck                # tsc -b
bun run lint                     # biome check
bun run format                   # biome format --write
```

## 路线图

- [ ] MCP 服务器 — 将知识库暴露给 AI 智能体（Claude Desktop、Cursor 等）
- [ ] PDF 与 DOCX 支持
- [ ] 多租户（按用户/工作区隔离索引）
- [ ] 用于搜索与 collection 管理的 Web UI
- [ ] 自定义文件解析器的插件系统

## 许可

MIT
