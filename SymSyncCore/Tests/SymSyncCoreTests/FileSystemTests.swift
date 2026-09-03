import Foundation
import Testing

@testable import SymSyncCore

@Test func normalizedPathRemovesDotsAndTrailingSlash() {
  #expect(normalizedPath("/a/b/../c/") == "/a/c")
  #expect(normalizedPath("/a/./b") == "/a/b")
}

@Test func entryKindDistinguishesMissingFileDirectoryAndSymlink() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let d = try t.dir("d")
  let f = try t.file(d, "f")
  let l = d.appendingPathComponent("l")
  try t.link(at: l, to: f)
  let fm = FileManager.default

  #expect(fm.entryKind(atPath: d.appendingPathComponent("nope").path) == .missing)
  #expect(fm.entryKind(atPath: f.path) == .file)
  #expect(fm.entryKind(atPath: d.path) == .directory)
  #expect(fm.entryKind(atPath: l.path) == .symlink(destination: normalizedPath(f.path)))
}

@Test func entryKindReportsBrokenSymlinkAsSymlink() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let d = try t.dir("d")
  let gone = d.appendingPathComponent("gone")
  let l = d.appendingPathComponent("l")
  try t.link(at: l, to: gone)

  #expect(
    FileManager.default.entryKind(atPath: l.path)
      == .symlink(destination: normalizedPath(gone.path)))
  #expect(FileManager.default.fileExists(atPath: l.path) == false)
}

@Test func entryKindResolvesRelativeSymlinkAgainstItsDirectory() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let d = try t.dir("d")
  let f = try t.file(d, "f")
  let l = d.appendingPathComponent("l")
  try FileManager.default.createSymbolicLink(atPath: l.path, withDestinationPath: "f")

  #expect(
    FileManager.default.entryKind(atPath: l.path) == .symlink(destination: normalizedPath(f.path)))
}
