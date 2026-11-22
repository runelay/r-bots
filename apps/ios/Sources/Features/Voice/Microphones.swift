import AVFoundation
import Foundation

struct Microphone: Identifiable, Hashable, Sendable {
    let id: UInt32
    let uid: String
    let name: String
}

struct MicrophoneSwitch {
    let applied: Bool
    let log: String
}

enum Microphones {
    static let quietPeak: Float = 0.002

    static func takeMissing() -> String? { nil }

    static func activeName() -> String {
        AVAudioSession.sharedInstance().currentRoute.inputs.first?.portName ?? tr("microfone do iPhone")
    }

    static func lostNotice(_ name: String) -> String {
        tr("O %@ não está mais conectado. Voltei para o microfone do iPhone.", name)
    }

    static func chosen() -> Microphone? { nil }

    static func apply(to input: AVAudioInputNode, voiceProcessing: Bool) -> MicrophoneSwitch? { nil }

    @discardableResult
    static func use(_ device: UInt32, on input: AVAudioInputNode, voiceProcessing: Bool, name: String) -> MicrophoneSwitch {
        MicrophoneSwitch(applied: false, log: "microfone \(name) (rota do sistema)")
    }

    static func peak(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var peak: Float = 0
        for index in 0..<Int(buffer.frameLength) {
            peak = max(peak, abs(channel[index]))
        }
        return peak
    }
}
