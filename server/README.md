# Sophia 接收服务（Worker `api`，数据库 `sophia-telemetry` 与 `sophia-feedback`）

Sophia 公开版的自动上报和应用内反馈发到这里。一个 Cloudflare Worker + 两个 D1 数据库（上报一个、反馈与截图一个，见文末「第三段：反馈」），停在免费档、不绑付款卡。需求见 `docs/specs/2026-10-04-reporting-feedback.md`（R1–R4、R12、R14）。

## 收什么

| 接口 | 内容 | 上限 |
|---|---|---|
| `POST /v1/daily` | 每日上报（JSON）：安装 ID（小写 UUID v4）、日期、版本、系统、架构、两层异常次数 | 整条 ≤ 4 KB；版本、系统 ≤ 32 字节，架构 ≤ 16 字节，只收可打印 ASCII；日期在 31 天内（客户端本地日期可比 UTC 早一天）；同一台电脑同一天只有一行，后来的覆盖前面的；见下文「写不满库」的两道全局上限，不收的回 202 + `{"stored": false}` |
| `POST /v1/event` | Sophia 自身错误 / 崩溃（JSON）：安装 ID、版本、系统、签名、去隐私后的原文 | 整条 ≤ 64 KB、原文 ≤ 32 KB；签名 ≤ 128 字节、版本与系统 ≤ 32 字节，只收可打印 ASCII；同一台电脑同一签名每天一条、每天至多 20 条；全库事件有字节预算。不收的回 202 + `{"stored": false}` |
| `POST /v1/shot` | 反馈截图：请求体是一张 JPEG 的标准 base64 文本（`content-type: text/plain`，带补齐、不换行，解出来开头是 `FF D8 FF`），回 `{"id": "<32 位小写 hex>"}` | 解码后 ≤ 1 MiB，请求体 ≤ 1398104 字节（边读边数，不信 `Content-Length`）；全站每天至多 280 张新截图；截图有总字节预算（见「第三段：反馈」） |
| `POST /v1/feedback` | 用户反馈（JSON）：`id`（32 位小写 hex，客户端每份草稿生成一次、重试复用）、`text`、`shots`（截图 id 数组）、`installId`（可不带或 `null`）、`diagnostics`、`version`、`os`、`arch`，回 `{"ok": true}` | 整条 ≤ 64 KiB；文字去掉首尾空白后 1–8000 字符；截图至多 3 张、不重复，必须是 24 小时内传上来、还没挂到别的反馈上的；诊断 ≤ 32 KiB；版本、系统 ≤ 32 字节，架构 ≤ 16 字节，只收可打印 ASCII；全站每天至多 200 条；文字有总字节预算 |
| `GET /admin` | 统计页（只有维护者能看） | 管理口令 |
| `GET /admin/shot/<id>` | 反馈截图原图（`image/jpeg`，`cache-control: private, no-store`） | 同一管理口令；没有的 404 |

两层异常的类别（`counts`）：`self` 里是 `panic`、`pageFault`、`uncaught`、`internal`；`external` 里是 `network`、`upstream`、`writeFailure`、`auth`。不认识的类别、字段一律 400——加类别时先改 `src/limits.ts` 并部署服务端，再发客户端。

所有上限集中在 `src/limits.ts`。出错一律回 JSON `{"error": "<代号>"}`，不带调用栈：400 形状不对、413 太大、404 / 405 路径或方法不对、429 被限流（带 `Retry-After`）、503 反馈库当天收满（`busy`）或存满（`full`）。反馈两个接口的代号见「第三段：反馈」。

**造出来的安装 ID 写不满库。** 安装 ID 可以随便造，按电脑的上限挡不住刷库，所以另有全局上限：

- **当天新电脑数**：每天（收到时的 UTC 日）至多 2 万台没见过的电脑。见过的电脑（`installs` 表里有）新的一天、补报都不受这条限。
- **字节预算**：`budget` 表记着每日上报（含 `installs`）和事件各占了多少字节，每行按「各列实际字节 + 固定开销」记，满了谁的新行都不收（已有的每日上报行照样更新）。每日上报 240 MB、事件 80 MB，加上其他表预留 30 MB，合计 350 MB，离 D1 免费档单库 500 MB 留着余量。
- **固定开销**是在本地 D1 用最大尺寸的行实测后取的上界，存在 `budget` 的 `cost_*` 配置行里：每日上报每行 256、每台新电脑 160、每条事件 3072 字节（事件看原文长短，一页刚好只放得下一条时最费，实测要 2351）。`test/capacity.test.ts` 用最大尺寸的行灌本地 D1，断言库文件实际长的不超过账上记的。
- **够多少真实用户**：真实的每日上报一行约 450 字节入账，240 MB 约 55 万行，保留 13 个月大约够日活 1400 台常年跑满；事件按每条带 3 KB 原文算约 6.6 KB 入账，80 MB 约 1.2 万条。真实用量接近时要提前汇总、调大预算（先实测）或换库，否则新数据会被少收。

