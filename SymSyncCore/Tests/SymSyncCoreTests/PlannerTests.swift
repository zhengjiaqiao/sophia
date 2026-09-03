import Foundation
import Testing

@testable import SymSyncCore

private func rule(_ src: URL, _ targets: URL..., selection: Selection = .all) -> SyncRule {
  SyncRule(
    name: "r", source: Location(url: src), selection: selection,
    targets: targets.map { Location(url: $0) })
}

@Test func freshTargetPlansCreateForEachItem() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  try t.file(src, "a.md")
  try t.dir("src/b")

  let actions = try Planner().plan(rule(src, dst))

  #expect(actions.map(\.itemName) == ["a.md", "b"])
  #expect(actions.allSatisfy { $0.kind == .create })
  #expect(actions[0].sourcePath.path == src.appendingPathComponent("a.md").path)
  #expect(actions[0].targetPath.path == dst.appendingPathComponent("a.md").path)
  #expect(actions[0].target.path == dst.path)
}

@Test func existingCorrectLinkIsAlreadyLinked() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  let a = try t.file(src, "a.md")
  try t.link(at: dst.appendingPathComponent("a.md"), to: a)

  let actions = try Planner().plan(rule(src, dst))

  #expect(actions.map(\.kind) == [.alreadyLinked])
}

@Test func realFileWithSameNameIsConflict() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  try t.file(src, "a.md")
  try t.file(dst, "a.md")

  let actions = try Planner().plan(rule(src, dst))

  #expect(actions.map(\.kind) == [.conflict])
}

@Test func linkPointingElsewhereIsConflict() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  let other = try t.dir("other")
  try t.file(src, "a.md")
  let otherA = try t.file(other, "a.md")
  try t.link(at: dst.appendingPathComponent("a.md"), to: otherA)

  let actions = try Planner().plan(rule(src, dst))

  #expect(actions.map(\.kind) == [.conflict])
}

@Test func unreadableSourceThrows() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let dst = try t.dir("dst")
  let src = t.root.appendingPathComponent("missing")

  #expect(throws: PlannerError.sourceUnreadable(src.path)) {
    try Planner().plan(rule(src, dst))
  }
}

@Test func itemsSelectionWithUnreadableSourceThrows() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let dst = try t.dir("dst")
  let src = t.root.appendingPathComponent("missing")

  #expect(throws: PlannerError.sourceUnreadable(src.path)) {
    try Planner().plan(rule(src, dst, selection: .items(["a"])))
  }
}

@Test func selectedItemsOnlyPlanNamedEntriesAndReportMissing() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  try t.file(src, "a.md")
  try t.file(src, "b.md")

  let actions = try Planner().plan(rule(src, dst, selection: .items(["a.md", "zzz"])))

  #expect(actions.map(\.itemName) == ["a.md", "zzz"])
  #expect(actions.map(\.kind) == [.create, .sourceMissing])
}

@Test func hiddenEntriesAreSkippedInAllMode() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  try t.file(src, ".DS_Store")
  try t.file(src, "a.md")

  let actions = try Planner().plan(rule(src, dst))

  #expect(actions.map(\.itemName) == ["a.md"])
}

@Test func multipleTargetsArePlannedIndependently() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst1 = try t.dir("dst1")
  let dst2 = try t.dir("dst2")
  let a = try t.file(src, "a.md")
  try t.link(at: dst1.appendingPathComponent("a.md"), to: a)

  let actions = try Planner().plan(rule(src, dst1, dst2))

  #expect(actions.map(\.kind) == [.alreadyLinked, .create])
  #expect(actions.map(\.target.path) == [dst1.path, dst2.path])
}

@Test func brokenLinksUnderSourceAreReportedOthersIgnored() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  try t.file(src, "keep.md")
  try t.link(at: dst.appendingPathComponent("gone.md"), to: src.appendingPathComponent("gone.md"))
  try t.link(
    at: dst.appendingPathComponent("foreign"), to: t.root.appendingPathComponent("elsewhere/x"))

  let actions = try Planner().plan(rule(src, dst))

  #expect(actions.map(\.kind) == [.create, .brokenLink])
  #expect(actions[1].itemName == "gone.md")
  #expect(actions[1].sourcePath.path == src.appendingPathComponent("gone.md").path)
  #expect(actions[1].targetPath.path == dst.appendingPathComponent("gone.md").path)
}

@Test func liveLinkUnderSourceIsNotBroken() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  let a = try t.file(src, "a.md")
  try t.link(at: dst.appendingPathComponent("a.md"), to: a)

  let actions = try Planner().plan(rule(src, dst))

  #expect(actions.map(\.kind) == [.alreadyLinked])
}
