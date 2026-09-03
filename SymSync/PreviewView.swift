import SwiftUI
import SymSyncCore

struct PreviewView: View {
  @Environment(RuleListModel.self) private var model
  let rule: SyncRule
  @State private var rows: [Row] = []
  @State private var confirmClean = false

  struct Row: Identifiable {
    let action: PlannedAction
    var outcome: SyncReport.Outcome?
    var id: String { action.id }
  }

  private var canRun: Bool {
    model.isConfigured(rule) && !model.needsReauthorization(rule)
  }
  private var hasCreates: Bool { rows.contains { $0.action.kind == .create && $0.outcome == nil } }
  private var hasBroken: Bool {
    rows.contains { $0.action.kind == .brokenLink && $0.outcome == nil }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if model.needsReauthorization(rule) {
        Label("有目录需要重新授权，请重新选择源或目标", systemImage: "exclamationmark.triangle")
          .foregroundStyle(.orange)
      }
      HStack {
        Button("预览", action: preview).disabled(!canRun)
        Button("执行") { run(cleanBroken: false) }.disabled(!hasCreates)
        if hasBroken {
          Button("清理坏链") { confirmClean = true }
        }
        Spacer()
        if let last = rule.lastRunAt {
          Text("上次执行：\(last.formatted(date: .abbreviated, time: .shortened))")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      if !rows.isEmpty {
        Table(rows) {
          TableColumn("状态") { row in statusLabel(row) }.width(110)
          TableColumn("子项") { row in Text(row.action.itemName) }
          TableColumn("目标目录") { row in
            Text(row.action.target.path).lineLimit(1).truncationMode(.middle)
          }
        }
        .frame(minHeight: 200)
      }
    }
    .confirmationDialog("删除这些坏链接？", isPresented: $confirmClean) {
      Button("删除坏链接", role: .destructive) { run(cleanBroken: true) }
    } message: {
      Text("只删除指向本源目录且源已不存在的软链接，不会删除任何真实文件。")
    }
  }

  private func preview() {
    do {
      rows = try model.plan(rule).map { Row(action: $0, outcome: nil) }
    } catch {
      model.errorMessage = "预览失败：\(error.localizedDescription)"
    }
  }

  private func run(cleanBroken: Bool) {
    do {
      let report = try model.execute(rule, actions: rows.map(\.action), cleanBroken: cleanBroken)
      rows = report.entries.map { Row(action: $0.action, outcome: $0.outcome) }
    } catch {
      model.errorMessage = "执行失败：\(error.localizedDescription)"
    }
  }

  @ViewBuilder
  private func statusLabel(_ row: Row) -> some View {
    switch (row.action.kind, row.outcome) {
    case (_, .created): Text("已创建").foregroundStyle(.green)
    case (_, .removed): Text("已删除").foregroundStyle(.green)
    case (_, .failed(let reason)): Text("失败：\(reason)").foregroundStyle(.red)
    case (.create, _): Text("将创建").foregroundStyle(.blue)
    case (.alreadyLinked, _): Text("已链接").foregroundStyle(.secondary)
    case (.conflict, _): Text("冲突").foregroundStyle(.orange)
    case (.sourceMissing, _): Text("源缺失").foregroundStyle(.orange)
    case (.brokenLink, _): Text("坏链").foregroundStyle(.red)
    }
  }
}
