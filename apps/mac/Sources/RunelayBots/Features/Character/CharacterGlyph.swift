import Foundation

enum CharacterMood: Equatable, Sendable {
    case idle
    case thinking
    case speaking
    case waiting
    case error
    case sleeping
}

struct CharacterGlyph: Sendable {
    let dimension: Int
    let lit: [[Bool]]
    let visible: [[Bool]]
    let eyeRows: [Int]
    let mouthRow: Int

    init(rows: [String], eyeRows: [Int], mouthRow: Int) {
        let dimension = rows.count
        self.dimension = dimension
        lit = rows.map { row in row.map { $0 == "#" } }
        let center = Double(dimension - 1) / 2
        let radius = center + 0.75
        visible = (0..<dimension).map { row in
            (0..<dimension).map { col in
                let dy = Double(row) - center
                let dx = Double(col) - center
                return dx * dx + dy * dy <= radius * radius
            }
        }
        self.eyeRows = eyeRows
        self.mouthRow = mouthRow
    }

    func compacted(for id: String? = nil) -> CharacterGlyph {
        if let id, let handmade = Self.compactPreset(id) {
            return handmade.eyesOnly()
        }
        guard dimension == 9 else { return self }
        let groups: [[Int]] = [[0], [1, 2], [3], [4], [5], [6, 7], [8]]
        let rows = groups.map { rowGroup in
            String(
                groups.map { colGroup in
                    rowGroup.contains { row in colGroup.contains { col in lit[row][col] } } ? "#" : "."
                })
        }
        let mapRow: (Int) -> Int = { row in groups.firstIndex { $0.contains(row) } ?? row }
        var eyes: [Int] = []
        for row in eyeRows.map(mapRow) where !eyes.contains(row) {
            eyes.append(row)
        }
        return CharacterGlyph(rows: rows, eyeRows: eyes, mouthRow: mapRow(mouthRow))
    }

    func isLit(_ row: Int, _ col: Int) -> Bool {
        guard row < lit.count, col < lit[row].count else { return false }
        return lit[row][col]
    }

    func isVisible(_ row: Int, _ col: Int) -> Bool {
        visible[row][col]
    }

    static let presetIDs: [String] = ["crown", "visor", "antenna"]

    static let faceIDs: [String] = presetIDs + (1...11).map { "face-\($0)" }

    private static let faceRecipes: [(eyes: Int, mouth: Int, accessory: Int)] = [
        (0, 0, 0), (1, 1, 0), (2, 2, 1), (3, 0, 2), (4, 1, 3),
        (0, 3, 4), (1, 4, 5), (2, 0, 3), (3, 2, 0), (4, 4, 1), (0, 1, 2),
    ]

    static func face(_ id: String) -> CharacterGlyph? {
        guard id.hasPrefix("face-"), let number = Int(id.dropFirst(5)), number >= 1, number <= faceRecipes.count else {
            return nil
        }
        let recipe = faceRecipes[number - 1]
        return compose(eyes: eyeParts[recipe.eyes], mouth: mouthParts[recipe.mouth], accessory: accessoryParts[recipe.accessory])
    }

    static func forBot(id: String, glyph: String? = nil) -> CharacterGlyph {
        if let glyph, let known = preset(glyph) ?? face(glyph) {
            return known.eyesOnly()
        }
        return generated(seed: id).eyesOnly()
    }

    func eyesOnly() -> CharacterGlyph {
        guard let lastEye = eyeRows.max() else { return self }
        let rows = lit.enumerated().map { row, cells in
            String(cells.map { lit in lit && row <= lastEye ? "#" : "." })
        }
        return CharacterGlyph(rows: rows, eyeRows: eyeRows, mouthRow: mouthRow)
    }

    static func compactPreset(_ name: String) -> CharacterGlyph? {
        switch name {
        case "crown":
            CharacterGlyph(
                rows: [".#.#.#.", ".#####.", ".......", ".##.##.", ".......", "..###..", "......."],
                eyeRows: [3],
                mouthRow: 5
            )
        case "visor":
            CharacterGlyph(
                rows: [".......", ".......", ".##.##.", "#######", ".##.##.", "..###..", "......."],
                eyeRows: [2, 3, 4],
                mouthRow: 5
            )
        case "antenna":
            CharacterGlyph(
                rows: ["...#...", ".......", ".#...#.", ".#...#.", ".......", ".#...#.", "..###.."],
                eyeRows: [2, 3],
                mouthRow: 6
            )
        default:
            nil
        }
    }

