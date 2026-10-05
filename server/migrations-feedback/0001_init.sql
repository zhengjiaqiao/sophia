-- 用户反馈库 sophia-feedback（绑定 FB）：反馈文字与截图，和每日上报、事件分开放，截图写满它也不影响上报。
-- 任何表都不存 IP（连哈希也不存）：IP 只在限流时用一下。
-- 保留期（定时任务执行，src/retention.ts）：没挂到反馈上的截图 24 小时；反馈与它的截图 12 个月；daily_count 7 天。
-- 截图预算满时先删过期没挂上的、再删最旧的已挂上的截图腾地方，反馈文字保留（src/feedback.ts）。

-- 一条反馈；id 是客户端给的 32 位小写 hex（每份草稿生成一次、重试复用，同 id 重发不重复入库）
CREATE TABLE feedback (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,            -- 收到时的 ISO 时间（UTC）
  day         TEXT NOT NULL,            -- 收到时的 UTC 日期
  text        TEXT NOT NULL,
  install_id  TEXT,                     -- 只在用户开着自动上报时才有
  diagnostics TEXT NOT NULL,            -- 客户端去隐私后的诊断内容
  version     TEXT NOT NULL,
  os          TEXT NOT NULL,
  arch        TEXT NOT NULL,
  nonce       TEXT NOT NULL             -- 插入它的那次请求的随机数：同 id 并发重发时只让真插进去的那次挂截图
);
CREATE INDEX idx_feedback_at ON feedback(at);

-- 截图：先单独上传（拿到 id），再随反馈挂上。客户端已缩到长边 1600 的 JPEG，解码后单张 ≤ 1 MiB。
-- 存上传的 base64 原文（TEXT，≤ 约 1.34 MB，D1 单行上限 2 MB）：BLOB 在 Worker 里绑定、读出都要逐字节转数组，太费 CPU
CREATE TABLE shot (
  id          TEXT PRIMARY KEY,         -- 32 位小写 hex（随机）
  feedback_id TEXT REFERENCES feedback(id) ON DELETE CASCADE, -- 还没挂上时为空
  at          TEXT NOT NULL,            -- 上传时的 ISO 时间（UTC）
  bytes       INTEGER NOT NULL,         -- 存的字节数（base64 原文长度，纯 ASCII）
  jpeg_b64    TEXT NOT NULL,            -- JPEG 的标准 base64（带补齐）
  CHECK (typeof(jpeg_b64) = 'text' AND bytes = length(jpeg_b64))
);
-- 统计页按反馈取截图、淘汰按「挂没挂上 + 上传时间」排
CREATE INDEX idx_shot_feedback ON shot(feedback_id, at);
CREATE INDEX idx_shot_at ON shot(at);

-- 全站每天（收到时的 UTC 日）收了几张新截图（kind = 'shot'）、几条反馈（kind = 'feedback'），上限见 src/limits.ts；保留 7 天
CREATE TABLE daily_count (
  day  TEXT NOT NULL,
  kind TEXT NOT NULL,
  n    INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
);

-- 容量记账（上限见 src/limits.ts），写入、删除都由触发器在真改动时记；定时任务清理后再按实际重算一次（算法相同）。
-- 计数行：shot_bytes（截图）、feedback_bytes（反馈文字等各列）。
-- 截图每行记「存的 base64 字节 + 固定开销」：id、上传时间、后来挂上的反馈 id 都是定长，和三个索引里的副本、溢出页末页的空余
-- 一起算进固定开销；反馈每行记「各列实际字节 + 固定开销」。固定开销取本地 D1 用最大尺寸的行实测的上界，
-- test/capacity.test.ts 把关「账上记的不少于库实际长的」
CREATE TABLE budget (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
INSERT INTO budget (k, v) VALUES
  ('shot_bytes', 0),
  ('feedback_bytes', 0),
  -- 实测（2026-10-05，本地 D1，挂上反馈的截图 / 字段全部最长的反馈）：叶子页里一页只放得下一行、
  -- 或溢出后留在叶子页的那截刚过半页时最费，截图需 2184、反馈需 2112 字节，都取 3072
  ('cost_shot_row', 3072),      -- 每张截图除 base64 原文外的开销（含 id、时间、反馈 id 与三个索引）
  ('cost_feedback_row', 3072);  -- 每条反馈除各列外的开销（含两个索引、当天计数行）

CREATE TRIGGER shot_insert AFTER INSERT ON shot
BEGIN
  INSERT INTO daily_count (day, kind, n) VALUES (substr(NEW.at, 1, 10), 'shot', 1)
    ON CONFLICT (day, kind) DO UPDATE SET n = n + 1;
  UPDATE budget SET v = v + NEW.bytes + (SELECT v FROM budget WHERE k = 'cost_shot_row') WHERE k = 'shot_bytes';
END;

CREATE TRIGGER shot_delete AFTER DELETE ON shot
BEGIN
  UPDATE budget SET v = v - OLD.bytes - (SELECT v FROM budget WHERE k = 'cost_shot_row') WHERE k = 'shot_bytes';
END;

CREATE TRIGGER feedback_insert AFTER INSERT ON feedback
BEGIN
  INSERT INTO daily_count (day, kind, n) VALUES (NEW.day, 'feedback', 1)
    ON CONFLICT (day, kind) DO UPDATE SET n = n + 1;
  UPDATE budget SET v = v + length(CAST(NEW.id AS BLOB)) + length(CAST(NEW.at AS BLOB)) + length(CAST(NEW.day AS BLOB)) + length(CAST(NEW.text AS BLOB)) + COALESCE(length(CAST(NEW.install_id AS BLOB)), 0) + length(CAST(NEW.diagnostics AS BLOB)) + length(CAST(NEW.version AS BLOB)) + length(CAST(NEW.os AS BLOB)) + length(CAST(NEW.arch AS BLOB)) + length(CAST(NEW.nonce AS BLOB))
      + (SELECT v FROM budget WHERE k = 'cost_feedback_row')
    WHERE k = 'feedback_bytes';
END;

CREATE TRIGGER feedback_delete AFTER DELETE ON feedback
BEGIN
  UPDATE budget SET v = v - (length(CAST(OLD.id AS BLOB)) + length(CAST(OLD.at AS BLOB)) + length(CAST(OLD.day AS BLOB)) + length(CAST(OLD.text AS BLOB)) + COALESCE(length(CAST(OLD.install_id AS BLOB)), 0) + length(CAST(OLD.diagnostics AS BLOB)) + length(CAST(OLD.version AS BLOB)) + length(CAST(OLD.os AS BLOB)) + length(CAST(OLD.arch AS BLOB)) + length(CAST(OLD.nonce AS BLOB)))
      - (SELECT v FROM budget WHERE k = 'cost_feedback_row')
    WHERE k = 'feedback_bytes';
END;
