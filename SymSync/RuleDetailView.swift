import SwiftUI
import SymSyncCore

struct RuleDetailView: View {
  @Environment(RuleListModel.self) private var model
  @State private var draft: SyncRule
  @State private var sourceItems: [String] = []

  init(rule: SyncRule) {
    _draft = State(initialValue: rule)
  }

  private var syncAll: Binding<Bool> {
    Binding(
      get: { if case .all = draft.selection { return true } else { return false } },
      set: { draft.selection = $0 ? .all : .items([]) }
    )
  }

  private var sourceLocation: Binding<Location?> {
    Binding(
      get: { draft.source.bookmark == nil ? nil : draft.source },
      set: {
        if let new = $0 {
          draft.source = new
          loadSourceItems()
        }
      }
    )
  }

  var body: some View {
    Form {
      Section("名称") {
        TextField("名称", text: $draft.name)
      }
      Section("源目录") {
        DirectoryField(title: "源目录", location: sourceLocation)
        Toggle("同步整个目录", isOn: syncAll)
        if !syncAll.wrappedValue {
          itemPicker
        }
      }
      Section("目标目录") {
        ForEach(draft.targets.indices, id: \.self) { index in
          HStack {
            DirectoryField(
              title: "目标 \(index + 1)",
              location: Binding(
                get: { draft.targets[index].bookmark == nil ? nil : draft.targets[index] },
                set: { if let new = $0 { draft.targets[index] = new } }
              )
            )
            Button(role: .destructive) {
              draft.targets.remove(at: index)
            } label: {
              Image(systemName: "minus.circle")
            }
            .buttonStyle(.borderless)
          }
        }
        Button("添加目标") {
          draft.targets.append(Location(url: URL(fileURLWithPath: "/")))
        }
      }
      Section("预览与执行") {
        previewSection
      }
    }
    .formStyle(.grouped)
    .onAppear(perform: loadSourceItems)
    .onChange(of: draft) { _, new in model.update(new) }
  }

  private var previewSection: some View {
    PreviewView(rule: draft)
  }

  private var itemPicker: some View {
    let selected = Binding<Set<String>>(
      get: { if case .items(let names) = draft.selection { return Set(names) } else { return [] } },
      set: { draft.selection = .items($0.sorted()) }
    )
    return VStack(alignment: .leading) {
      if sourceItems.isEmpty {
        Text("源目录为空或未设置").foregroundStyle(.secondary)
      }
      ForEach(sourceItems, id: \.self) { name in
        Toggle(
          name,
          isOn: Binding(
            get: { selected.wrappedValue.contains(name) },
            set: { on in
              var set = selected.wrappedValue
              if on { set.insert(name) } else { set.remove(name) }
              selected.wrappedValue = set
            }
          )
        )
      }
    }
  }

  private func loadSourceItems() {
    guard let bookmark = draft.source.bookmark else {
      sourceItems = []
      return
    }
    sourceItems =
      (try? BookmarkAccess.withAccess([bookmark]) {
        try FileManager.default.contentsOfDirectory(atPath: draft.source.url.path)
          .filter { !$0.hasPrefix(".") }
          .sorted()
      }) ?? []
  }
}
