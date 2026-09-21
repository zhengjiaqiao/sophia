---
type: spec
description: 模型网关从只接一家第三方网关扩展到可以同时接多家；本次只交付 Rust 侧与命令契约，界面另行迁移
created: 2026-09-21
---

# Spec：模型网关支持多家第三方网关

依据：发起人口头需求（2026-09-21）。前一份：`docs/specs/2026-09-20-codex-model-gateway-design.md`，其中 R1–R13 继续有效，本文只写增量。

## 背景

Codex 自己可以在设置里定义多个 provider，但同一时间只认一个，模型选择器也不会把几家的模型并排列出。
本功能绕开了 provider 这个概念：Codex 始终以为只有官方一家，所有模型在同一份目录里，本机路由按模型标识决定发给谁。
所以路由后面接一家还是接十家，Codex 无感。一期的代码按“恰好一家”写死了三处：设置结构、路由清单、钥匙串账户。

## 需求

- **M1 多家并存** 可以添加任意多家第三方网关，每家有自己的显示名、地址、协议、密钥、模型列表和勾选。启用后，官方模型与各家所选模型同时出现在 Codex 的模型选择器里。
- **M2 按归属分流** 每个第三方模型的请求只发给它所属的那一家，只带那一家的密钥。归属不明、上游缺失、上游地址不安全时拒绝，绝不回落到官方或别家（延续 R5）。
- **M3 标识稳定且不相撞** 两家提供同名模型时可以同时勾选。一家的模型标识只取决于它自己，不随别家的增删、改名、换顺序变化。
- **M4 增删改不打断** 增删网关、改地址不需要重装或重启后台路由，不影响其他网关正在进行的对话。
- **M5 删除** 删掉一家时，它的模型、地址和钥匙串里的密钥一并清除；已启用时它的模型进停用名单。已启用且它是最后一家还在发布模型的网关时拒绝。
- **M6 兼容** 旧的单网关设置自动迁移成一家，密钥不用重新输入。旧的三个命令继续可用，作用在第一家上，供界面按自己的节奏迁移。
- **M7 接管** 接管 agents-manager 的配置落成一家网关，不动用户自己加的网关——即使用户那家的 id 恰好相同。同一家网关重复接管不会越攒越多。

不在本次范围：界面（由界面重构的分支负责，按 `docs/DESIGN.md`）；非 macOS；每家单独启用或停用。

## 设计

**设置**：`GatewaySettings` 里平铺的 `baseUrl / apiBase / protocol / models` 收进 `providers: ProviderSettings[]`，每项多出 `id` 与 `name`。
读入时若没有 `providers` 而有旧的平铺字段，迁移成 id 为 `default`、名字取地址主机名的一家；旧字段只读不写。

**id**：新建时由显示名生成（小写字母、数字、点、下划线、连字符；纯中文等生成不出字符的用兜底名 `provider`；重名加 `-2`、`-3`；最长 32），之后不变。改名只改显示名。
id 是模型标识的前缀，也是钥匙串账户名的一部分，变了会让 Codex 里已选的模型全部失效，所以不允许改。

**标识**：一律是 `<网关 id>-<模型名的标识形式>`。考虑过“只在相撞时才加前缀”，否决：那样一家的标识会随别家的勾选变化，不满足 M3，且每次变化都会产生一批停用标识。
代价：旧的单网关设置升级后标识从 `x` 变成 `default-x`。旧标识留在 `publishedSlugs` 里进停用名单；Codex 的默认模型若指向旧标识，在下一次重写目录或再次启用时改回启用前的值。
两家的已选模型显示名相同时，写进目录的名字自动加「 · 网关名」，只影响显示。

**路由清单**：多出 `providers: [{id, base_url, protocol}]`，每条路由多出 `provider`。只写出确有模型在用的网关。
上游地址和协议从后台服务的启动参数挪到清单里：路由本来就每个请求重读清单，于是 M4 自然成立，后台服务的参数从此与网关无关。
路由用到某家上游时再校验它的地址（https，本机回环除外；不得带用户名密码），一家写坏不连累别家。
不带 `provider` 的路由是旧格式清单，走可选的启动参数 `--third-party-url`；这条路只为“新程序 + 旧的后台服务参数”这种中间状态保留。

**密钥**：钥匙串账户按网关区分，`codex-gateway.<id>`。`default` 这一家读不到时回退到旧账户 `codex-gateway`，写入总是写进自己的账户。
路由里的 id 来自磁盘上的清单，取密钥前校验字符集，不合法的一律不碰钥匙串。路由按 id 分别缓存 30 秒，错误不缓存。

**写清单之前先确保路由是当前版本**（`enable` 与已启用时的 `republish` 都如此）：先装好后台路由并确认健康，再写清单，最后处理 Codex 的默认模型。
理由：旧版路由不认清单里的归属，会把所有第三方模型都发给启动参数里的那一家——第二家的请求内容会被发到第一家。路由起不来就什么都不写、不保存。
两步之间有一个不到一秒的窗口：新路由读到旧清单且没有启动参数里的上游，第三方请求得到 502；官方请求不受影响。宁可短暂拒绝，不可发错地方。

