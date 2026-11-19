import Foundation

struct SkillSummary: Codable, Identifiable, Hashable {
    let slug: String
    let name: String
    var description: String = ""

    var id: String { slug }

    init(slug: String, name: String, description: String = "") {
        self.slug = slug
        self.name = name
        self.description = description
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        slug = try container.decode(String.self, forKey: .slug)
        let decodedName = (try? container.decode(String.self, forKey: .name)) ?? ""
        name = decodedName.isEmpty ? slug : decodedName
        description = (try? container.decode(String.self, forKey: .description)) ?? ""
    }

    var invocation: String { "/\(name)" }
}
