<p align="center">
  <img src="assets/hero.png" alt="seekx — AI 에이전트와 당신을 위한 컨텍스트 검색" width="100%">
  <h1 align="center">seekx</h1>
  <p align="center">
    AI 에이전트와 사람을 위한 컨텍스트 검색 엔진.<br/>
    진실은 당신의 파일에 있고, seekx는 인덱스일 뿐입니다.<br/>
    <b>GPU 불필요. 하이브리드 검색. 실시간 인덱싱.</b>
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
  <a href="README.ja.md">日本語</a> |
  <b>한국어</b>
</p>

---

한 번 인덱싱하면 무엇이든 찾을 수 있습니다. seekx는 로컬 문서에 하이브리드 검색을 제공합니다 — 파일과 명령 하나면 됩니다.

```
seekx add ~/notes
seekx search "how do agents use tool calling"
```

끝입니다. 메모가 인덱싱되면 검색할 수 있습니다.

seekx가 유용하셨다면 [GitHub](https://github.com/oceanbase/seekx)에 ⭐를 남겨 주세요 — 큰 도움이 됩니다!

## 왜 seekx인가?

수백 개의 Markdown, 메모, 문서가 폴더마다 흩어져 있습니다. Spotlight는 파일 이름을, Grep은 정확한 문자열을 찾습니다. 둘 다 당신이 *무엇을 찾고 있는지* 이해하지 못합니다.

seekx는 이해합니다.

| 얻는 것 | 방법 |
|---|---|
| **키워드뿐 아니라 의미로 검색** | 하이브리드 검색은 BM25 키워드 매칭과 벡터 의미 검색을 RRF로 결합 — 정확한 표현을 기억하지 못해도 결과를 얻습니다. |
| **약 2분 만에 실행** | GPU 없음, 모델 다운로드 없음, Docker 없음. OpenAI 호환 API만 지정하면 됩니다. |
| **항상 동기화** | 파일을 수정하면 바로 검색할 수 있습니다. 인덱스는 작업에 맞춰 갱신 — 수동 전체 재빌드가 필요 없습니다. |
| **중국어·일본어·한국어 지원** | Jieba 기반 토큰화 내장. CJK 전문 검색이 바로 동작합니다. |

## 기능

- **Cross-encoder 재순위** — 선택적 rerank API로 정밀도 향상
- **쿼리 확장** — LLM으로 쿼리를 자동 재작성해 재현율 개선
- **HyDE** — Hypothetical Document Embeddings로 의미 검색 강화
- **콘텐츠 인식 청킹** — Markdown은 제목 기준 분할, 일반 텍스트는 단락 기준 분할
- **증분 인덱싱** — SHA-1 콘텐츠 해시로 변경 없는 파일 건너뜀, 변경분만 재임베딩
- **JSON 출력** — 모든 명령이 `--json` 지원(스크립트·파이프용)
- **OpenClaw 메모리 백엔드** — `memory-core`를 그대로 대체하는 플러그인으로, seekx 하이브리드 검색 파이프라인을 OpenClaw에 연결합니다

## 빠른 시작

### 사전 요구 사항

- [Bun](https://bun.sh) ≥ 1.1.0
- OpenAI 호환 임베딩 API(SiliconFlow, Jina, Ollama, OpenAI 등)

### 설치

**npm(권장)** — CLI와 라이브러리는 npm에 게시됩니다: [`seekx`](https://www.npmjs.com/package/seekx)(CLI)는 [`seekx-core`](https://www.npmjs.com/package/seekx-core)에 의존합니다. CLI를 전역 설치하면 npm이 `seekx-core`를 자동으로 가져옵니다.

```bash
npm install -g seekx
# 또는: bun add -g seekx
```

실행 시에도 `PATH`에 [Bun](https://bun.sh)이 있어야 합니다 — 배포된 CLI는 Node가 아니라 Bun으로 실행됩니다.

**소스에서** — 개발 또는 미출시 커밋 실행:

```bash
git clone https://github.com/oceanbase/seekx.git
cd seekx
bun install
bun link --cwd packages/cli   # 전역에서 seekx 사용
```

### 설정

```bash
seekx onboard    # 대화형 — API 구성, 환경 확인
```

`onboard`는 API 키 설정, 임베딩 모델 선택, 벡터 검색용 macOS SQLite 구성을 안내합니다.

### 인덱싱 및 검색

```bash
# 디렉터리를 인덱스에 추가
seekx add ~/notes
seekx add ~/Documents/obsidian --name obsidian

# 하이브리드 검색(BM25 + 벡터 + RRF)
seekx search "vector database embedding"

# 자동 쿼리 확장이 있는 검색
seekx query "how does RRF fusion work"

# 순수 의미(벡터) 검색
seekx vsearch "semantic similarity"
```

### 인덱스 최신 유지

```bash
seekx watch          # 인덱싱된 모든 컬렉션 감시
```

## 검색 동작 방식

```
쿼리
  │
  ├─── [쿼리 확장] ──► 확장된 쿼리
  │                        │
  ▼                        ▼
  원본 쿼리            확장된 쿼리
  │                        │
  ├─► BM25 (가중치 2×)     ├─► BM25 (가중치 1×)
  ├─► 벡터 (가중치 2×)     ├─► 벡터 (가중치 1×)
  │                        │
  │   [HyDE] ──► 벡터 (1×)  │
  │                        │
  └────────── 모든 목록 ────┘
                  │
              RRF 융합
                  │
              [재순위]
                  │
               최종 결과
```

1. **쿼리 확장**(선택): LLM이 쿼리를 여러 변형으로 재작성해 재현율을 높입니다.
2. 원본 쿼리와 모든 확장 변형을 **BM25**와 **벡터** 인덱스에 병렬 실행합니다. 융합 시 원본 결과는 2×, 확장 결과는 1× 가중치입니다.
3. **HyDE**(선택): 가상 답변을 생성해 임베딩하고 추가 벡터 검색 패스로 사용합니다.
4. 모든 결과 목록을 **Reciprocal Rank Fusion**(RRF)으로 병합합니다.
5. **재순위**(선택): Cross-encoder가 융합 후보를 재점수하고 위치 인식 블렌딩을 적용합니다.

## AI 에이전트와 연동

[`seekx-openclaw`](https://www.npmjs.com/package/seekx-openclaw)는 OpenClaw 내장 `memory-core` 백엔드를 그대로 대체하는 플러그인입니다. 설치하면 에이전트의 `memory_search` 및 `memory_get` 호출이 자동으로 seekx의 완전한 하이브리드 검색 파이프라인을 통해 처리됩니다. 에이전트 프롬프트를 변경할 필요가 없습니다.

```bash
openclaw plugins install seekx-openclaw
```

`~/.openclaw/openclaw.json`에서 플러그인을 구성합니다:

```json
{
  "plugins": {
    "slots":   { "memory": "seekx" },
    "entries": { "seekx": { "enabled": true } }
  }
}
```

seekx CLI를 이미 사용 중이라면 플러그인이 `~/.seekx/config.yml`의 API 자격 증명을 자동으로 상속하므로 중복 설정이 불필요합니다. 자세한 내용은 [전체 설정 가이드](packages/openclaw-plugin/README.md)를 참고하세요.

---

## CLI 참고

| 명령 | 설명 |
|---|---|
| `seekx onboard` | 대화형 설정 마법사 |
| `seekx add <path>` | 디렉터리 인덱싱(컬렉션 생성) |
| `seekx collections` | 인덱싱된 모든 컬렉션 나열 |
| `seekx remove <name>` | 컬렉션 제거 |
| `seekx reindex [name]` | 컬렉션 인덱스 재구축 |
| `seekx search <query>` | 하이브리드 검색(BM25 + 벡터 + RRF) |
| `seekx query <query>` | 쿼리 확장이 있는 하이브리드 검색 |
| `seekx vsearch <query>` | 순수 벡터 검색 |
| `seekx get <id>` | ID로 문서 조회 |
| `seekx watch` | 실시간 파일 감시 시작 |
| `seekx status` | 인덱스 통계 및 상태 표시 |
| `seekx config` | 구성 보기/업데이트 |

모든 명령이 `--json`으로 기계 가독 출력을 지원합니다.

## 구성

구성 파일: `~/.seekx/config.yml`

```yaml
# 서비스 간 공유 Provider 기본값
provider:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-...

# 임베딩 — 벡터 검색에 필수
embed:
  model: BAAI/bge-m3

# Cross-encoder 재순위 — 선택
rerank:
  model: BAAI/bge-reranker-v2-m3

# 쿼리 확장 — 선택
expand:
  model: Qwen/Qwen3-8B

# 검색 기본값
search:
  default_limit: 10
  rerank: true
  min_score: 0.3

# 파일 감시
watch:
  debounce_ms: 500
  ignore:
    - node_modules
    - .git
```

Provider가 다르면 각 서비스(`embed`, `rerank`, `expand`)에서 `base_url`, `api_key`, `model`을 개별 덮어쓸 수 있습니다.

### 환경 변수

| 변수 | 설명 |
|---|---|
| `SEEKX_API_KEY` | API 키(구성 덮어씀) |
| `SEEKX_BASE_URL` | Base URL(구성 덮어씀) |
| `SEEKX_DB_PATH` | SQLite DB 경로(기본: `~/.seekx/index.sqlite`) |
| `SEEKX_CONFIG_PATH` | 구성 파일 경로(기본: `~/.seekx/config.yml`) |
| `SEEKX_SQLITE_PATH` | `libsqlite3.dylib` 경로(macOS, 확장 로드용) |

### macOS: 벡터 검색 설정

macOS 시스템 SQLite는 확장 로드를 비활성화합니다. 벡터 검색(`sqlite-vec`)을 위해:

```bash
brew install sqlite
```

seekx는 표준 Homebrew 경로(Apple Silicon 및 Intel)를 자동 감지합니다. 실패 시:

```bash
export SEEKX_SQLITE_PATH="$(brew --prefix sqlite)/lib/libsqlite3.dylib"
```

`seekx onboard`에서 이를 확인하고 안내합니다.

## 개발

```bash
bun test --recursive packages/   # 전체 테스트 실행
bun run typecheck                # tsc -b
bun run lint                     # biome check
bun run format                   # biome format --write
```

## 로드맵

- [x] OpenClaw 메모리 백엔드 플러그인([`seekx-openclaw`](https://www.npmjs.com/package/seekx-openclaw))
- [ ] MCP 서버 — 지식 베이스를 AI 에이전트(Claude Desktop, Cursor 등)에 노출
- [ ] PDF 및 DOCX 지원
- [ ] 멀티 테넌시(사용자/워크스페이스별 격리 인덱스)
- [ ] 검색 및 컬렉션 관리용 Web UI
- [ ] 사용자 정의 파일 파서용 플러그인 시스템

## 패키지

| 패키지 | 버전 | 설명 |
|---|---|---|
| [`seekx`](https://www.npmjs.com/package/seekx) | [![](https://img.shields.io/npm/v/seekx)](https://www.npmjs.com/package/seekx) | CLI — 명령 13개, MCP 서버, 실시간 파일 감시 |
| [`seekx-core`](https://www.npmjs.com/package/seekx-core) | [![](https://img.shields.io/npm/v/seekx-core)](https://www.npmjs.com/package/seekx-core) | 검색 엔진 라이브러리(Node / Bun 지원) |
| [`seekx-openclaw`](https://www.npmjs.com/package/seekx-openclaw) | [![](https://img.shields.io/npm/v/seekx-openclaw)](https://www.npmjs.com/package/seekx-openclaw) | OpenClaw 메모리 백엔드 플러그인 |

## 라이선스

MIT
