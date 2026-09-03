import Foundation

enum BookmarkAccess {
  static func makeBookmark(for url: URL) throws -> Data {
    try url.bookmarkData(
      options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
  }

  static func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) {
    var stale = false
    let url = try URL(
      resolvingBookmarkData: data, options: .withSecurityScope, relativeTo: nil,
      bookmarkDataIsStale: &stale)
    return (url, stale)
  }

  /// 在 body 执行期间持有所有 bookmark 的访问权，结束后释放。
  static func withAccess<T>(_ bookmarks: [Data], _ body: () throws -> T) throws -> T {
    var held: [URL] = []
    defer { held.forEach { $0.stopAccessingSecurityScopedResource() } }
    for data in bookmarks {
      let (url, _) = try resolve(data)
      if url.startAccessingSecurityScopedResource() {
        held.append(url)
      }
    }
    return try body()
  }
}
