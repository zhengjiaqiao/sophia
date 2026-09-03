import Foundation

/// 一个目录及其沙盒 bookmark。bookmark 由 App 层写入，Core 不解释。
public struct Location: Codable, Equatable, Sendable {
  public var url: URL
  public var bookmark: Data?

  public init(url: URL, bookmark: Data? = nil) {
    self.url = url
    self.bookmark = bookmark
  }
}

/// 同步整目录，或只同步源目录下指定名字的子项。
public enum Selection: Codable, Equatable, Sendable {
  case all
  case items([String])
}

public struct SyncRule: Codable, Equatable, Identifiable, Sendable {
  public var id: UUID
  public var name: String
  public var source: Location
  public var selection: Selection
  public var targets: [Location]
  public var lastRunAt: Date?

  public init(
    id: UUID = UUID(),
    name: String,
    source: Location,
    selection: Selection = .all,
    targets: [Location] = [],
    lastRunAt: Date? = nil
  ) {
    self.id = id
    self.name = name
    self.source = source
    self.selection = selection
    self.targets = targets
    self.lastRunAt = lastRunAt
  }
}

public enum ActionKind: String, Equatable, Sendable {
  /// 目标不存在，将建链
  case create
  /// 已是指向正确源的软链，跳过
  case alreadyLinked
  /// 目标存在真实文件/目录或指向他处的软链，跳过并报告
  case conflict
  /// 指定子项在源里不存在
  case sourceMissing
  /// 目标里指向本源目录下、但源已不存在的软链
  case brokenLink
}

public struct PlannedAction: Equatable, Identifiable, Sendable {
  public let kind: ActionKind
  public let itemName: String
  /// 链接应指向的绝对路径
  public let sourcePath: URL
  /// 目标目录下的链接路径
  public let targetPath: URL
  /// 所属目标目录
  public let target: URL

  public var id: String { "\(kind.rawValue)|\(targetPath.path)" }

  public init(kind: ActionKind, itemName: String, sourcePath: URL, targetPath: URL, target: URL) {
    self.kind = kind
    self.itemName = itemName
    self.sourcePath = sourcePath
    self.targetPath = targetPath
    self.target = target
  }
}

public struct SyncReport: Equatable, Sendable {
  public enum Outcome: Equatable, Sendable {
    case created
    case skipped
    case removed
    case failed(String)
  }

  public struct Entry: Equatable, Sendable {
    public let action: PlannedAction
    public let outcome: Outcome

    public init(action: PlannedAction, outcome: Outcome) {
      self.action = action
      self.outcome = outcome
    }
  }

  public let entries: [Entry]

  public init(entries: [Entry]) {
    self.entries = entries
  }
}
