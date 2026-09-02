import Foundation
import SymSyncCore

@MainActor
@Observable
final class RuleListModel {
  var rules: [SyncRule] = []
  var selectedRuleID: UUID?
  var errorMessage: String?

  private var grants: [Grant] = []
  private let store: any RuleStore
  private let grantStore: GrantStore

  init(store: any RuleStore, grantStore: GrantStore) {
    self.store = store
    self.grantStore = grantStore
    do {
      rules = try store.load()
    } catch {
      errorMessage = "读取同步记录失败：\(error.localizedDescription)"
    }
    do {
      grants = try grantStore.load()
    } catch {
      errorMessage = "读取授权记录失败：\(error.localizedDescription)"
    }
  }

  // MARK: 规则增删改

  func addRule() -> SyncRule {
    let rule = SyncRule(name: "新同步", source: Location(url: URL(fileURLWithPath: "/")))
    rules.append(rule)
    selectedRuleID = rule.id
    persist()
    return rule
  }

  func update(_ rule: SyncRule) {
    guard let index = rules.firstIndex(where: { $0.id == rule.id }) else { return }
    rules[index] = rule
    persist()
  }

  func delete(_ id: UUID) {
    rules.removeAll { $0.id == id }
    if selectedRuleID == id { selectedRuleID = nil }
    persist()
  }

  private func persist() {
    do {
      try store.save(rules)
    } catch {
      errorMessage = "保存失败：\(error.localizedDescription)"
    }
  }

  // MARK: 授权

  /// 用户输入的路径若落在某个已授权目录下，返回可用的 Location；否则 nil。
  func location(forTypedPath path: String) -> Location? {
    let expanded = (path as NSString).expandingTildeInPath
    guard !expanded.isEmpty, let grant = grants.covering(expanded) else { return nil }
    return Location(url: URL(fileURLWithPath: expanded), bookmark: grant.bookmark)
  }

  /// 弹出选择框授权包含该路径的父目录，成功后返回该路径的 Location。
  func grantParent(of path: String) -> Location? {
    let expanded = (path as NSString).expandingTildeInPath
    let parent = URL(fileURLWithPath: expanded).deletingLastPathComponent()
    guard let chosen = DirectoryPicker.pick(message: "请授权包含该路径的目录", startingAt: parent) else {
      return nil
    }
    guard record(grantFor: chosen) != nil else { return nil }
    return location(forTypedPath: expanded)
  }

  /// 通过选择框选目录，生成 bookmark 并记录为授权。
  func chooseDirectory(message: String) -> Location? {
    guard let chosen = DirectoryPicker.pick(message: message) else { return nil }
    guard let grant = record(grantFor: chosen) else { return nil }
    return Location(url: chosen, bookmark: grant.bookmark)
  }

  private func record(grantFor url: URL) -> Grant? {
    do {
      let grant = Grant(path: url.path, bookmark: try BookmarkAccess.makeBookmark(for: url))
      grants.removeAll { $0.path == grant.path }
      grants.append(grant)
      try grantStore.save(grants)
      return grant
    } catch {
      errorMessage = "授权失败：\(error.localizedDescription)"
      return nil
    }
  }

  /// 已有 bookmark 但无法解析或已失效。bookmark 为 nil 表示尚未设置，不算需要重新授权。
  func needsReauthorization(_ rule: SyncRule) -> Bool {
    let locations = [rule.source] + rule.targets
    return locations.contains { location in
      guard let data = location.bookmark else { return false }
      guard let resolved = try? BookmarkAccess.resolve(data) else { return true }
      return resolved.isStale
    }
  }

  /// 源与所有目标都已通过授权设置。
  func isConfigured(_ rule: SyncRule) -> Bool {
    rule.source.bookmark != nil && !rule.targets.isEmpty
      && rule.targets.allSatisfy { $0.bookmark != nil }
  }

  // MARK: 同步

  func plan(_ rule: SyncRule) throws -> [PlannedAction] {
    try BookmarkAccess.withAccess(bookmarks(of: rule)) {
      try Planner().plan(rule)
    }
  }

  func execute(_ rule: SyncRule, actions: [PlannedAction], cleanBroken: Bool) throws -> SyncReport {
    let report = try BookmarkAccess.withAccess(bookmarks(of: rule)) {
      Executor().run(actions, cleanBroken: cleanBroken)
    }
    var updated = rule
    updated.lastRunAt = Date()
    update(updated)
    return report
  }

  private func bookmarks(of rule: SyncRule) -> [Data] {
    ([rule.source] + rule.targets).compactMap(\.bookmark)
  }
}
