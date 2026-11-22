import Foundation

enum CommandPhrase {
    static func describe(_ command: String) -> (verb: String, object: String?)? {
        let text = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let lower = text.lowercased()
        let words = significantWords(lower)
        func has(_ pattern: String) -> Bool { lower.range(of: pattern, options: .regularExpression) != nil }
        if has(#"\b(tsc|vue-tsc|svelte-check)\b"#) || has(#"run (typecheck|check-types|types)\b"#) { return (tr("Checando tipos"), nil) }
        if has(#"\b(vitest|jest|playwright test|pytest|mocha)\b"#) || has(#"\b(npm|pnpm|yarn|bun) (run )?test\b"#) || has(#"\b(go|cargo|swift) test\b"#) { return (tr("Rodando os testes"), nil) }
        if has(#"\b(biome|eslint|prettier|swiftlint|ruff)\b"#) || has(#"run (lint|format)\b"#) { return (tr("Checando o estilo do código"), nil) }
        if has(#"\b(npm|pnpm|yarn|bun) (run )?build\b"#) || has(#"\b(swift|cargo|go) build\b"#) || has(#"\bvite build\b"#) { return (tr("Gerando o build"), nil) }
        if has(#"\b(npm (ci|install|i)|pnpm (install|i|add)|yarn (install|add)|bun (install|add))\b"#) { return (tr("Instalando dependências"), nil) }
        if has(#"\bsed -i\b"#) || has(#"\bperl -pi\b"#) { return (tr("Editando"), fileName(in: text)) }
        if has(#"^(python3?|node|tsx)\s+-\s*<<"#) || has(#"^(python3?|node) -c\b"#) {
            return lower.contains("write") || lower.contains("open(") || lower.contains("writefile") ? (tr("Editando arquivos com um script"), fileName(in: text)) : (tr("Rodando um script"), nil)
        }
        if has(#"^git (diff|status|log|show)\b"#) { return (tr("Olhando as mudanças no git"), nil) }
        if has(#"^(grep|rg|ag)\b"#) { return (tr("Procurando no código"), quoted(in: text)) }
        if has(#"^(sed -n|cat|head|tail|less|nl|wc)\b"#) { return (tr("Lendo"), fileName(in: text)) }
        if has(#"^(ls|find|tree)\b"#) { return (tr("Listando arquivos"), nil) }
        if has(#"^(curl|wget|http)\b"#) { return (tr("Chamando uma URL"), nil) }
        if has(#"\b(npm|pnpm|yarn|bun) run (dev|start)\b"#) { return (tr("Subindo o app"), nil) }
        if let first = words.first, ["mkdir", "mv", "cp", "rm", "touch"].contains(first) {
            let verbs = ["mkdir": tr("Criando a pasta"), "mv": tr("Movendo"), "cp": tr("Copiando"), "rm": tr("Apagando"), "touch": tr("Criando")]
            return (verbs[first] ?? tr("Rodando"), fileName(in: text))
        }
        if has(#"^sleep\b"#) { return (tr("Esperando"), nil) }
        return nil
    }

    private static func significantWords(_ text: String) -> [String] {
        let first = text.components(separatedBy: CharacterSet(charactersIn: ";&|\n")).first ?? text
        return first.split(separator: " ").map(String.init).filter { !$0.contains("=") && $0 != "timeout" && Int($0) == nil }
    }

    private static func fileName(in text: String) -> String? {
        let pattern = #"[\w./-]+\.(ts|tsx|js|jsx|swift|json|md|sql|css|py|sh|yml|yaml|toml)\b"#
        guard let range = text.range(of: pattern, options: .regularExpression) else { return nil }
        return (String(text[range]) as NSString).lastPathComponent
    }

    private static func quoted(in text: String) -> String? {
        guard let range = text.range(of: #"["']([^"']{2,40})["']"#, options: .regularExpression) else { return nil }
        return String(text[range]).trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
    }
}
