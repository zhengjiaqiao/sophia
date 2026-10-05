# 隐私说明

[English](#privacy-notice)

Sophia 是在你电脑上运行的桌面应用。这份说明写清楚 Sophia 会从你的电脑往维护者那里发什么、不发什么、存多久、怎么关。

## 发什么

设置 › 关于里的「使用统计和错误报告」开着时（默认开），Sophia 每天给维护者的接收服务发一份每日上报，只有这几项：

- **安装 ID**：在你的电脑上随机生成的一串编号（UUID），不与你的账号、名字或电脑名关联，我们也无法从它反推出你是谁。关掉开关时从你的电脑上删除；再打开会换一个新的。
- **日期**：你电脑上的当天日期。
- **Sophia 的版本号**。
- **macOS 的大版本**，如 `macOS 15`。
- **芯片架构**：Apple 芯片（`aarch64`）或 Intel（`x86_64`）。
- **当天各类异常的次数**：Sophia 自身的（崩溃、页面出错、未捕获的错误、内部错误）和外部原因的（网络不通、第三方服务出错、写配置文件没写成、密钥被拒）。**只有次数**，没有错误原文。

同一天里，Sophia 至多每 6 小时用当天累计的次数覆盖一次那一天的记录，接收服务里每台电脑每天只有一行。发不出去不会打扰你，下次再补，最多补到 30 天前。

**Sophia 自身出错时**，另外发一条错误记录，帮维护者找到出错的地方。只针对 Sophia 自己的毛病：崩溃、页面出错、未捕获的错误、内部错误。网络不通、第三方服务出错、配置文件写不进、密钥被拒这类外部原因，仍然只有次数。一条错误记录包含：

- 安装 ID、Sophia 的版本号、macOS 的大版本；
- 错误原文与调用栈（出错时代码走到了哪里）；崩溃还带出错的线程名和时间；
- 一个按出错位置算出的编号，用来把同一处的错误归到一起。

错误原文发出前先去隐私：你电脑上的文件路径只留文件名（如 `…/config.toml`，用户名、项目名、文件夹名都去掉），网址里的参数、密钥、令牌、密码一类的值换成 `…`。同一处错误一天只发一次；接收服务每台电脑每天最多存 20 条。崩溃时来不及发，下次打开 Sophia 时补发。

**你主动反馈时**（设置 › 关于里的「反馈问题」，或出错处的「报告这个问题」），发出你写的内容和你放进去的截图，另外附上：Sophia 的版本号、macOS 的大版本、芯片架构，以及最近几天 Sophia 自己记下的警告和错误（最多 50 行，其中可能有第三方服务返回的错误说明；去隐私的办法同上：路径只留文件名，密钥一类的值换成 `…`）；从出错页打开时，还附上那条错误的详情。「使用统计和错误报告」开着时一并带上安装 ID，关着时不带。反馈不受这个开关影响——是你自己点的发送。截图里拍到什么就发什么，发之前请看一眼。

## 不发什么

用户名、项目名、skill 与 MCP 的内容、配置文件、密钥、你和模型之间的请求与回复、外部原因（网络、第三方服务、你的配置）引起的错误的原文——自动上报都不发（只有你主动反馈时附带的最近错误记录里可能有，见上）。你电脑上的文件和文件夹路径不发；Sophia 自身出错、错误原文里带着路径时，只留文件名。

**IP 地址**：任何网络请求都会带上你的 IP 地址。接收服务只在限流（防止被人刷）时短暂用到它，不写进数据库，也不保存它的哈希。

Sophia 的其他联网是功能本身要用的，直接连对应的服务，不经过维护者的服务器：检查 Sophia 更新（GitHub）、在「发现」里搜索和安装 skill / MCP（skills.sh、MCP Registry、GitHub）、菜单栏用量向 Claude Code、Codex 查你自己的用量、模型网关把你的请求转给你自己配置的服务商。

## 存多久

每日上报的原始记录存 13 个月；之后只留按天汇总的数字（台数、版本与系统的分布、各类异常次数之和），不再有安装 ID。错误记录存 13 个月后删除。反馈的文字与截图存 12 个月后删除；库快满时先删最旧的截图，文字保留。

只有维护者能看这些数据（统计页有口令）。数据存在 Cloudflare（Workers 与 D1）。

## 怎么关

- 设置 › 关于 › 「使用统计和错误报告」，关掉开关。关掉后你电脑上的安装 ID 立即删除，之后不再自动发送任何东西。
- 或者设环境变量 `DO_NOT_TRACK=1`：Sophia 不自动发送任何东西（设置里也不再显示这一行）。
- 开发版（debug 构建）、从源码自己编译的版本、内部版里没有接收服务的地址，从不发送。开发版只在开发者自己用环境变量把它指向测试用的接收服务时，才往那里发。

## 联系

对这份说明有疑问，请在 GitHub 提 issue：<https://github.com/zhengjiaqiao/sophia/issues>。关掉再打开开关会换一个新的安装 ID，旧 ID 下的记录 13 个月后自动删除。

这份说明会随 Sophia 新增的上报内容一起更新；没写在这里的东西，这一版不会发。

---

# Privacy notice

[中文](#隐私说明)

Sophia is a desktop app that runs on your Mac. This notice explains what Sophia sends from your computer to its maintainer, what it never sends, how long it is kept, and how to turn it off.

## What is sent

While **Usage statistics and error reports** in Settings › About is on (it is on by default), Sophia sends one daily report a day to the maintainer's collection service. It contains only:

- **Install ID**: a random identifier (UUID) generated on your computer. It is not linked to your account, your name or your computer's name, and it can't be traced back to you. Turning the switch off deletes it from your computer; turning it back on creates a new one.
- **Date**: today's date on your computer.
- **Sophia version**.
- **macOS major version**, e.g. `macOS 15`.
- **CPU architecture**: Apple silicon (`aarch64`) or Intel (`x86_64`).
- **How many errors of each kind happened that day**: Sophia's own (crashes, page errors, uncaught errors, internal errors) and external ones (network failures, third-party service errors, config files that couldn't be written, rejected API keys). **Counts only** — no error text.

Within a day, Sophia overwrites that day's record with the running totals at most once every 6 hours; the service keeps one row per computer per day. If a report can't be sent, Sophia stays quiet and tries again later, for up to 30 days back.

**When Sophia itself goes wrong**, it also sends an error record so the maintainer can find where the problem is. This covers only Sophia's own faults: crashes, page errors, uncaught errors and internal errors. External causes — network failures, third-party service errors, config files that couldn't be written, rejected API keys — are still counts only. An error record contains:

- the install ID, the Sophia version and the macOS major version;
- the error text and stack trace (where in the code it happened); a crash also includes the thread name and time;
- an identifier computed from where the error happened, used to group the same error together.

The error text is scrubbed before it is sent: file paths on your computer keep only the file name (e.g. `…/config.toml` — no user name, project or folder names), and URL parameters, keys, tokens, passwords and similar values become `…`. The same error is sent at most once a day, and the collection service keeps at most 20 records per computer per day. A crash can't be sent while it happens, so it is sent the next time you open Sophia.

**When you send feedback yourself** (**Send feedback** in Settings › About, or **Report this problem** where something went wrong), Sophia sends what you wrote and the screenshots you added, plus: the Sophia version, the macOS major version, the CPU architecture, and the warnings and errors Sophia itself logged in the last few days (at most 50 lines, which may include error messages returned by third-party services; scrubbed the same way: file paths keep only the file name, keys and similar values become `…`); opened from an error page, it also includes that error's details. The install ID is included only while Usage statistics and error reports is on. Feedback does not depend on that switch — you choose to send it. A screenshot sends whatever it shows, so take a look before sending.

## What is never sent

Usernames, project names, the contents of your skills and MCP servers, config files, API keys, requests to and replies from models, and the text of errors with external causes (network, third-party services, your own configuration) — none of it is sent automatically (only the recent error records attached when you send feedback yourself may include some, see above). File and folder paths on your computer are not sent; when an error from Sophia itself contains a path, only the file name is kept.

**IP address**: every network request carries your IP address. The collection service uses it only briefly for rate limiting (to stop abuse); it is not written to the database and no hash of it is kept.

Sophia's other network use is part of its features and goes directly to the service involved, never through the maintainer's servers: checking for Sophia updates (GitHub), searching and installing skills / MCP servers in Discover (skills.sh, the MCP Registry, GitHub), menu bar usage asking Claude Code and Codex for your own usage, and the model gateway forwarding your requests to the providers you configured.

## How long it is kept

Raw daily reports are kept for 13 months. After that only per-day totals remain (number of installs, version and OS breakdown, summed error counts), with no install IDs. Error records are deleted after 13 months. Feedback text and screenshots are deleted after 12 months; if storage runs low, the oldest screenshots are deleted first and the text is kept.

Only the maintainer can see this data (the statistics page is password-protected). It is stored on Cloudflare (Workers and D1).

## How to turn it off

- Settings › About › **Usage statistics and error reports**: turn the switch off. The install ID on your computer is deleted immediately and nothing is sent automatically from then on.
- Or set the environment variable `DO_NOT_TRACK=1`: Sophia sends nothing automatically (and the setting is hidden).
- Development (debug) builds, builds you compile from source yourself, and internal builds contain no collection address and never send anything. A development build sends only when a developer explicitly points it at a test collection service with an environment variable.

## Contact

For questions about this notice, open an issue on GitHub: <https://github.com/zhengjiaqiao/sophia/issues>. Turning the switch off and on gives you a new install ID; records under the old one are deleted automatically after 13 months.

This notice is updated whenever Sophia starts sending something new; anything not listed here is not sent by this version.
