-- Sophia 接收服务的表。任何表都不存 IP（连哈希也不存）：IP 只在限流时用一下。
-- 保留期（定时任务执行）：daily 13 个月后并进 daily_summary；event 13 个月；
-- event_quota、daily_new 7 天；installs 在没有剩下的每日记录时删；feedback 与 feedback_shot 12 个月。

-- 每日上报：每台电脑每天一行，同一天后来的上报覆盖前面的
CREATE TABLE daily (
  install_id  TEXT NOT NULL,
  day         TEXT NOT NULL,            -- 'YYYY-MM-DD'（客户端本地日期）
  version     TEXT NOT NULL,
  os          TEXT NOT NULL,
  arch        TEXT NOT NULL,
  counts_json TEXT NOT NULL,            -- {"self":{...},"external":{...}}
  updated_at  TEXT NOT NULL,            -- ISO 时间（UTC）
  PRIMARY KEY (install_id, day)
);
CREATE INDEX idx_daily_day ON daily(day);

-- 超过 13 个月的每日记录按天汇总后留在这里，原始行删除
CREATE TABLE daily_summary (
  day             TEXT PRIMARY KEY,
  installs        INTEGER NOT NULL,
  by_version_json TEXT NOT NULL,        -- {"1.2.0": 10, ...}
  by_os_json      TEXT NOT NULL,        -- {"macos15": 8, ...}
  counts_json     TEXT NOT NULL         -- 两层各类次数之和，形状同 daily.counts_json
);

-- Sophia 自身的错误 / 崩溃事件（去隐私后的原文）
CREATE TABLE event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,             -- 收到时的 UTC 日期
  install_id TEXT NOT NULL,
  version    TEXT NOT NULL,
  os         TEXT NOT NULL,
  signature  TEXT NOT NULL,
  body       TEXT NOT NULL,
  at         TEXT NOT NULL              -- 收到时的 ISO 时间（UTC）
);
-- 同一台电脑同一签名每天只留一条
CREATE UNIQUE INDEX idx_event_dedupe ON event(install_id, day, signature);
CREATE INDEX idx_event_day ON event(day);
CREATE INDEX idx_event_signature ON event(signature);

-- 每台电脑每天收了几条事件（上限见 src/limits.ts）
CREATE TABLE event_quota (
  install_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  n          INTEGER NOT NULL,
  PRIMARY KEY (install_id, day)
);

