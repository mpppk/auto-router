# auto-router

Capability-aware な OpenRouter 互換ルーター。設計は [#1](https://github.com/mpppk/auto-router/issues/1) を参照。

- Runtime: Cloudflare Workers
- HTTP framework: Hono
- Package manager / test runner: Bun
- Lint / format: Biome

## Development

```sh
bun install
bun run dev        # wrangler dev (http://localhost:8787)
```

| Script | 内容 |
| --- | --- |
| `bun run lint` / `lint:fix` | Biome による lint + format チェック / 自動修正 |
| `bun run typecheck` | `tsc` による型チェック (`src` と `test`) |
| `bun run test` | `bun test` |
| `bun run build` | `wrangler deploy --dry-run` でバンドルを検証 |
| `bun run cf-typegen` | `wrangler.jsonc` から `worker-configuration.d.ts` を再生成 |
| `bun run check:types` | `worker-configuration.d.ts` が最新か確認 |

`wrangler.jsonc` の bindings を変更したら `bun run cf-typegen` を実行し、生成された `worker-configuration.d.ts` もコミットしてください。

### Secrets

ローカルで使う secret は 1Password に置き、`.env.template` から `.env` を生成します。

```sh
op inject -i .env.template -o .env
```

| 変数 | 用途 |
| --- | --- |
| `OPENROUTER_API_KEY` | 動作確認・e2e・eval 用。auto-router は BYOK なので Worker 自体は OpenRouter キーを持たない |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | Wrangler CLI (deploy, D1 migration など) |

Worker の secret:

| 変数 | 用途 |
| --- | --- |
| `TRACE_FINGERPRINT_SECRET` | routing trace の所有者判定に使う API key HMAC の secret (`wrangler secret put TRACE_FINGERPRINT_SECRET`)。未設定時は SHA-256 fingerprint |

`.env` は Bun と Wrangler が自動で読み込みます。`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` により、これらの値は Worker の binding には渡りません。

Jev (semantic detector) は OpenRouter の `~typesafe/jev-latest` を呼び出し側の OpenRouter キーで利用するため、専用の API キーは不要です。

## API

OpenAI / OpenRouter 互換の base URL として `https://<host>/api/v1` を指定し、API key には caller 自身の OpenRouter API key を使います (BYOK)。

| Endpoint | 内容 |
| --- | --- |
| `POST /api/v1/chat/completions` (`/v1/chat/completions`) | capability-aware routing 付き Chat Completions proxy |
| `POST /api/v1/auto-router/inspect` | 同じ request の routing decision を返す。upstream model は呼ばない |
| `GET /api/v1/auto-router/traces/:traceId` | 実行済み routing trace を返す (同じ API key からのみ取得可) |
| `GET /api/v1/models` (`/v1/models`) | OpenRouter `GET /models` をそのまま透過 (query string / Authorization も透過)。OpenAI 互換 client の接続確認・model 選択 UI 用 |

上記以外の endpoint (`/responses`、`/completions`、`/embeddings` 等の generation endpoint を含む) は黙って proxy せず `unsupported_endpoint` (404) を返します。

### Request headers

| Header | Default | 内容 |
| --- | --- | --- |
| `Auto-Router-Allow-Model-Override` | `true` | caller の model chain で Hard Requirement を満たせない場合に capability default route へ置換してよいか。`false` なら `capability_not_supported` |
| `Auto-Router-Debug` | `false` | `true` で詳細 trace (candidate ごとの conflict 詳細、tool_choice、provider 等) を保存 |
| `Auto-Router-Semantic` | `on` | `off` で semantic routing を無効化。Jev を呼ばず semantic requirement なしとして扱う (structural requirement と Hard Requirement 保持はそのまま) |
| `Auto-Router-Capabilities` | (全 capability) | semantic routing で判定する capability を `,` 区切りで限定 (例: `web.search,social.x.search`)。指定外の capability は Jev に問い合わせず、required にならない |
| `Auto-Router-Allow-Capability-Degrade` | (なし) | required と判定された capability を別の capability に置き換えてよい組み合わせを `from=to` の `,` 区切りで許可 (例: `places.search=web.search,geo.proximity=web.search`)。下記「Places / Maps」参照 |

`Auto-Router-*` header は upstream には転送しません。値は前後の空白を無視し、真偽値は `true` / `false`、on / off は `on` / `off`、一覧は `,` 区切りで指定します。不正な値 (未知の capability、空要素等) は `invalid_router_request` (400) になります。

### 課金への影響

auto-router は BYOK のため、以下の料金は caller 自身の OpenRouter API key に課金されます。

| 操作 | いつ発生するか | 料金の目安 | 抑止する方法 |
| --- | --- | --- | --- |
| Jev (`~typesafe/jev-latest`) による semantic 判定 | user message を含む request (routing 前)。同一 context は 5 分間 cache | 約 $0.00002 / request | `Auto-Router-Semantic: off` |
| `openrouter:web_search` tool の注入 | `web.search` が required と判定されたとき | OpenRouter の web search 料金 (engine / 結果件数に依存) | `Auto-Router-Capabilities` から `web.search` を外す / `Auto-Router-Semantic: off` |
| Grok + X Search (`x_search`) への切り替え | `social.x.search` が required と判定されたとき | Grok の token 料金 + X Search の従量課金 ($5 / 1,000 posts、2026-09-21〜) | `Auto-Router-Capabilities` から `social.x.search` を外す / `Auto-Router-Allow-Model-Override: false` / `Auto-Router-Semantic: off` |

routing trace (`GET /api/v1/auto-router/traces/:traceId` / inspect) の `billing` に、その request で Jev を呼んだか (`jev`) と router が有効化した課金対象の server tool (`serverTools`: `web_search` / `x_search`) を記録します。caller が元から指定していた server tool は含めません。

### Response headers

response body / SSE は変更せず、routing summary を header で返します。

| Header | 内容 |
| --- | --- |
| `Auto-Router-Trace-Id` | `rt_...`。`GET /api/v1/auto-router/traces/:traceId` で参照 |
| `Auto-Router-Requested-Model` | caller の model chain (`model` + `models`、`,` 区切り) |
| `Auto-Router-Selected-Model` | upstream に送った effective model chain (`,` 区切り、先頭が primary) |
| `Auto-Router-Route-Reason` | `requested_model` / `filtered_fallback_chain` / `capability_override` / `capability_not_supported` / `degraded` |
| `Auto-Router-Degraded` | Jev 障害で semantic 判定ができなかった場合 `true` |
| `Auto-Router-Degraded-Capabilities` | `Auto-Router-Allow-Capability-Degrade` により capability を置き換えた場合のみ。`from=to` の `,` 区切り |

### Errors

`{ "error": { "message", "type", "code", "metadata"? } }`

| code | status |
| --- | --- |
| `invalid_router_request` | 400 |
| `missing_authorization` / `invalid_api_key` | 401 |
| `unsupported_endpoint` / `trace_not_found` | 404 |
| `capability_not_supported` / `capability_conflict` | 422 |
| `rate_limited` | 429 (`Retry-After` 付き) |

### Rate limit / 不正な API key

auto-router 側の負担 (Worker の CPU / request、Jev 呼び出し、D1 書き込み) を抑えるため、`/api/v1/*` `/v1/*` に Workers Rate Limiting binding による制限をかけています (`wrangler.jsonc` の `ratelimits`)。

| Binding | 単位 | 上限 |
| --- | --- | --- |
| `RATE_LIMIT_IP` | client IP (`CF-Connecting-IP`) | 300 requests / 60s |
| `RATE_LIMIT_KEY` | API key の fingerprint (raw key は使わない) | 120 requests / 60s |

超過時は Jev / upstream を呼ばず、trace も保存せずに `429 rate_limited` を返します。Workers Rate Limiting は location ごとの近似的な制限です。

- Jev が 401 (API key 拒否) を返した場合は degraded として続行せず、upstream も呼ばずに `401 invalid_api_key` を返します (trace は保存しない)。403 等の他のエラーは key の model 制限等でも起こるため、従来どおり degraded として扱います
- upstream が 401 を返した場合は response をそのまま返しますが、trace は保存しません (`Auto-Router-Trace-Id` も付与しない)

### Places / Maps

Places / Maps 系 (`places.search` / `places.opening_hours` / `places.reviews` / `geo.proximity` / `source.google_maps`) は実行 route を持たないため、required と判定されると `capability_not_supported` (422) になります。Web Search へ黙って degrade することはしません。

「渋谷駅周辺でおすすめのラーメン屋を探して」のように通常の Web Search でも実用的に答えられる request のために、caller が `Auto-Router-Allow-Capability-Degrade` で明示的に許可した場合だけ degrade します。

- 許可できる組み合わせ: `places.search` / `places.opening_hours` / `places.reviews` / `geo.proximity` → `web.search`
- `source.google_maps` は source 指定 (Google Maps のデータが必要) が明確なため degrade 対象外。required なら許可に関わらず 422
- required な capability が1つでも degrade 未許可なら 422 (一部だけ許可しても通らない)
- degrade した場合は `Auto-Router-Degraded-Capabilities` response header と trace の `capabilityDegrades` に記録する。trace の `semanticRequirements` には置き換え前の Jev の判定を残す
- 置き換え後の `web.search` は通常の Hard Requirement として扱う (tool 注入、tools 非対応 model なら default route へ override)

threshold は変更していません。現在の eval dataset では Places 系は 0.5〜0.9 のどの threshold でも precision / recall 1.00 で、上記のラーメン屋の例は実際に `places.search` が必要な request (true positive) のため、threshold を上げても正しく解決できないためです。

### Capability default route

caller の model chain が全滅し override が許可されている場合、`web.search` / `social.x.search` は default route (Grok 4+ の fallback chain) に置換します。既定値は `x-ai/grok-4.7,x-ai/grok-4.6` で、Worker var `DEFAULT_ROUTE_MODELS` (`wrangler.jsonc` の `vars`) で TypeScript のコード変更なしに変更できます。

- `,` 区切りで先頭が primary、以降は OpenRouter の model fallback (`models`)
- 全候補を caller chain と同じく Hard Requirement で検証し、満たさない model (Grok 3 以前、image 非対応等) は chain から除外する。全候補が不可なら `capability_not_supported`
- 空・空要素・空白を含む不正な値は warning を出して既定値を使う

### Agent loop (tool calling の途中での model override)

semantic 判定は「最新の user message に答えるために何が必要か」で行い、Jev に渡す context は最新の user message までに限定します (それ以降の agent loop の経過 = assistant message / tool result は含めない)。そのため同じ user message に対する agent loop の各ターンで判定が変わらず、loop の途中で model が行き来しません。次の user message が来た時点で改めて判定し、X Search が不要になれば caller の model に戻ります。

model が切り替わっても caller の会話履歴 (assistant の `reasoning_details`、provider 固有の tool call id 等) は改変せずに転送します。OpenRouter 上で以下の組み合わせが upstream エラーにならないことを確認しています (2026-09、#21)。

| 元の model (履歴に含まれる field) | 切り替え先 |
| --- | --- |
| `anthropic/claude-sonnet-5` (thinking の `reasoning.text` + signature、`toolu_...` id) | `x-ai/grok-4.7` + X Search |
| `openai/gpt-5.4-mini` (`reasoning.encrypted` `openai-responses-v1`、`call_...` id) | `x-ai/grok-4.7` + X Search / `anthropic/claude-sonnet-5` (thinking) |
| `x-ai/grok-4.7` (`reasoning.encrypted` `xai-responses-v1`、`call-...` id) | `anthropic/claude-sonnet-5` (thinking) |

trace の `context.agentLoopTurns` は最新の user message 以降の assistant tool call 数です (0 なら新しい user turn)。

### Jev 判定の cache

agent loop の各ターンは Jev への入力が同一になるため、判定結果 (probability) を Workers Cache API に 5 分間 cache し、同一 context の連続 request では Jev を1回だけ呼びます (Jev の latency 約 300〜500ms と caller への課金を削減)。

- cache key は SHA-256(API key fingerprint, Jev model, Jev に渡す state (直近の会話・instructions), question 定義)。caller ごとに分離し、question 文面・model・会話が変われば別 key になる
- 保存するのは probability だけで、message 本文・raw API key は保存しない
- threshold は取得後に適用するため、threshold を変えても cache 済みの probability で正しく再判定される
- Jev 障害 (degraded) の結果は cache しない。cache の読み書き失敗時は通常どおり Jev を呼ぶ
- `Auto-Router-Semantic: off` の場合は cache も参照しない
- trace の `semanticCache` (`hit` / `miss`) と `latencyMs.jev` で確認できる。hit の場合 `billing.jev` は `false`
- Cache API は data center 単位のため、別の data center に届いた request は miss になる

### Model catalog

structural requirement の判定には OpenRouter `GET /models` の `input_modalities` / `supported_parameters` / `context_length` を使います。`/models` の response は約 750KB あり request path で parse すると CPU 時間を消費するため、cron trigger (`7 * * * *`、毎時) で必要な field だけに縮約した catalog (約 35KB) を KV (`CATALOG_KV`) に保存し、各 isolate はそれを読みます (isolate 内 cache 5 分)。

- KV が空 (初回 deploy 直後等) の場合だけ request 中に OpenRouter から取得して KV を埋める
- cron の取得に失敗した場合は KV の既存の値を使い続ける。KV の読み込みにも失敗した場合は古い isolate cache → 空 catalog (全 model 不明) に fallback し、request は失敗させない
- ローカル (`wrangler dev --test-scheduled`) では `curl "localhost:8787/__scheduled?cron=7+*+*+*+*"` で更新できる

### Routing trace

- Cloudflare D1 (`TRACES_DB`, `migrations/`) に 7 日間保存し、cron trigger で期限切れを削除
- raw Authorization / message 本文は保存しない。trace の所有者は API key の HMAC fingerprint (`TRACE_FINGERPRINT_SECRET`) で判定
- migration は CI の deploy 前に `wrangler d1 migrations apply TRACES_DB --remote` で適用 (ローカルは `--local`)

## Eval

capability detector / routing の品質を gold dataset で評価します (#8)。

```sh
bun run eval:semantic            # Jev semantic detector を実際に呼んで評価 (要 OPENROUTER_API_KEY)
bun run eval:semantic --cached   # cache 済みの probability だけで再評価 (API 呼び出しなし)
bun run eval:semantic --threshold social.x.search=0.7,0.2   # capability ごとの threshold を変更
bun run eval:semantic --sweep    # required threshold を変えて比較
```

- dataset: `eval/semantic-dataset.ts` (binary gold)
- 指標: capability ごとの precision / recall / FPR / FNR / uncertain rate
- Jev の結果は `eval/.cache/` に保存され、state や質問文が変わった case だけ再取得します

end-to-end routing eval (structural 維持、model/models filtering、tool merge / tool_choice、degraded):

```sh
bun run eval:routing                                   # 固定 probability で評価 (API 呼び出しなし、CI でも実行)
bun run eval:routing --threshold social.x.search=0.95  # threshold を変えて比較
bun run eval:routing --live                            # semantic 判定に実 Jev を使う (要 OPENROUTER_API_KEY)
```

- dataset: `eval/routing-dataset.ts`
- forwarded request を resolver とは独立に registry / model catalog で検査し、Hard Requirement violation・incompatible fallback leakage・unnecessary model override rate・caller tool preservation failures を集計 (violation / leakage / tool 保持失敗が1件でもあれば exit 1)

threshold は暫定の `required: p >= 0.8` / `not_required: p <= 0.2` を維持しています。現在の dataset では X Search の required threshold 0.5〜0.8 で precision / recall とも 1.00、0.9 では recall が 0.63 に低下するため、false negative を避ける観点から 0.8 を上限としています。

## CI/CD

`.github/workflows/ci.yml`

- PR / `main` への push: lint, 型チェック, テスト, バンドル検証
- `main` への push: 上記成功後に Cloudflare Workers へデプロイ (GitHub Environment `production`) し、本番 endpoint に smoke test (`bun run smoke`) を実行。失敗すれば CI は failure
  - `GET /health`、`GET /api/v1/models`、inspect (Jev・KV の model catalog)、安価な model (`openai/gpt-5-nano`, `max_tokens: 16`) での chat completion と D1 trace の書き込み・読み出し、unsupported endpoint
  - ローカルからは `SMOKE_BASE_URL=https://auto-router.<subdomain>.workers.dev bun run smoke` (要 `OPENROUTER_API_KEY`)

デプロイには以下の GitHub Secrets が必要です。

- `CLOUDFLARE_API_TOKEN` — "Edit Cloudflare Workers" テンプレートで作成した API Token (D1 migration のため D1 Edit 権限も必要)
- `CLOUDFLARE_ACCOUNT_ID`
- `OPENROUTER_API_KEY` — smoke test / 定期 eval 用の OpenRouter key (1回あたり数円未満の課金。利用上限を設定した専用 key を推奨)

GitHub Variables:

- `SMOKE_BASE_URL` — smoke test の対象 URL (deploy step が URL を出力しない場合の fallback)
