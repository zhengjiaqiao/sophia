import Foundation
import Testing

@testable import SymSyncCore

@Test func syncRuleRoundTripsThroughJSON() throws {
  let rule = SyncRule(
    name: "skills",
    source: Location(url: URL(fileURLWithPath: "/tmp/src"), bookmark: Data([1, 2])),
    selection: .items(["a", "b"]),
    targets: [Location(url: URL(fileURLWithPath: "/tmp/dst"))],
    lastRunAt: Date(timeIntervalSince1970: 1_700_000_000)
  )
  let data = try JSONEncoder().encode(rule)
  let decoded = try JSONDecoder().decode(SyncRule.self, from: data)
  #expect(decoded == rule)
}

@Test func plannedActionIDIsUniquePerKindAndTargetPath() {
  let path = URL(fileURLWithPath: "/tmp/dst/a")
  let src = URL(fileURLWithPath: "/tmp/src/a")
  let create = PlannedAction(
    kind: .create, itemName: "a", sourcePath: src, targetPath: path,
    target: path.deletingLastPathComponent())
  let broken = PlannedAction(
    kind: .brokenLink, itemName: "a", sourcePath: src, targetPath: path,
    target: path.deletingLastPathComponent())
  #expect(create.id != broken.id)
}