-- 全库的容量记账（上限见 src/limits.ts），定时任务清理后按实际重算（src/retention.ts，算法相同）。
-- 计数行：daily_bytes（每日上报原始行 + 电脑表）、event_bytes（事件 + 名额计数）。
-- 每行记「各列实际字节 + 固定开销」。固定开销是配置行（cost_*），取本地 D1 用最大尺寸的行实测的上界，
-- 含索引里重复存的定长列、页内碎片、附带的名额行；test/capacity.test.ts 把关「账上记的不少于库实际长的」
CREATE TABLE budget (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
INSERT INTO budget (k, v) VALUES
  ('daily_bytes', 0),
  ('event_bytes', 0),
  -- 实测（2026-10-04，本地 D1，最大字段、随机安装 ID）：每日上报每行连新电脑需 213 字节开销，取 256 + 160；
  -- 事件看原文长短，一行刚好挤不下两条 / 叶子页里只剩半页时最费，需 2351 字节，取 3072
  ('cost_daily_row', 256),    -- 每行每日上报除各列外的开销
  ('cost_install', 160),      -- 每台新电脑在 installs 表里的一行
  ('cost_event_row', 3072);   -- 每条事件除各列外的开销（含索引与它可能新建的一行名额计数）

-- 见过的电脑：见过的电脑新的一天、补报不受「当天新电脑数」的限。只在定时任务里删（没有剩下的每日记录时）
CREATE TABLE installs (
  install_id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL              -- 第一次收到时的 UTC 日期
);

-- 每天（收到时的 UTC 日）新来了几台没见过的电脑（上限见 src/limits.ts）；保留 7 天
CREATE TABLE daily_new (
  day TEXT PRIMARY KEY,
  n   INTEGER NOT NULL
);

-- 每日上报真的新建了一行才走这里；同一行再报走 UPSERT 的更新分支（下一个触发器）
CREATE TRIGGER daily_insert AFTER INSERT ON daily
BEGIN
  INSERT INTO daily_new (day, n)
    SELECT date('now'), 1 WHERE NOT EXISTS (SELECT 1 FROM installs WHERE install_id = NEW.install_id)
    ON CONFLICT (day) DO UPDATE SET n = n + 1;
  UPDATE budget SET v = v + (SELECT v FROM budget WHERE k = 'cost_install')
    WHERE k = 'daily_bytes' AND NOT EXISTS (SELECT 1 FROM installs WHERE install_id = NEW.install_id);
  INSERT OR IGNORE INTO installs (install_id, first_seen) VALUES (NEW.install_id, date('now'));
  UPDATE budget SET v = v + length(CAST(NEW.install_id AS BLOB)) + length(CAST(NEW.day AS BLOB)) + length(CAST(NEW.version AS BLOB)) + length(CAST(NEW.os AS BLOB)) + length(CAST(NEW.arch AS BLOB)) + length(CAST(NEW.counts_json AS BLOB)) + length(CAST(NEW.updated_at AS BLOB))
      + (SELECT v FROM budget WHERE k = 'cost_daily_row')
    WHERE k = 'daily_bytes';
END;

CREATE TRIGGER daily_update AFTER UPDATE ON daily
BEGIN
  UPDATE budget SET v = v + (length(CAST(NEW.install_id AS BLOB)) + length(CAST(NEW.day AS BLOB)) + length(CAST(NEW.version AS BLOB)) + length(CAST(NEW.os AS BLOB)) + length(CAST(NEW.arch AS BLOB)) + length(CAST(NEW.counts_json AS BLOB)) + length(CAST(NEW.updated_at AS BLOB)))
      - (length(CAST(OLD.install_id AS BLOB)) + length(CAST(OLD.day AS BLOB)) + length(CAST(OLD.version AS BLOB)) + length(CAST(OLD.os AS BLOB)) + length(CAST(OLD.arch AS BLOB)) + length(CAST(OLD.counts_json AS BLOB)) + length(CAST(OLD.updated_at AS BLOB)))
    WHERE k = 'daily_bytes';
END;

-- 事件真的存下了才扣名额、记字节：和插入在同一条语句里生效，重复或没存下的不扣。
-- 签名在两个索引里各存一份，所以多记两倍
CREATE TRIGGER event_insert AFTER INSERT ON event
BEGIN
  INSERT INTO event_quota (install_id, day, n) VALUES (NEW.install_id, NEW.day, 1)
    ON CONFLICT (install_id, day) DO UPDATE SET n = n + 1;
  UPDATE budget SET v = v + length(CAST(NEW.day AS BLOB)) + length(CAST(NEW.install_id AS BLOB)) + length(CAST(NEW.version AS BLOB)) + length(CAST(NEW.os AS BLOB)) + length(CAST(NEW.signature AS BLOB)) + length(CAST(NEW.body AS BLOB)) + length(CAST(NEW.at AS BLOB)) + 2 * length(CAST(NEW.signature AS BLOB))
      + (SELECT v FROM budget WHERE k = 'cost_event_row')
    WHERE k = 'event_bytes';
END;

-- 用户反馈；install_id 只在用户开着自动上报时才有。
-- 第三段（反馈小窗）才开放接口，现在没有路由写这两张表。第三段把截图挪到单独的 D1 库
--（每条反馈截图合计约 1 MB、有总容量预算、近满时先删最旧的截图、文字保留），
-- 届时用新迁移删掉这里的 feedback_shot。见 README「第三段：反馈」
CREATE TABLE feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  text        TEXT NOT NULL,
  install_id  TEXT,
  diagnostics TEXT,
  version     TEXT,
  os          TEXT
);
CREATE INDEX idx_feedback_at ON feedback(at);

-- 反馈截图：客户端已缩到长边 1600 的 JPEG，单张 ≤ 1 MB（D1 单行上限 2 MB）
CREATE TABLE feedback_shot (
  feedback_id INTEGER NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  n           INTEGER NOT NULL,
  jpeg        BLOB NOT NULL,
  PRIMARY KEY (feedback_id, n)
);