    private static func preset(_ name: String) -> CharacterGlyph? {
        switch name {
        case "crown": crown
        case "visor": visor
        case "antenna": antenna
        default: nil
        }
    }

    static func generated(seed: String) -> CharacterGlyph {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in seed.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100_0000_01b3
        }
        let eyes = eyeParts[Int(hash % UInt64(eyeParts.count))]
        let mouth = mouthParts[Int((hash >> 8) % UInt64(mouthParts.count))]
        let accessory = accessoryParts[Int((hash >> 16) % UInt64(accessoryParts.count))]
        return compose(eyes: eyes, mouth: mouth, accessory: accessory)
    }

    private static func compose(
        eyes: (rows: [(Int, String)], eyeRows: [Int]),
        mouth: (rows: [(Int, String)], mouthRow: Int),
        accessory: [(Int, String)]
    ) -> CharacterGlyph {
        var grid = Array(repeating: Array(repeating: false, count: 9), count: 9)
        for part in [eyes.rows, mouth.rows, accessory] {
            for (row, line) in part {
                for (col, character) in line.enumerated() where character == "#" && col < 9 {
                    grid[row][col] = true
                }
            }
        }
        let rows = grid.map { line in String(line.map { $0 ? "#" : "." }) }
        return CharacterGlyph(rows: rows, eyeRows: eyes.eyeRows, mouthRow: mouth.mouthRow)
    }

    private static let eyeParts: [(rows: [(Int, String)], eyeRows: [Int])] = [
        ([(3, "..#...#.."), (4, "..#...#..")], [3, 4]),
        ([(3, ".##...##.")], [3]),
        ([(3, "..##.##.."), (4, "..##.##..")], [3, 4]),
        ([(2, "..#...#.."), (3, ".###.###."), (4, "..#...#..")], [2, 3, 4]),
        ([(3, ".#.....#."), (4, ".##...##.")], [3, 4]),
    ]

    private static let mouthParts: [(rows: [(Int, String)], mouthRow: Int)] = [
        ([(6, "...###...")], 6),
        ([(6, "..#...#.."), (7, "...###...")], 7),
        ([(6, "..#####..")], 6),
        ([(6, "....#....")], 6),
        ([(6, "...#.#..."), (7, "....#....")], 7),
    ]

    private static let accessoryParts: [[(Int, String)]] = [
        [],
        [(1, "...###...")],
        [(3, "#.......#"), (4, "#.......#")],
        [(1, ".##...##.")],
        [(5, ".#.....#.")],
        [(0, "...#.#..."), (1, "....#....")],
    ]

    static let crown = CharacterGlyph(
        rows: [
            "..#.#.#..",
            "..#####..",
            ".........",
            ".##...##.",
            ".##...##.",
            ".........",
            "..#####..",
            ".........",
            ".........",
        ],
        eyeRows: [3, 4],
        mouthRow: 6
    )

    static let visor = CharacterGlyph(
        rows: [
            ".........",
            ".........",
            ".###.###.",
            "#########",
            ".###.###.",
            ".........",
            "...###...",
            ".........",
            ".........",
        ],
        eyeRows: [2, 3, 4],
        mouthRow: 6
    )

    static let antenna = CharacterGlyph(
        rows: [
            "....#....",
            "....#....",
            ".........",
            "..#...#..",
            "..#...#..",
            ".#.....#.",
            "..#...#..",
            "...###...",
            ".........",
        ],
        eyeRows: [3, 4],
        mouthRow: 7
    )

    static let generic = CharacterGlyph(
        rows: [
            ".........",
            ".........",
            ".........",
            "..#...#..",
            "..#...#..",
            ".........",
            "...###...",
            ".........",
            ".........",
        ],
        eyeRows: [3, 4],
        mouthRow: 6
    )
}