**接管落到哪一家**：已有地址相同的网关就覆盖它（重复接管）；否则新起一个 id，首选 `wecode`，被用户自己的网关占用就顺延成 `wecode-2`。
用户把自己的网关命名为 WeCode 时 id 正好是 `wecode`，地址不同就绝不覆盖它的地址、模型和密钥。命令行的 `adopt-key` 用同一条规则。

**保留的 id**：`default` 只给旧设置迁移来的那一家。它会回退读旧钥匙串账户，新建的网关叫这个名字时顺延成 `default-2`，否则会拿到别家的密钥。

**删除的顺序**：先改设置与目录，最后删密钥。中途失败时留下一个没人用的密钥，好过留下一家没密钥的网关。

**命令**：见 `docs/gateway-commands.md`。新增 `gateway_upsert_provider`、`gateway_remove_provider`；`gateway_fetch_models`、`gateway_select_models` 多一个可选的 `providerId`；
`GatewayState` 多出 `providers`，保留 `provider`（等于第一家）。`src/types.ts` 与 `src/api.ts` 只加不改。

## 验收标准

| 编号 | 需求 | Given / When / Then | 真实验证 | 代理验证 |
|---|---|---|---|---|
| MA1 | M1 | 两家各勾一个同名模型并启用 → 合并目录里官方模型在前，两家的模型各有一条，标识分别带各自前缀 | 真机 Codex 选择器里看到两家的模型 | `two_providers_coexist_…` |
| MA2 | M2 | 请求两家的模型 → 每家上游只收到自己的请求和自己的密钥，模型名改写成各自的上游名；官方上游什么都没收到 | 真实二进制 + 真实 wecode + 本机假网关 | `each_provider_gets_only_its_own_requests_and_key` |
| MA3 | M2 | 两家协议不同 → 一家原样转发到 `/responses`，另一家转换后发到 `/chat/completions` | — | `protocol_is_per_provider` |
| MA4 | M2 | 归属指向不存在的网关、明文 http 且非本机、地址带用户名密码、非 http(s) → 502，任何上游都没收到请求 | 真实二进制：不存在的归属返回 502 | `a_route_without_a_usable_provider_fails_closed` |
| MA5 | M2 | 一家没有密钥 → 它的请求 502 且不发出；另一家照常 | — | `one_providers_missing_key_does_not_affect_the_other` |
| MA6 | M2 | 清单里一家的地址写坏 → 它的请求 502；另一家照常 | — | `a_broken_provider_entry_does_not_take_down_the_others` |
| MA7 | M3 | 同一家的标识在“只有它”和“前面多一家”两种设置下相同；改名后 id、标识、密钥账户都不变 | — | `a_providers_slugs_do_not_depend_on_other_providers`、`renaming_a_provider_keeps_its_id_and_slugs` |
| MA8 | M3 | 名称相同、纯中文、超长、含路径或空白字符 → id 唯一、非空、只含允许的字符、不超过 32 | — | `provider_ids_are_safe_unique_and_never_empty`、`provider_ids_stay_unique_…` |
| MA9 | M4 | 路由运行中往清单里加一个模型 → 不重启即可请求；换网关地址后后台服务的启动参数不变 | 真实二进制：改清单后立即请求成功 | `fetched_api_base_is_used_and_selection_survives` |
| MA10 | M5 | 已启用时删一家 → 它的模型进停用名单，只删它的密钥，另一家不变；它的模型若是 Codex 默认模型则改回 | — | `removing_a_provider_retires_…`、`removing_a_provider_resets_the_default_model_…` |
| MA11 | M5 | 已启用时删最后一家还在发布模型的网关 → 拒绝，设置、目录、密钥都不动 | — | `removing_the_last_publishing_provider_while_enabled_is_refused` |
| MA12 | M6 | 旧的平铺设置 → 读成 id 为 `default` 的一家；再存一次不再写出旧字段；已有 `providers` 时残留的旧字段被忽略 | — | `legacy_single_gateway_settings_migrate_…`、`legacy_fields_are_ignored_once_providers_exist` |
| MA13 | M6 | `default` 这一家的密钥在旧账户里 → 读得到，新账户优先；别家绝不回退到旧账户；删它时两个账户都清 | 真实二进制：用旧账户里的真实密钥请求 wecode 成功 | `the_migrated_provider_falls_back_to_the_old_account`、`deleting_the_migrated_provider_…` |
| MA14 | M6 | 旧设置已启用、磁盘上是旧清单 → 下一次改勾选整体换成新格式，旧标识进停用名单，指向旧标识的默认模型改回 | — | `legacy_settings_are_republished_in_the_new_format_on_the_next_change` |
| MA15 | M6 | 旧的三个命令对应的方法行为不变（原有编排层用例全部通过，仅标识与上游位置的期望值按新规则更新） | — | 原有 `app::tests` 全部 |
| MA16 | M6 | 不带 `provider` 的旧清单 → 走启动参数里的上游，密钥按 `default` 取 | — | `routes_without_a_provider_use_the_startup_upstream_and_the_legacy_key` |
| MA17 | M7 | 已有一家自己加的网关时接管 → 多出 id 为 `wecode` 的一家，密钥进它的账户；对方不带前缀的旧标识进停用名单，指向它的默认模型改回 | — | `takeover_adds_a_wecode_provider_next_to_existing_ones` |
| MA20 | M7 | 用户自己的网关 id 恰好是 `wecode` 且地址不同时接管 → 它的地址、模型、密钥原样保留，接管来的落到 `wecode-2`；同一家网关接管两次 → 仍只有一家 | — | `takeover_never_overwrites_a_users_own_provider_…`、`taking_over_the_same_gateway_twice_reuses_the_provider` |
| MA21 | M2 | 启用：路由确认健康的那一刻清单还没写；路由起不来 → `router_down`，清单不写，Codex 设置不动 | — | `enable_brings_the_router_up_before_writing_the_routing_catalog` |
| MA22 | R11 | 新建的网关名叫 default → id 顺延，不落到迁移专用的 id 上；给已有网关换密钥而密钥没存成 → 地址保持原样 | — | `the_migration_id_is_never_handed_to_a_new_provider`、`an_existing_provider_keeps_its_address_…` |
| MA18 | M2 | 已启用时改动发布内容而后台路由起不来 → 返回 `router_down`，清单不变，勾选不保存 | — | `republishing_refuses_to_write_catalogs_when_the_router_cannot_be_brought_up` |
| MA19 | R11 | 路由清单里的网关 id 不在允许的字符集内 → 不读、不写、不删钥匙串；新建网关时密钥没存成 → 这一家不留下 | — | `ids_outside_the_allowed_alphabet_never_reach_the_keychain`、`a_new_provider_is_not_left_behind_…` |

