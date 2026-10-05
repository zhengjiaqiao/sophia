export interface Env {
  DB: D1Database;
  /** 用户反馈与截图的库（sophia-feedback），和 DB 分开 */
  FB: D1Database;
  /** 按 IP 的限流绑定；免费档不可用时从 wrangler.jsonc 删掉，这里就是 undefined，跳过限流 */
  RL?: RateLimit;
  /** 统计页口令（wrangler secret）；没设时统计页一律 401 */
  ADMIN_TOKEN?: string;
}
