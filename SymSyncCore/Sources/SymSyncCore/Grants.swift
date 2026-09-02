import Foundation

/// 用户通过选择框授权过的目录及其 security-scoped bookmark。
public struct Grant: Codable, Equatable, Sendable {
  public var path: String
  public var bookmark: Data

  public init(path: String, bookmark: Data) {
    self.path = normalizedPath(path)
    self.bookmark = bookmark
  }
}

public struct GrantStore: Sendable {
  public let fileURL: URL

  public init(fileURL: URL) {
    self.fileURL = fileURL
  }

  public func load() throws -> [Grant] {
    try JSONFile.load([Grant].self, from: fileURL) ?? []
  }

  public func save(_ grants: [Grant]) throws {
    try JSONFile.save(grants, to: fileURL)
  }
}

extension Array where Element == Grant {
  /// 返回覆盖该路径的授权：路径等于授权目录，或位于其下。
  public func covering(_ path: String) -> Grant? {
    let p = normalizedPath(path)
    return first { p == $0.path || p.hasPrefix($0.path + "/") }
  }
}