## 风险与已知限制

- 路由清单在 `~/.codex` 下，现在含上游地址。能写这个文件的本机进程可以把某家的请求连同密钥引到别的 https 地址。
  这没有引入新的信任边界：同一用户的进程本来就能改 SymSync 的设置文件、也能直接用 `/usr/bin/security` 读出密钥。路由仍拒绝明文 http、带凭据的地址和不合法的 id。
- 旧标识在 Codex 重启前仍可能被请求，得到的是“请重启 Codex”的 409，而不是自动映射到新标识。升级当下正在用第三方模型的会话需要重启 Codex。
- 界面尚未迁移：在界面分支合入之前，用户只能通过旧界面操作第一家。
- 已启用时重新发布，清单写成之后若写 Codex 设置时发现它被别人改过（`changed`），本次改动不保存，但清单已是新的。
  这是单网关版本里就有的写法。方向上是安全的（被取消的模型不再可路由），重试一次即恢复一致。

## 验证记录（验证时点：2026-09-21 12:50，对应版本：分支 `feat/gateway-multi-provider` 的首个提交）

核心链路已在真实环境验证；界面、真机 Codex 选择器、真实接管尚未验证。

| 状态 | 条数 | 编号 |
|---|---|---|
| 通过（真实环境） | 4 | MA2、MA4、MA9、MA13 |
| 代理通过 | 17 | MA3、MA5–MA8、MA10–MA12、MA14–MA22 中其余各条 |
| 未验证 | 1 | MA1 的真实验证（真机选择器里看到两家的模型）：界面还没有添加第二家的入口 |
| 失败 | 0 | — |

真实验证的做法：用本分支构建的真实二进制以 `gateway run` 方式启动（不带 `--third-party-url`），清单里两家——
`default` 指向真实的 wecode 网关，密钥由程序自己从旧钥匙串账户回退读到；另一家指向本机假网关，用一条演练专用的假密钥。
结果：wecode 的模型返回了正文与 `response.completed`；假网关只收到自己的密钥和改写后的模型名；归属指向不存在的网关返回 502；
路由不重启、往清单里加一个模型后立即可请求；路由日志与所有输出文件里没有密钥。演练用的假密钥条目已删除，用户原有的条目未动。

代理验证：`make test` → 361 个 Rust 测试、clippy `-D warnings` 零警告、前端构建、18 个 `node:test`，全部通过；`cargo build -p symsync` 通过。
本机 clippy 是 0.1.94，CI 是 1.98.0，CI 上的 lint 结果以 CI 为准。

独立评审（只读，子代理）提出 2 条确认的缺陷，均已修复并带回归测试（MA20、MA21）：接管会覆盖用户自己那家 id 相同的网关；`enable` 里写清单与装路由的顺序与 `republish` 相反。
评审另核对并确认无误：标识前缀与相撞拒绝、清单里模型必有上游、路由逐请求校验上游地址、钥匙串 id 字符集与旧账户回退的范围、删除的先后顺序、旧设置迁移、密钥不进参数与错误文本。

有意改动的既有断言（不是回归）：标识期望值加上网关前缀；「上游地址在后台服务启动参数里」改为「在路由清单里」。
