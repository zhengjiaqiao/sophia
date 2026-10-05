//! `修复权限`（spec 2026-10-04-local-diagnostics R11）：把一份不归当前账户所有的文件改回来——
//! 经 macOS 的管理员授权（系统密码框）跑 `chown -h <uid> && chmod -h u+rw`。
//! 只给 Sophia 管的文件用（`App::managed_file` 先按字面白名单核对），有权限的那条命令里再核对一遍
//! （见 [`admin_script`]）；路径在脚本里两层转义：shell 单引号、再 AppleScript 字符串字面量，
//! 路径里有空格、引号、`$` 都不会变成命令。
use std::path::Path;
use std::process::Command;

/// 没做成
#[derive(Debug, PartialEq, Eq)]
pub enum FixError {
    /// 用户在系统密码框里点了取消（osascript 报 -128）：不是错，界面什么都不说
    Cancelled,
    /// 别的原因（原文，已是系统的话）
    Failed(String),
}

/// AppleScript 字符串字面量里的转义：反斜杠与双引号
fn applescript_string(text: &str) -> String {
    let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// shell 单引号字面量：`'` 写成 `'\''`
fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// 管理员授权跑的那一句。`path` 是已核对过的字面路径（`App::managed_file`）；在同一条有权限的命令里**再核对一遍**，
/// 挡住密码框等待期间被换掉：先 `cd -P` 进它的文件夹并确认真实文件夹没变（父目录被换成软链就对不上），
/// 之后只按 `./文件名` 动手（文件夹再被换也不影响已进去的那一个）；文件本身必须是普通文件、不是软链，
/// `chown -h` / `chmod -h` 都不跟随软链。路径里有控制字符（换行……）、不是绝对路径、没有文件名时拒绝。
/// `privileged`：false 时不带 `with administrator privileges`（只给本机自测用，见测试）
pub fn admin_script(path: &Path, uid: u32, privileged: bool) -> Option<String> {
    let text = path.to_str()?;
    if !path.is_absolute() || text.chars().any(char::is_control) {
        return None;
    }
    let folder = path.parent()?.to_str()?;
    let name = path.file_name()?.to_str()?;
    let (folder, name) = (shell_quote(folder), shell_quote(name));
    let command = format!(
        "cd -P -- {folder} && [ \"$(pwd -P)\" = {folder} ] \
         && [ -f ./{name} ] && [ ! -L ./{name} ] \
         && /usr/sbin/chown -h {uid} ./{name} && /bin/chmod -h u+rw ./{name}"
    );
    let mut script = format!("do shell script {}", applescript_string(&command));
    if privileged {
        script.push_str(" with administrator privileges");
    }
    Some(script)
}

/// 用户取消了系统密码框（`User canceled. (-128)`）
fn cancelled(stderr: &str) -> bool {
    stderr.contains("(-128)")
}

/// 跑脚本（阻塞，等用户在密码框里做完）
pub fn run(script: &str) -> Result<(), FixError> {
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| FixError::Failed(e.to_string()))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if cancelled(&stderr) {
        Err(FixError::Cancelled)
    } else {
        Err(FixError::Failed(stderr))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_checks_the_folder_and_never_follows_links() {
        let script = admin_script(Path::new("/Users/me/.codex/config.toml"), 501, true).unwrap();
        assert_eq!(
            script,
            "do shell script \"cd -P -- '/Users/me/.codex' && [ \\\"$(pwd -P)\\\" = '/Users/me/.codex' ] \
             && [ -f ./'config.toml' ] && [ ! -L ./'config.toml' ] \
             && /usr/sbin/chown -h 501 ./'config.toml' && /bin/chmod -h u+rw ./'config.toml'\" \
             with administrator privileges"
        );
        // 单引号在 shell 里转义；引号、反斜杠在 AppleScript 字面量里转义
        let odd = admin_script(Path::new("/tmp/it's \"x\"/a.json"), 501, false).unwrap();
        assert!(
            odd.contains("cd -P -- '/tmp/it'\\\\''s \\\"x\\\"'"),
            "{odd}"
        );
        assert_eq!(admin_script(Path::new("/tmp/a\nb.json"), 501, true), None);
        assert_eq!(admin_script(Path::new("relative.json"), 501, true), None);
        assert_eq!(admin_script(Path::new("/"), 501, true), None);
        assert!(cancelled("execution error: User canceled. (-128)"));
        assert!(!cancelled(
            "execution error: chown: /x: No such file or directory (1)"
        ));
    }

    /// 不要密码的那一半在本机真跑：改回自己（本来就是自己）的文件生效；路径里带空格、引号与 `$(…)` 不会被当成命令；
    /// 文件换成了软链（密码框等待期间被换掉）、或文件夹不是它说的那个真实文件夹时，什么都不动
    #[cfg(target_os = "macos")]
    #[test]
    fn script_runs_for_real_and_refuses_links() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let folder = root.join("my \"data\" $(touch pwned)");
        std::fs::create_dir(&folder).unwrap();
        let path = folder.join("a 'b' $(touch pwned).json");
        std::fs::write(&path, b"{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let uid = std::fs::metadata(&path).unwrap().uid();
        run(&admin_script(&path, uid, false).unwrap()).unwrap();
        assert_eq!(mode(&path) & 0o600, 0o600, "chmod u+rw 生效");
        assert!(!folder.join("pwned").exists() && !root.join("pwned").exists());

        // 文件本身被换成软链：不跟过去
        let target = root.join("target.json");
        std::fs::write(&target, b"{}").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o400)).unwrap();
        let link = folder.join("link.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(run(&admin_script(&link, uid, false).unwrap()).is_err());
        assert_eq!(mode(&target), 0o400);

        // 说的文件夹经过软链：真实文件夹对不上，不动
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&folder, &alias).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let via = alias.join(path.file_name().unwrap());
        assert!(run(&admin_script(&via, uid, false).unwrap()).is_err());
        assert_eq!(mode(&path), 0o000);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}
