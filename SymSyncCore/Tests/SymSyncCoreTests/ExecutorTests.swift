import Foundation
import Testing

@testable import SymSyncCore

private func rule(_ src: URL, _ dst: URL) -> SyncRule {
  SyncRule(name: "r", source: Location(url: src), targets: [Location(url: dst)])
}

@Test func createActionsProduceAbsoluteSymlinks() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  let a = try t.file(src, "a.md")
  let actions = try Planner().plan(rule(src, dst))

  let report = Executor().run(actions)

  #expect(report.entries.map(\.outcome) == [.created])
  let dest = try FileManager.default.destinationOfSymbolicLink(
    atPath: dst.appendingPathComponent("a.md").path)
  #expect(dest == a.path)
  #expect(dest.hasPrefix("/"))
}

@Test func secondRunSkipsEverythingAndCreatesNothing() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  try t.file(src, "a.md")
  _ = Executor().run(try Planner().plan(rule(src, dst)))

  let report = Executor().run(try Planner().plan(rule(src, dst)))

  #expect(report.entries.map(\.action.kind) == [.alreadyLinked])
  #expect(report.entries.map(\.outcome) == [.skipped])
}

@Test func conflictIsSkippedAndRealFileUntouched() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  try t.file(src, "a.md")
  let real = dst.appendingPathComponent("a.md")
  try "original".write(to: real, atomically: true, encoding: .utf8)

  let report = Executor().run(try Planner().plan(rule(src, dst)))

  #expect(report.entries.map(\.outcome) == [.skipped])
  #expect(try String(contentsOf: real, encoding: .utf8) == "original")
  #expect(FileManager.default.entryKind(atPath: real.path) == .file)
}

@Test func missingTargetDirectoryFailsWithoutCreatingIt() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = t.root.appendingPathComponent("nope")
  try t.file(src, "a.md")

  let report = Executor().run(try Planner().plan(rule(src, dst)))

  #expect(report.entries.map(\.outcome) == [.failed("目标目录不存在")])
  #expect(FileManager.default.entryKind(atPath: dst.path) == .missing)
}

@Test func brokenLinksAreKeptUnlessCleanRequested() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  let gone = dst.appendingPathComponent("gone.md")
  try t.link(at: gone, to: src.appendingPathComponent("gone.md"))
  let foreign = dst.appendingPathComponent("foreign")
  try t.link(at: foreign, to: t.root.appendingPathComponent("elsewhere"))

  let kept = Executor().run(try Planner().plan(rule(src, dst)), cleanBroken: false)
  #expect(kept.entries.map(\.outcome) == [.skipped])
  #expect(FileManager.default.entryKind(atPath: gone.path) != .missing)

  let cleaned = Executor().run(try Planner().plan(rule(src, dst)), cleanBroken: true)
  #expect(cleaned.entries.map(\.outcome) == [.removed])
  #expect(FileManager.default.entryKind(atPath: gone.path) == .missing)
  #expect(FileManager.default.entryKind(atPath: foreign.path) != .missing)
}

@Test func brokenLinkReplacedByRealFileIsNotDeleted() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let dst = try t.dir("dst")
  let gone = dst.appendingPathComponent("gone.md")
  try t.link(at: gone, to: src.appendingPathComponent("gone.md"))

  let actions = try Planner().plan(rule(src, dst))
  #expect(actions.map(\.kind) == [.brokenLink])

  // 预览之后、执行之前，路径被换成了真实文件
  try FileManager.default.removeItem(at: gone)
  try "real".write(to: gone, atomically: true, encoding: .utf8)

  let report = Executor().run(actions, cleanBroken: true)

  #expect(report.entries.map(\.outcome) == [.failed("不再是软链接，已跳过")])
  #expect(FileManager.default.entryKind(atPath: gone.path) == .file)
  #expect(try String(contentsOf: gone, encoding: .utf8) == "real")
}

@Test func createFollowsSymlinkedTargetDirectory() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let src = try t.dir("src")
  let real = try t.dir("real")
  let dst = t.root.appendingPathComponent("dst")
  try t.link(at: dst, to: real)
  let a = try t.file(src, "a.md")

  let report = Executor().run(try Planner().plan(rule(src, dst)))

  #expect(report.entries.map(\.outcome) == [.created])
  let dest = try FileManager.default.destinationOfSymbolicLink(
    atPath: real.appendingPathComponent("a.md").path)
  #expect(dest == a.path)
}
