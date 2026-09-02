import Foundation
import Testing

@testable import SymSyncCore

@Test func fileRuleStoreReturnsEmptyWhenMissingAndRoundTrips() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let store = FileRuleStore(fileURL: t.root.appendingPathComponent("sub/rules.json"))

  #expect(try store.load() == [])

  let rule = SyncRule(
    name: "r",
    source: Location(url: URL(fileURLWithPath: "/tmp/src"), bookmark: Data([9])),
    selection: .items(["a"]),
    targets: [Location(url: URL(fileURLWithPath: "/tmp/dst"))],
    lastRunAt: Date(timeIntervalSince1970: 1_700_000_000)
  )
  try store.save([rule])

  #expect(try store.load() == [rule])
}

@Test func grantStoreRoundTrips() throws {
  let t = try TempTree()
  defer { t.cleanup() }
  let store = GrantStore(fileURL: t.root.appendingPathComponent("grants.json"))
  let grant = Grant(path: "/Users/me", bookmark: Data([1]))

  #expect(try store.load() == [])
  try store.save([grant])
  #expect(try store.load() == [grant])
}

@Test func coveringMatchesSelfAndDescendantsOnly() {
  let grants = [
    Grant(path: "/Users/me", bookmark: Data([1])), Grant(path: "/opt/x", bookmark: Data([2])),
  ]

  #expect(grants.covering("/Users/me")?.bookmark == Data([1]))
  #expect(grants.covering("/Users/me/a/b/")?.bookmark == Data([1]))
  #expect(grants.covering("/opt/x/../x/y")?.bookmark == Data([2]))
  #expect(grants.covering("/Users/meow") == nil)
  #expect(grants.covering("/Users") == nil)
}
