import SwiftUI
import SymSyncCore

struct PreviewView: View {
  @Environment(RuleListModel.self) private var model
  @Binding var rule: SyncRule
  @State private var rows: [Row] = []
  @State private var confirmClean = false

  struct Row: Identifiable {
    let action: PlannedAction
    var outcome: SyncReport.Outcome?
    var id: String { action.id }
  }

  private var needsReauthorization: Bool { model.needsReauthorization(rule) }
  private var canRun: Bool { model.isConfigured(rule) && !needsReauthorization }
  /// 待创建：预览得到、尚未执行的 create
  private var pendingCreates: [PlannedAction] {
    rows.filter { $0.action.kind == .create && $0.outcome == nil }.map(\.action)
  }
  /// 待清理：尚未删除的坏链
  private var pendingBroken: [PlannedAction] {
    rows.filter { $0.action.kind == .brokenLink && $0.outcome != .removed }.map(\.action)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if needsReauthorization {
        Label("有目录需要重新授权，请重新选择源或目标", systemImage: "exclamationmark.triangle")
          .foregroundStyle(.orange)
      }
      HStack {
        Button("预览", action: preview).disabled(!canRun)
        Button("执行") { run(pendingCreates, cleanBroken: false) }
          .disabled(!canRun || pendingCreates.isEmpty)
        if !pendingBroken.isEmpty {
          Button("清理坏链") { confirmClean = true }.disabled(!canRun)
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
    .onChange(of: rule) { old, new in
      // 配置变了，之前的预览作废；lastRunAt 变化不影响
      if old.source != new.source || old.selection != new.selection || old.targets != new.targets {
        rows = []
      }
    }
    .confirmationDialog("删除这些坏链接？", isPresented: $confirmClean) {
      Button("删除坏链接", role: .destructive) { run(pendingBroken, cleanBroken: true) }
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

  /// 只把选中的动作交给 Executor，结果按 action.id 合并回表格
  private func run(_ actions: [PlannedAction], cleanBroken: Bool) {
    do {
      let report = try model.execute(rule, actions: actions, cleanBroken: cleanBroken)
      let outcomes = Dictionary(
        report.entries.map { ($0.action.id, $0.outcome) }, uniquingKeysWith: { $1 })
      rows = rows.map { row in
        guard let outcome = outcomes[row.action.id] else { return row }
        return Row(action: row.action, outcome: outcome)
      }
      rule.lastRunAt = model.rules.first { $0.id == rule.id }?.lastRunAt
    } catch {
      model.errorMessage = "执行失败：\(error.localizedDescription)"
    }
  }

  @ViewBuilder
  private func statusLabel(_ row: Row) -> some View {
    // 先看执行结果，再看规划状态
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
