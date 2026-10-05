// 上报内容的形状校验。不认识的字段一律拒收：多收的东西可能就是不该收的东西
import { badRequest } from "./http";
import { COUNT_KEYS, COUNT_MAX } from "./limits";

export type Obj = Record<string, unknown>;

/** 小写的 UUID v4，正好 36 字节（客户端用 uuid crate 生成，就是这个写法） */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function asObject(v: unknown): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw badRequest("bad_shape");
  return v as Obj;
}

export function onlyKeys(o: Obj, allowed: readonly string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw badRequest("unknown_field");
}

/** 非空、只含可打印 ASCII 的短字符串（版本、系统、架构、签名），按字节限长 */
export function asciiField(v: unknown, field: string, maxBytes: number): string {
  if (typeof v !== "string" || v.length === 0 || v.length > maxBytes || !/^[\x20-\x7e]+$/.test(v)) {
    throw badRequest(`bad_${field}`);
  }
  return v;
}

export function installId(v: unknown): string {
  if (typeof v !== "string" || !UUID_V4.test(v)) throw badRequest("bad_installId");
  return v;
}

/** 'YYYY-MM-DD' 且是真实存在的日期，返回当天 0 点（UTC）的毫秒数 */
export function parseDay(v: unknown): number {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest("bad_day");
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) throw badRequest("bad_day");
  return t;
}

export type Counts = { self: Record<string, number>; external: Record<string, number> };

const U32_MAX = 2 ** 32 - 1;

/**
 * {self:{...}, external:{...}}：只认已知类别，次数是 u32 范围内的非负整数；没出现的类别算 0。
 * 超过 COUNT_MAX 的按 COUNT_MAX 记：客户端计数失控时，这一天的活跃记录不该跟着丢
 */
export function counts(v: unknown): Counts {
  const o = asObject(v);
  onlyKeys(o, ["self", "external"]);
  const out: Counts = { self: {}, external: {} };
  for (const layer of ["self", "external"] as const) {
    if (o[layer] === undefined) throw badRequest("bad_counts");
    const l = asObject(o[layer]);
    onlyKeys(l, COUNT_KEYS[layer]);
    for (const [k, n] of Object.entries(l)) {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > U32_MAX) throw badRequest("bad_counts");
      out[layer][k] = Math.min(n, COUNT_MAX);
    }
  }
  return out;
}
