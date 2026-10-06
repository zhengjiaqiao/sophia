//! 测试里等子进程的时间上限（#164）。冒充 `claude` / `codex` / 登录 shell 的小脚本平时几毫秒就跑完，
//! 但机器忙时（CI、本机同时编译）起进程可能要好几秒，上限写死 5 秒会偶发超时。

use std::time::Duration;

/// 期望成功的子进程最多等这么久：脚本跑完就返回，平时不会因此变慢，只是忙时不误报
pub const CHILD_OK: Duration = Duration::from_secs(30);

/// 测超时的用例里，到点后结束进程组、收尾返回最多再给这么久；仍远小于脚本自己 sleep 的时长，
/// 所以断言照样能证明「没有等满」
pub const KILL_SLACK: Duration = Duration::from_secs(5);
