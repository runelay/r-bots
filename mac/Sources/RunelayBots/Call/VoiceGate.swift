import Foundation

struct VoiceFrame: Sendable {
    var decibels: Float
    var snr: Float
    var open: Bool
    var voiced: Bool
    var calibrated: Bool
    var seconds: Double
}

struct VoiceGate: Sendable {
    var calibration: Double = 1.5
    var margin: Float = 12
    var belowSpeech: Float = 14
    var attack: Double = 0.12
    var dropout: Double = 0.08
    var hangover: Double = 1.0

    private(set) var floor: Float = -60
    private(set) var speechLevel: Float?
    private(set) var isOpen = false
    private var elapsed: Double = 0
    private var samples: [Float] = []
    private var calibrated = false
    private var aboveFor: Double = 0
    private var belowFor: Double = 0
    private var quietFor: Double = 0

    var threshold: Float {
        let base = floor + margin
        guard let speechLevel else { return base }
        return max(base, speechLevel - belowSpeech)
    }

    mutating func reset() {
        self = VoiceGate(calibration: calibration, margin: margin, belowSpeech: belowSpeech, attack: attack, dropout: dropout, hangover: hangover)
    }

    mutating func feed(_ decibels: Float, seconds: Double) -> VoiceFrame {
        elapsed += seconds
        if !calibrated {
            samples.append(decibels)
            if elapsed >= calibration {
                let sorted = samples.sorted()
                floor = max(sorted[min(sorted.count - 1, sorted.count * 3 / 10)], -80)
                calibrated = true
                samples.removeAll()
            }
            return VoiceFrame(decibels: decibels, snr: decibels - floor, open: false, voiced: false, calibrated: false, seconds: seconds)
        }
        let snr = decibels - floor
        if snr < 3 {
            floor += (decibels - floor) * 0.05
        } else if !isOpen {
            floor += min(decibels - floor, 20) * 0.002
        }
        floor = max(floor, -80)
        if decibels >= threshold {
            aboveFor += seconds
            belowFor = 0
            quietFor = 0
        } else {
            belowFor += seconds
            quietFor += seconds
            if belowFor > dropout {
                aboveFor = 0
            }
        }
        if !isOpen, aboveFor >= attack {
            isOpen = true
        } else if isOpen, quietFor >= hangover {
            isOpen = false
            aboveFor = 0
        }
        if isOpen, snr >= margin + 8, decibels >= threshold {
            speechLevel = speechLevel.map { $0 + (decibels - $0) * 0.04 } ?? decibels
        }
        return VoiceFrame(decibels: decibels, snr: snr, open: isOpen, voiced: isOpen && decibels >= threshold, calibrated: true, seconds: seconds)
    }
}
