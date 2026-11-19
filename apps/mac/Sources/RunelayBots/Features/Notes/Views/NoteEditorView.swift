import SwiftUI

struct NoteEditorView: View {
    @Bindable var store: NoteEditorStore
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            if store.showsSidebar {
                NoteSidebar(store: store.sidebar, currentID: store.noteID)
                    .frame(width: 210)
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
            VStack(spacing: 0) {
                HStack(spacing: Spacing.s) {
                    HeaderIconButton(systemImage: "sidebar.left", help: store.showsSidebar ? "Esconder pastas" : "Mostrar pastas", isActive: store.showsSidebar) {
                        store.showsSidebar.toggle()
                    }
                    Text(breadcrumb)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Spacing.m)
                .frame(height: 32)
                ZStack(alignment: .topLeading) {
                    if store.note == nil, store.failed == nil {
                        VStack(alignment: .leading, spacing: Spacing.m) {
                            SkeletonRow(width: 260)
                            SkeletonRow(width: 200)
                        }
                        .padding(Spacing.xl)
                    } else {
                        NoteTextView(store: store)
                    }
                    if let context = store.linkContext, !store.suggestions.isEmpty {
                        NoteLinkSuggestions(store: store)
                            .offset(x: max(Spacing.s, context.anchor.minX - 12), y: context.anchor.maxY + Spacing.xs)
                            .transition(.opacity)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.background, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
                .clipShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
                NoteBacklinksFooter(store: store)
            }
            .padding(.trailing, Spacing.l)
            .padding(.leading, store.showsSidebar ? 0 : Spacing.l)
            .padding(.bottom, Spacing.l)
        }
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.showsSidebar)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.suggestions.isEmpty)
    }

    private var breadcrumb: String {
        guard let note = store.note else { return "" }
        let parts = note.folder.split(separator: "/").map(String.init) + [note.title]
        return parts.joined(separator: " › ")
    }
}

struct NoteLinkSuggestions: View {
    let store: NoteEditorStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(store.suggestions.enumerated()), id: \.offset) { index, hit in
                Button {
                    store.acceptSuggestion(hit)
                } label: {
                    HStack(spacing: Spacing.s) {
                        Image(systemName: hit.id.isEmpty ? "plus" : "doc.text")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Theme.textTertiary)
                            .frame(width: 14)
                        Text(hit.id.isEmpty ? "Criar “\(hit.title)”" : hit.title)
                            .font(TypeScale.rowSubtitle)
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: Spacing.s)
                        if !hit.folder.isEmpty {
                            Text(hit.folder.replacingOccurrences(of: "/", with: " › "))
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textTertiary)
                                .lineLimit(1)
                        }
                    }
                    .padding(.horizontal, Spacing.s)
                    .frame(height: 28)
                    .background(index == store.suggestionIndex ? Theme.selection : Color.clear, in: RoundedRectangle(cornerRadius: Radius.small - 2, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .clickable()
            }
        }
        .padding(Spacing.xs)
        .frame(width: 280)
        .glassSurface(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous), fallback: Theme.surfaceRaised)
        .softElevation(lifted: true)
    }
}

struct NoteBacklinksFooter: View {
    @Bindable var store: NoteEditorStore
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        let count = max(store.note?.backlinkCount ?? 0, store.backlinks.count)
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Button {
                store.showsBacklinks.toggle()
            } label: {
                HStack(spacing: Spacing.s) {
                    Image(systemName: "arrow.uturn.backward")
                        .font(.system(size: 11, weight: .medium))
                    Text(count == 0 ? "Nenhuma nota aponta para esta" : count == 1 ? "1 nota aponta para esta" : "\(count) notas apontam para esta")
                        .font(TypeScale.captionStrong)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if count > 0 {
                        Image(systemName: "chevron.up")
                            .font(.system(size: 10, weight: .semibold))
                            .rotationEffect(.degrees(store.showsBacklinks ? 0 : 180))
                    }
                }
                .foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, Spacing.s)
                .frame(height: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .clickable()
            .disabled(count == 0)
            if store.showsBacklinks, count > 0 {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Spacing.xxs) {
                        ForEach(store.backlinks) { link in
                            BacklinkRow(link: link) {
                                BlockCenter.shared.noteTitleChanged(botID: store.botID, id: link.id, title: link.title)
                                BlockCenter.shared.navigate(to: .note(botID: store.botID, id: link.id))
                            }
                        }
                        if store.backlinksNext != nil {
                            ProgressView()
                                .controlSize(.small)
                                .frame(maxWidth: .infinity)
                                .task { await store.loadMoreBacklinks() }
                        }
                    }
                }
                .frame(maxHeight: 160)
                .scrollEdgesHidden()
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .padding(.top, Spacing.s)
        .animation(Motion.animation(reduceMotion: reduceMotion), value: store.showsBacklinks)
    }
}

