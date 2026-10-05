// 各种上限集中在这里；改了记得同步 README 与客户端

/** 与 wrangler.jsonc 里 ratelimits.simple.limit 一致（每 IP 每 60 秒） */
export const RATE_LIMIT_PER_MINUTE = 30;
export const RATE_LIMIT_PERIOD_SECONDS = 60;

export const DAILY_MAX_BYTES = 4 * 1024;
export const EVENT_MAX_BYTES = 64 * 1024;
export const EVENT_BODY_MAX_BYTES = 32 * 1024;
/** 同一台电脑每天最多收几条事件 */
export const EVENTS_PER_INSTALL_PER_DAY = 20;

// 短字段只收可打印 ASCII，按字节限长（库容按字节算，多字节字符会把账算小）
export const VERSION_MAX_BYTES = 32;
export const OS_MAX_BYTES = 32;
export const ARCH_MAX_BYTES = 16;
export const SIGNATURE_MAX_BYTES = 128;

/**
 * 每天（按收到时的 UTC 日）最多新来几台没见过的电脑。见过的电脑（installs 表里有）新的一天、
 * 补报都不受它限；安装 ID 可以随便造，这是挡刷库的兜底，给真实用户留足余量
 */
export const NEW_INSTALLS_PER_DAY = 20_000;

/*
 * 容量预算：账上按「各列实际字节 + 每行固定开销」记（触发器在真写入时记，定时任务按剩下的重算），
 * 存满就不再收新行。固定开销存在 budget 表的配置行里（见迁移），是在本地 D1 里用最大尺寸的行实测后取的上界
 * （test/capacity.test.ts 把关），含索引里重复存的列、页内碎片、名额 / 电脑表的附带行。
 * 三项之和留在 350 MB 以内（D1 免费档单库 500 MB）
 */
export const DAILY_STORE_BUDGET_BYTES = 240 * 1024 * 1024;
export const EVENT_STORE_BUDGET_BYTES = 80 * 1024 * 1024;
/** daily_summary、daily_new 等没进预算的表的预留（反馈与截图在单独的库，见下） */
export const OTHER_TABLES_RESERVE_BYTES = 30 * 1024 * 1024;

/** 单个类别一天的次数，超过的按这个数记 */
export const COUNT_MAX = 100_000;
/** 每日上报的日期：最多早 31 天；客户端本地日期可能比 UTC 早一天 */
export const DAILY_MAX_AGE_DAYS = 31;
export const DAILY_FUTURE_TOLERANCE_DAYS = 1;

/** 两层异常的类别。客户端（crates/core 的上报计数）用同一套键；加类别时两边一起改，服务端先部署 */
export const COUNT_KEYS = {
  self: ["panic", "pageFault", "uncaught", "internal"],
  external: ["network", "upstream", "writeFailure", "auth"],
} as const;

// ---- 用户反馈（单独的 D1 库 sophia-feedback，绑定 FB；与上面的预算互不相干） ----

/** 单张截图解码后的上限。客户端已缩到长边 1600 */
export const SHOT_MAX_BYTES = 1024 * 1024;
/**
 * 截图请求体是 JPEG 的标准 base64（带补齐），按原文存 TEXT：D1 绑定 / 读出 BLOB 都要在 Worker 里逐字节转数组，
 * 1 MiB 约 20–29 ms，超过免费档每次 10 ms CPU；字符串不用转。这是请求体（也是库里存的）最多的字节数
 */
export const SHOT_MAX_B64_BYTES = 4 * Math.ceil(SHOT_MAX_BYTES / 3);
/** 一条反馈的请求体（JSON） */
export const FEEDBACK_MAX_BYTES = 64 * 1024;
/** 反馈文字按字符（码点）数 */
export const FEEDBACK_TEXT_MAX_CHARS = 8000;
export const FEEDBACK_DIAGNOSTICS_MAX_BYTES = 32 * 1024;
export const FEEDBACK_MAX_SHOTS = 3;
/** 截图传上来多久之内能挂到反馈上；没挂上的过了这个时间由定时任务删掉 */
export const SHOT_ATTACH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 全站每天（按收到时的 UTC 日）最多收几张新截图、几条反馈：限流在免费档不生效，靠它兜底 */
export const NEW_SHOTS_PER_DAY = 280;
export const FEEDBACK_PER_DAY = 200;

/*
 * 反馈库的容量预算（记账方式同主库：各列实际字节 + 每行固定开销，固定开销在反馈库 budget 表的 cost_* 行，
 * test/capacity.test.ts 把关）。截图满了先删最旧的已挂上反馈的截图腾地方，文字一律保留；
 * 文字另有自己的预算，满了不再收新反馈。两项之和 416 MiB（约 436 MB），留在 D1 免费档单库 500 MB 以内。
 * 截图按存的 base64 字节记；每天新截图上限 × 单张存下的上限（280 × 约 1.34 MiB ≈ 375 MiB）小于截图预算，一天刷不满
 */
export const SHOT_STORE_BUDGET_BYTES = 384 * 1024 * 1024;
export const FEEDBACK_STORE_BUDGET_BYTES = 32 * 1024 * 1024;
