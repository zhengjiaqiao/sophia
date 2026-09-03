import Foundation

/// 去掉 `.`、`..` 与尾部斜杠。不解析软链，保证同一路径两侧比较一致。
func normalizedPath(_ path: String) -> String {
  (path as NSString).standardizingPath
}

enum EntryKind: Equatable {
  case missing
  /// destination 为标准化后的绝对路径
  case symlink(destination: String)
  case file
  case directory
}

extension FileManager {
  /// 基于 lstat 判断条目类型，坏软链也会被识别为 symlink。
  func entryKind(atPath path: String) -> EntryKind {
    guard let attrs = try? attributesOfItem(atPath: path),
      let type = attrs[.type] as? FileAttributeType
    else { return .missing }
    switch type {
    case .typeSymbolicLink:
      let raw = (try? destinationOfSymbolicLink(atPath: path)) ?? ""
      let absolute =
        raw.hasPrefix("/")
        ? raw
        : ((path as NSString).deletingLastPathComponent as NSString).appendingPathComponent(raw)
      return .symlink(destination: normalizedPath(absolute))
    case .typeDirectory:
      return .directory
    default:
      return .file
    }
  }
}
