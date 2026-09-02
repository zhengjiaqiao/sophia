import Foundation

public protocol RuleStore: Sendable {
  func load() throws -> [SyncRule]
  func save(_ rules: [SyncRule]) throws
}

/// 整个规则数组以一个 JSON 文件读写。
public struct FileRuleStore: RuleStore {
  public let fileURL: URL

  public init(fileURL: URL) {
    self.fileURL = fileURL
  }

  public func load() throws -> [SyncRule] {
    try JSONFile.load([SyncRule].self, from: fileURL) ?? []
  }

  public func save(_ rules: [SyncRule]) throws {
    try JSONFile.save(rules, to: fileURL)
  }
}

enum JSONFile {
  static func load<T: Decodable>(_ type: T.Type, from url: URL) throws -> T? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(type, from: Data(contentsOf: url))
  }

  static func save<T: Encodable>(_ value: T, to url: URL) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(value).write(to: url, options: .atomic)
  }
}