计数和记账都由迁移里的触发器在真写入时做，判断和写入是同一条 SQL。事件的查重（唯一索引）、名额、预算也在同一条语句里，并发的重复请求只扣一次，没存下的不扣。定时任务清理后按实际剩下的行重算账。

**保留期**（每天 UTC 03:17 的定时任务，`src/retention.ts`）：每日上报原始记录 13 个月，之后按天并进 `daily_summary`（台数、版本分布、系统分布、各类次数之和）再删；错误事件 13 个月；每台每天的事件计数、每天新电脑数 7 天；`installs` 里没有剩下每日记录的电脑删掉；字节预算按剩下的重算。反馈库：没挂到反馈上的截图 24 小时后删；反馈与它的截图 12 个月；每天的计数 7 天；字节预算按剩下的重算。

## 统计页

打开 `https://<workers.dev 地址>/admin`，浏览器弹出登录框：用户名随便填，密码填管理口令（也认 `Authorization: Bearer <口令>`）。页面内容：近 30 天日活与两层异常次数、月活、最近一天的版本与系统分布、近 30 天各类异常、错误事件按签名合并（条数、电脑数、最近一次、样本原文）、最新 100 条反馈（时间、版本 / 系统 / 架构、安装 ID 前 8 位、文字、截图缩略图（长边至多 160，点开看原图）、诊断内容折叠）。页面只从本站加载截图（CSP `img-src 'self'`），不加载任何外部资源，所有内容先转义。

没有做的：留存、升级进度的趋势（spec R4 里有），等数据攒起来再定怎么看。

## 本地开发

需要 Node 22 以上。

```sh
cd server
npm ci
cp .dev.vars.example .dev.vars          # 本机的管理口令，已在 .gitignore
npx wrangler d1 migrations apply sophia-telemetry --local   # 建本地表；打印 ✅ 后若不退出，Ctrl-C 即可
npx wrangler d1 migrations apply sophia-feedback --local    # 反馈库，同上
npx wrangler dev                        # http://localhost:8787
```

本地状态（D1、限流计数）在 `.wrangler/`，已在 `.gitignore`。冒烟：

```sh
curl -s -H 'content-type: application/json' -d '{"installId":"'$(uuidgen | tr A-Z a-z)'","day":"'$(date -u +%F)'","version":"0.0.0","os":"macOS 15","arch":"aarch64","counts":{"self":{},"external":{}}}' http://localhost:8787/v1/daily
curl -s -u x:change-me-local-only http://localhost:8787/admin | head
```

客户端拼地址的方式是「基址 + `/v1/daily`」，所以基址写 `http://localhost:8787`（不带结尾斜杠）。调试版客户端按实施计划认运行时环境变量 `SOPHIA_REPORT_URL`，可指到这里做端到端验证。

## 测试

```sh
make test-server      # 仓库根目录；等于 cd server && npm ci && npx tsc --noEmit && npx vitest run
```

测试用 `@cloudflare/vitest-plugin` 跑在本地 workerd 里，D1、限流绑定、定时任务都是真的（miniflare），两个库的迁移由 `test/apply-migrations.ts` 应用，不需要 Cloudflare 账号。

## 部署（维护者在场）

所有命令在 `server/` 下执行。每一步都会改线上，先确认再跑。