struct BacklinkRow: View {
    let link: NoteBacklink
    let open: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(link.title)
                    .font(TypeScale.rowSubtitle.weight(.medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(link.snippet.replacingOccurrences(of: "[[", with: "").replacingOccurrences(of: "]]", with: ""))
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, Spacing.s)
            .padding(.vertical, Spacing.xs + 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(hovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
    }
}

struct NoteSidebar: View {
    @Bindable var store: NoteSidebarStore
    let currentID: String

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            BlockSearchField(text: $store.query, prompt: "Buscar")
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if store.query.trimmingCharacters(in: .whitespaces).isEmpty {
                        NoteTreeLevelView(store: store, folder: "", depth: 0, currentID: currentID)
                    } else {
                        ForEach(store.results) { hit in
                            NoteSearchRow(hit: hit, isCurrent: hit.id == currentID) {
                                BlockCenter.shared.noteTitleChanged(botID: store.botID, id: hit.id, title: hit.title)
                                BlockCenter.shared.navigate(to: .note(botID: store.botID, id: hit.id))
                            }
                        }
                        if store.results.isEmpty, !store.searching {
                            Text("Nada encontrado")
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textTertiary)
                                .padding(Spacing.s)
                        }
                    }
                }
            }
            .scrollEdgesHidden()
        }
        .padding(.leading, Spacing.l)
        .padding(.trailing, Spacing.s)
        .padding(.bottom, Spacing.l)
    }
}

struct NoteTreeLevelView: View {
    let store: NoteSidebarStore
    let folder: String
    let depth: Int
    let currentID: String

    var body: some View {
        if let level = store.levels[folder] {
            ForEach(level.folders) { child in
                let open = store.expanded.contains(child.path)
                TreeRow(title: child.name, symbol: open ? "folder.fill" : "folder", depth: depth, isCurrent: false, chevron: open ? .down : .right) {
                    store.toggle(child.path)
                }
                if open {
                    NoteTreeLevelView(store: store, folder: child.path, depth: depth + 1, currentID: currentID)
                }
            }
            ForEach(level.notes.items) { note in
                TreeRow(title: note.title, symbol: "doc.text", depth: depth, isCurrent: note.id == currentID, chevron: nil) {
                    BlockCenter.shared.noteTitleChanged(botID: store.botID, id: note.id, title: note.title)
                    BlockCenter.shared.navigate(to: .note(botID: store.botID, id: note.id))
                }
            }
        }
    }
}

struct TreeRow: View {
    enum Chevron {
        case right
        case down
    }

    let title: String
    let symbol: String
    let depth: Int
    let isCurrent: Bool
    let chevron: Chevron?
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.xs + 2) {
                Group {
                    if let chevron {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .rotationEffect(.degrees(chevron == .down ? 90 : 0))
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 10)
                .foregroundStyle(Theme.textTertiary)
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(isCurrent ? Theme.textPrimary : Theme.textTertiary)
                    .frame(width: 14)
                Text(title)
                    .font(TypeScale.rowSubtitle)
                    .foregroundStyle(isCurrent ? Theme.textPrimary : Theme.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.leading, CGFloat(depth) * 14 + Spacing.xs)
            .padding(.trailing, Spacing.xs)
            .frame(height: 28)
            .background(isCurrent ? Theme.selection : hovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
    }
}

struct NoteSearchRow: View {
    let hit: NoteSearchHit
    let isCurrent: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(hit.title)
                    .font(TypeScale.rowSubtitle.weight(.medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                if let snippet = hit.snippet, !snippet.isEmpty {
                    Text(highlighted(snippet))
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                }
            }
            .padding(Spacing.s)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isCurrent ? Theme.selection : hovering ? Theme.hover : Color.clear, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
    }

    private func highlighted(_ snippet: String) -> AttributedString {
        var result = AttributedString(snippet)
        let utf16 = Array(snippet.utf16)
        for pair in hit.ranges ?? [] where pair.count == 2 && pair[0] < pair[1] && pair[1] <= utf16.count {
            let start = String.Index(utf16Offset: pair[0], in: snippet)
            let end = String.Index(utf16Offset: pair[1], in: snippet)
            if let lower = AttributedString.Index(start, within: result), let upper = AttributedString.Index(end, within: result) {
                result[lower..<upper].foregroundColor = Theme.textPrimary
                result[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
            }
        }
        return result
    }
}
