import Foundation

/// 在系统临时目录下建一棵真实的文件树，测试结束后删除。
struct TempTree {
  let root: URL
  private let fm = FileManager.default

  init() throws {
    root = fm.temporaryDirectory.appendingPathComponent("symsync-\(UUID().uuidString)")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
  }

  /// 相对 root 创建目录（可多级），返回其 URL
  @discardableResult
  func dir(_ relative: String) throws -> URL {
    let url = root.appendingPathComponent(relative)
    try fm.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  /// 在目录下创建一个小文件
  @discardableResult
  func file(_ directory: URL, _ name: String) throws -> URL {
    let url = directory.appendingPathComponent(name)
    try "x".write(to: url, atomically: true, encoding: .utf8)
    return url
  }

  /// 创建软链 at -> to（to 用绝对路径）
  func link(at: URL, to: URL) throws {
    try fm.createSymbolicLink(atPath: at.path, withDestinationPath: to.path)
  }

  func cleanup() {
    try? fm.removeItem(at: root)
  }
}