1. 登录（只需一次，浏览器里点允许）：`npx wrangler login`
2. 建库：`npx wrangler d1 create sophia-telemetry`，把打印出的 `database_id` 填进 `wrangler.jsonc`（替换全 0 的占位），提交。反馈库同样：`npx wrangler d1 create sophia-feedback`，`database_id` 填进 `wrangler.jsonc` 里绑定 `FB` 那一项（替换全 f 的占位），提交。
3. 建表：`npx wrangler d1 migrations apply sophia-telemetry --remote`；反馈库 `npx wrangler d1 migrations apply sophia-feedback --remote`（迁移在 `migrations-feedback/`）
4. 部署：`npx wrangler deploy`，记下打印的 `https://api.<账号子域>.workers.dev`（现在是 `https://api.sophiakit.workers.dev`）。账号子域是整个 Cloudflare 账号共用的（面板 Workers & Pages →「Your subdomain」→ Change 可改，账号下所有 Worker 的地址一起变，新子域的证书要等几分钟）。地址会编进公开版，发版前定下来。
5. 设管理口令（交互输入，不经聊天、不进仓库；Worker 要先存在，所以放在部署之后）：`npx wrangler secret put ADMIN_TOKEN`。统计页没有输错次数限制，口令至少 12 位、字母数字混合。口令没设时统计页对谁都回 401。
6. 验证：无痕窗口打开 `/admin` 应弹登录框、口令错是 401；用上面的 `curl` 发一条每日上报，统计页当天日活 +1；传一张截图再发一条带它的反馈（见「第三段：反馈」的 `curl`），统计页「用户反馈」里有这条和缩略图。定时任务可在 Cloudflare 面板的 Worker → Settings → Triggers 里手动触发一次。验证用的测试行记得删掉（`npx wrangler d1 execute sophia-telemetry --remote --command "…"`）。
7. 在 GitHub 仓库设 Actions 变量 `SOPHIA_REPORT_URL` 为第 4 步的地址（不带结尾斜杠）。正式发版流水线在编译期注入它；没注入的构建（开发版、自己编译的、内部版）不发任何东西。

改了表结构就在 `migrations/`（反馈库是 `migrations-feedback/`）加新文件（`0002_….sql`），部署前跑第 3 步。

换自有域名：在 Cloudflare 面板给 Worker 加 Custom Domain，再把仓库变量改成新地址、重新打包即可，代码不用改。

## 免费档额度与超额

| 项 | 免费档 | 超了会怎样 |
|---|---|---|
| Workers 请求 | 每天 10 万次 | 当天之后的请求直接被拒（客户端发不出去，下次补发每日上报），不出账单 |
| Workers CPU | 每次请求 10 ms | 这次请求失败；统计页与定时任务的查询在 D1 那边算，部署后实测统计页 |
| D1 读 / 写 | 每天读 500 万行、写 10 万行 | 当天的查询报错（接口回 500），不出账单 |
| D1 存储 | 单库 500 MB，单行 2 MB | 写入报错。上报库：每日上报 240 MB、事件 80 MB 两道字节预算兜底；反馈库：截图 384 MiB、文字 32 MiB 两道字节预算兜底。两个库互不影响 |

不开付费档：付费档没有花费上限。建议在 Cloudflare 面板开账单告警。

## 首次部署实测（2026-10-04）

- 远端 D1：触发器、`INSERT … SELECT … RETURNING`、每日上报覆盖、事件去重与名额、字节计账都与本地一致。
- 限流绑定：免费档部署时接受了 `ratelimits`（部署输出列出 `env.RL`），但同一出口 IP 一分钟内约 280 次请求一次 429 都没有，**实际不起作用**。配置先留着（无害，日后升级或 Cloudflare 改了能直接生效）。目前防写满靠每台每天的事件上限、每天新电脑上限和字节预算；请求总额度（每天 10 万次）没有保护，被刷满只影响当天收数，不出账单。
- 国内网络能否送达 `workers.dev`（spec 风险 1）：2026-10-05 实测不开代理打不开、开代理正常。产品负责人定：先不买域名；要买就在腾讯云买 `.com`（留直接备案的路），交给 Cloudflare 解析、绑到这个 Worker。
- 反馈库（2026-10-05 部署）：764 KB 的 JPEG（base64 约 1 MB）上传约 2.3 秒成功，统计页缩略图与原图都能打开，免费档 CPU 够用；同 id 重发不重复入库；删掉测试行后字节预算自动归零。

## 第三段：反馈

反馈与截图放在**单独的 D1 库** `sophia-feedback`（绑定 `FB`，迁移在 `migrations-feedback/`），和每日上报、事件分开：匿名提交写满它，上报照样能存。上报库里第一段留的空表 `feedback` / `feedback_shot` 不再用，没删（`src/feedback.ts`、`src/retention.ts` 只碰反馈库）。

