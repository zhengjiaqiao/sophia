// Sophia 接收服务入口：路由、限流、错误兜底；定时任务按保留期清理（两个库）
import { admin, adminShot } from "./admin";
import type { Env } from "./env";
import { HttpError, errorResponse, json } from "./http";
import { feedback, shot } from "./feedback";
import { daily, event } from "./ingest";
import { RATE_LIMIT_PERIOD_SECONDS } from "./limits";
import { feedbackRetention, retention } from "./retention";

type Handler = (req: Request, env: Env) => Promise<Response>;

const INGEST: Record<string, Handler> = {
  "/v1/daily": daily,
  "/v1/event": event,
  "/v1/shot": shot,
  "/v1/feedback": feedback,
};

function methodNotAllowed(allow: string) {
  return new HttpError(405, "method_not_allowed", { allow });
}

/** IP 只在这里当限流的键用一下，不写库、不写日志 */
async function rateLimit(req: Request, env: Env) {
  if (!env.RL) return;
  const { success } = await env.RL.limit({ key: req.headers.get("CF-Connecting-IP") ?? "no-ip" });
  if (!success) throw new HttpError(429, "rate_limited", { "retry-after": String(RATE_LIMIT_PERIOD_SECONDS) });
}

async function route(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);

  const ingest = INGEST[pathname];
  if (ingest) {
    if (req.method !== "POST") throw methodNotAllowed("POST");
    await rateLimit(req, env);
    return ingest(req, env);
  }

  if (pathname === "/admin" || pathname === "/admin/") {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed("GET, HEAD");
    return admin(req, env);
  }

  if (pathname.startsWith("/admin/shot/")) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed("GET, HEAD");
    return adminShot(req, env, pathname.slice("/admin/shot/".length));
  }
  throw new HttpError(404, "not_found");
}

export default {
  async fetch(req, env, _ctx): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse(e);
      // 只记错误名与消息，不带请求内容与 IP；对外不露调用栈
      console.error("unhandled", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: "internal" }, 500);
    }
  },

  async scheduled(controller, env, _ctx): Promise<void> {
    // 两个库各清各的：一个出错不耽误另一个，最后再把错抛出去（面板里能看到这次失败）
    const results = await Promise.allSettled([retention(env, controller.scheduledTime), feedbackRetention(env, controller.scheduledTime)]);
    for (const r of results) if (r.status === "rejected") throw r.reason;
  },
} satisfies ExportedHandler<Env>;
