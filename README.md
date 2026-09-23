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

### Request headers

| Header | Default | 内容 |
| --- | --- | --- |
| `Auto-Router-Allow-Model-Override` | `true` | caller の model chain で Hard Requirement を満たせない場合に capability default route へ置換してよいか。`false` なら `capability_not_supported` |
| `Auto-Router-Debug` | `false` | `true` で詳細 trace (candidate ごとの conflict 詳細、tool_choice、provider 等) を保存 |
| `Auto-Router-Semantic` | `on` | `off` で semantic routing を無効化。Jev を呼ばず semantic requirement なしとして扱う (structural requirement と Hard Requirement 保持はそのまま) |
| `Auto-Router-Capabilities` | (全 capability) | semantic routing で判定する capability を `,` 区切りで限定 (例: `web.search,social.x.search`)。指定外の capability は Jev に問い合わせず、required にならない |

`Auto-Router-*` header は upstream には転送しません。値は前後の空白を無視し、真偽値は `true` / `false`、on / off は `on` / `off`、一覧は `,` 区切りで指定します。不正な値 (未知の capability、空要素等) は `invalid_router_request` (400) になります。

### 課金への影響

auto-router は BYOK のため、以下の料金は caller 自身の OpenRouter API key に課金されます。

| 操作 | いつ発生するか | 料金の目安 | 抑止する方法 |
| --- | --- | --- | --- |
| Jev (`~typesafe/jev-latest`) による semantic 判定 | user message を含む全 request (routing 前) | 約 $0.00002 / request | `Auto-Router-Semantic: off` |
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
- `main` への push: 上記成功後に Cloudflare Workers へデプロイ (GitHub Environment `production`)

デプロイには以下の GitHub Secrets が必要です。

- `CLOUDFLARE_API_TOKEN` — "Edit Cloudflare Workers" テンプレートで作成した API Token (D1 migration のため D1 Edit 権限も必要)
- `CLOUDFLARE_ACCOUNT_ID`