**两步提交。** 截图在 Sophia 里先缩到长边 1600、转 JPEG，放进小窗就逐张 `POST /v1/shot`（请求体是图的 base64），拿回 `id`；发送时 `POST /v1/feedback` 带上这些 `id`。插入反馈和把截图挂上去在同一个事务里：有一张不合规整条不收，别的截图也不挂；两条反馈同时挂同一张截图只有一条成功。

**截图存 base64 原文。** D1 在 Worker 里绑定、读出 BLOB 都要逐字节转成数字数组，1 MiB 约 20–29 ms，超过免费档每次 10 ms CPU；字符串不用转。所以客户端发 base64 文本，服务端只用一条正则查字符集、按长度算大小、解前 4 个字符查 `FF D8 FF`，原文存进 TEXT 列；统计页取图时再解回二进制（有原生 `Uint8Array.fromBase64` 就用它，否则 `atob` 加一遍循环）。

**反馈幂等。** `id` 由客户端给：同一 `id` 已经存过，就回 200 `{"ok": true}`、什么都不改（不看这次带的内容，也不再挂新截图），所以响应丢了重试不会重复入库，也不会因为截图已挂上而回 `bad_shot`。每次请求生成一个随机 nonce 存进它插入的那一行，挂截图只认这个 nonce：同一 `id` 的两次请求即便同一毫秒并发、各带不同截图，也只有真插进去的那次的截图挂上（`test/feedback.test.ts` 把关）。

| 接口 | 成功 | 失败 |
|---|---|---|
| `POST /v1/shot` | 200 `{"id": "<32 位小写 hex>"}` | 400 `bad_image`（`content-type` 不是 `text/plain`、空的、长度不是 4 的倍数、有 base64 以外的字符（含换行）、补齐号不在末尾、解出来不是 `FF D8 FF` 开头或不到 4 字节）；413 `too_large`（请求体超过 1398104 字节，或解码后超过 1 MiB）；429 `rate_limited`；503 `busy`（全站当天新截图已到 280 张）；503 `full`（截图预算腾不出地方） |
| `POST /v1/feedback` | 200 `{"ok": true}`（同 `id` 已存过也是这个） | 400 `bad_json`、`bad_shape`、`unknown_field`、`bad_id`、`bad_text`、`bad_shot`（形状不对、超过 3 张、重复、不存在、超过 24 小时、已挂到别的反馈上）、`bad_installId`、`bad_diagnostics`、`bad_version`、`bad_os`、`bad_arch`；413 `too_large`（整条超过 64 KiB）；429 `rate_limited`；503 `busy`（全站当天反馈已到 200 条）；503 `full`（文字预算满了）。截图不合规先回 400，其次才是 503 |

**写不满库。** 和上报库一样，`budget` 表按「各列实际字节 + 每行固定开销」记账（截图按存下的 base64 字节记），由迁移里的触发器在写入、删除时记；固定开销截图、反馈每行各 3072 字节（本地 D1 实测上界 2184 / 2112，`test/capacity.test.ts` 把关）。

- **截图预算 384 MiB**：新截图放不下时，先删过期没挂上的截图，再按上传时间删最旧的已挂上反馈的截图，删到刚好够；反馈文字一律保留。删光这些也腾不出就一张都不删、回 503 `full`。每天 280 张 × 单张存下至多约 1.34 MiB（约 375 MiB）小于预算，一天刷不满。没到上限、预算也够时只读预算与计数几行；真要淘汰时才另开一个事务扫截图表（免费档按读行数计，`test/shot.test.ts` 把关）。
- **文字预算 32 MiB**（反馈的各列）：满了不再收新反馈（503 `full`），不删旧的。两项合计约 436 MB，留在单库 500 MB 以内。
- **每天上限**：全站每天（收到时的 UTC 日）新截图 280 张、反馈 200 条。免费档限流实际不生效（见上），这是兜底。

**冒烟**（本地 `wrangler dev` 起来之后）：

```sh
printf '\xff\xd8\xff\xe0hello\xff\xd9' | base64 | tr -d '\n' > /tmp/s.b64
curl -s -H 'content-type: text/plain' --data-binary @/tmp/s.b64 http://localhost:8787/v1/shot   # {"id":"…"}
curl -s -H 'content-type: application/json' -d '{"id":"'$(uuidgen | tr -d - | tr A-Z a-z)'","text":"试一下","shots":["<上面的 id>"],"diagnostics":"","version":"0.0.0","os":"macOS 15","arch":"aarch64"}' http://localhost:8787/v1/feedback
```
