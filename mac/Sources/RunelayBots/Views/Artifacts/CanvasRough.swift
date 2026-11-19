import SwiftUI

struct CanvasRandom {
    private var state: UInt64

    init(seed: UInt64, salt: UInt64 = 0) {
        state = seed ^ (salt &* 0x9E37_79B9_7F4A_7C15)
    }

    mutating func next() -> CGFloat {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z ^= z >> 31
        return CGFloat(z >> 11) / CGFloat(1 << 53)
    }

    mutating func range(_ low: CGFloat, _ high: CGFloat) -> CGFloat {
        low + (high - low) * next()
    }
}

enum CanvasRough {
    static func seed(_ id: String) -> UInt64 {
        var hash: UInt64 = 0xCBF2_9CE4_8422_2325
        for byte in id.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100_0000_01B3
        }
        return hash
    }

    static func flatten(_ path: Path, step: CGFloat) -> [(points: [CGPoint], closed: Bool)] {
        var result: [(points: [CGPoint], closed: Bool)] = []
        var current: [CGPoint] = []
        var last = CGPoint.zero
        func finish(closed: Bool) {
            if current.count > 1 {
                result.append((current, closed))
            }
            current = []
        }
        func addLine(to point: CGPoint) {
            let length = hypot(point.x - last.x, point.y - last.y)
            let count = max(1, Int(length / step))
            for index in 1...count {
                let t = CGFloat(index) / CGFloat(count)
                current.append(CGPoint(x: last.x + (point.x - last.x) * t, y: last.y + (point.y - last.y) * t))
            }
            last = point
        }
        path.forEach { element in
            switch element {
            case .move(let point):
                finish(closed: false)
                current = [point]
                last = point
            case .line(let point):
                addLine(to: point)
            case .quadCurve(let point, let control):
                let start = last
                for index in 1...12 {
                    let t = CGFloat(index) / 12
                    let u = 1 - t
                    current.append(CGPoint(x: u * u * start.x + 2 * u * t * control.x + t * t * point.x, y: u * u * start.y + 2 * u * t * control.y + t * t * point.y))
                }
                last = point
            case .curve(let point, let control1, let control2):
                let start = last
                for index in 1...14 {
                    let t = CGFloat(index) / 14
                    let u = 1 - t
                    let a = u * u * u
                    let b = 3 * u * u * t
                    let c = 3 * u * t * t
                    let d = t * t * t
                    current.append(CGPoint(
                        x: a * start.x + b * control1.x + c * control2.x + d * point.x,
                        y: a * start.y + b * control1.y + c * control2.y + d * point.y
                    ))
                }
                last = point
            case .closeSubpath:
                if let first = current.first {
                    addLine(to: first)
                }
                finish(closed: true)
            }
        }
        finish(closed: false)
        return result
    }

    private static func wobble(_ points: [CGPoint], closed: Bool, amplitude: CGFloat, random: inout CanvasRandom) -> [CGPoint] {
        guard points.count > 1 else { return points }
        let f1 = random.range(0.7, 1.4)
        let f2 = random.range(2.0, 3.4)
        let p1 = random.range(0, .pi * 2)
        let p2 = random.range(0, .pi * 2)
        let shift = CGPoint(x: random.range(-0.5, 0.5) * amplitude, y: random.range(-0.5, 0.5) * amplitude)
        var output: [CGPoint] = []
        var travelled: CGFloat = 0
        for index in points.indices {
            if index > 0 {
                travelled += hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y)
            }
            let previous = points[index > 0 ? index - 1 : (closed ? points.count - 2 : 0)]
            let next = points[index < points.count - 1 ? index + 1 : (closed ? 1 : points.count - 1)]
            let dx = next.x - previous.x
            let dy = next.y - previous.y
            let length = max(hypot(dx, dy), 0.0001)
            let s = travelled / 46
            let offset = amplitude * (sin(f1 * s + p1) * 0.65 + sin(f2 * s + p2) * 0.35)
            output.append(CGPoint(x: points[index].x - dy / length * offset + shift.x, y: points[index].y + dx / length * offset + shift.y))
        }
        return output
    }

    static func outline(_ base: Path, seed: UInt64, amplitude: CGFloat, passes: Int = 2) -> Path {
        var path = Path()
        let parts = flatten(base, step: 6)
        for pass in 0..<passes {
            var random = CanvasRandom(seed: seed, salt: UInt64(pass + 1))
            for part in parts {
                var points = part.points
                if part.closed, points.count > 4 {
                    let extra = max(2, points.count / 14)
                    points.append(contentsOf: points[1...extra])
                }
                let wobbled = wobble(points, closed: part.closed, amplitude: amplitude * (pass == 0 ? 1 : 1.3), random: &random)
                guard let first = wobbled.first else { continue }
                path.move(to: first)
                for point in wobbled.dropFirst() {
                    path.addLine(to: point)
                }
            }
        }
        return path
    }

    static func hachure(in rect: CGRect, spacing: CGFloat, seed: UInt64, amplitude: CGFloat) -> Path {
        var path = Path()
        guard rect.width > 0, rect.height > 0, spacing > 1 else { return path }
        var random = CanvasRandom(seed: seed, salt: 99)
        let slope: CGFloat = 0.9
        var x = rect.minX - rect.height / slope
        while x < rect.maxX {
            let start = CGPoint(x: x + random.range(-1, 1) * amplitude, y: rect.maxY + random.range(-1, 1) * amplitude)
            let end = CGPoint(x: x + rect.height / slope + random.range(-1, 1) * amplitude, y: rect.minY + random.range(-1, 1) * amplitude)
            path.move(to: start)
            path.addQuadCurve(to: end, control: CGPoint(x: (start.x + end.x) / 2 + random.range(-1, 1) * amplitude, y: (start.y + end.y) / 2))
            x += spacing
        }
        return path
    }

    static func line(_ curve: CanvasGeometry.Curve, seed: UInt64, amplitude: CGFloat) -> Path {
        outline(CanvasGeometry.path(curve), seed: seed, amplitude: amplitude)
    }

    static func arrowHead(_ curve: CanvasGeometry.Curve, size: CGFloat, seed: UInt64, amplitude: CGFloat) -> Path {
        let dx = curve.end.x - curve.control2.x
        let dy = curve.end.y - curve.control2.y
        let length = max(hypot(dx, dy), 0.001)
        let ux = dx / length
        let uy = dy / length
        let base = CGPoint(x: curve.end.x - ux * size, y: curve.end.y - uy * size)
        var shape = Path()
        shape.move(to: CGPoint(x: base.x - uy * size * 0.6, y: base.y + ux * size * 0.6))
        shape.addLine(to: curve.end)
        shape.addLine(to: CGPoint(x: base.x + uy * size * 0.6, y: base.y - ux * size * 0.6))
        return outline(shape, seed: seed &+ 7, amplitude: amplitude * 0.5)
    }
}
