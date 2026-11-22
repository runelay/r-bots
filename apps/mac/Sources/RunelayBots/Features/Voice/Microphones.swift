import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation
import Observation

struct Microphone: Identifiable, Hashable, Sendable {
    let id: AudioDeviceID
    let uid: String
    let name: String
}

enum MicrophonePreferenceKeys {
    static let uid = "voiceInputDeviceUID"
    static let name = "voiceInputDeviceName"
}

struct MicrophoneSwitch {
    let applied: Bool
    let log: String
}

enum MicrophoneSelection: Equatable {
    case system
    case device(Microphone)
    case missing(String)
}

enum Microphones {
    static let quietPeak: Float = 0.002

    static func all() -> [Microphone] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.compactMap { id in
            guard hasInput(id), let uid = string(id, kAudioDevicePropertyDeviceUID), let name = string(id, kAudioObjectPropertyName) else { return nil }
            guard !uid.hasPrefix("CADefaultDeviceAggregate"), !name.hasPrefix("CADefaultDeviceAggregate") else { return nil }
            return Microphone(id: id, uid: uid, name: name)
        }
    }

    static func systemDefault() -> Microphone? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr, id != 0 else { return nil }
        guard let uid = string(id, kAudioDevicePropertyDeviceUID), let name = string(id, kAudioObjectPropertyName) else { return nil }
        return Microphone(id: id, uid: uid, name: name)
    }

    static var savedUID: String? {
        UserDefaults.standard.string(forKey: MicrophonePreferenceKeys.uid)
    }

    static func save(_ microphone: Microphone?) {
        if let microphone {
            UserDefaults.standard.set(microphone.uid, forKey: MicrophonePreferenceKeys.uid)
            UserDefaults.standard.set(microphone.name, forKey: MicrophonePreferenceKeys.name)
        } else {
            UserDefaults.standard.removeObject(forKey: MicrophonePreferenceKeys.uid)
            UserDefaults.standard.removeObject(forKey: MicrophonePreferenceKeys.name)
        }
    }

    static func selection() -> MicrophoneSelection {
        guard let uid = savedUID else { return .system }
        if let found = all().first(where: { $0.uid == uid }) {
            return .device(found)
        }
        return .missing(UserDefaults.standard.string(forKey: MicrophonePreferenceKeys.name) ?? tr("microfone escolhido"))
    }

    static func takeMissing() -> String? {
        guard case .missing(let name) = selection() else { return nil }
        save(nil)
        return name
    }

    static func activeName() -> String {
        switch selection() {
        case .device(let microphone): microphone.name
        default: systemDefault()?.name ?? tr("microfone padrão")
        }
    }

    static func lostNotice(_ name: String) -> String {
        tr("O %@ não está mais conectado. Voltei para o padrão do sistema.", name)
    }

    static func chosen() -> Microphone? {
        guard case .device(let microphone) = selection(), microphone.uid != systemDefault()?.uid else { return nil }
        return microphone
    }

    static func apply(to input: AVAudioInputNode, voiceProcessing: Bool) -> MicrophoneSwitch? {
        guard let microphone = chosen() else { return nil }
        return use(microphone.id, on: input, voiceProcessing: voiceProcessing, name: microphone.name)
    }

    @discardableResult
    static func use(_ device: AudioDeviceID, on input: AVAudioInputNode, voiceProcessing: Bool, name: String) -> MicrophoneSwitch {
        var parts: [String] = ["microfone \(name) (\(device))"]
        var current: AudioDeviceID?
        if voiceProcessing {
            if let unit = input.audioUnit {
                var value = device
                let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 1, &value, UInt32(MemoryLayout<AudioDeviceID>.size))
                current = currentDevice(of: unit, element: 1)
                parts.append("vpio.entrada=\(status)")
            }
        } else {
            do {
                try input.auAudioUnit.setDeviceID(device)
                parts.append("auAudioUnit=ok")
            } catch {
                parts.append("auAudioUnit=\((error as NSError).code)")
                if let unit = input.audioUnit {
                    var value = device
                    parts.append("auhal=\(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &value, UInt32(MemoryLayout<AudioDeviceID>.size)))")
                }
            }
            current = input.audioUnit.flatMap { currentDevice(of: $0, element: 0) }
        }
        parts.append("atual=\(current.map(String.init) ?? "?") vp=\(voiceProcessing)")
        return MicrophoneSwitch(applied: current == device, log: parts.joined(separator: " "))
    }

    static func currentDevice(of unit: AudioUnit, element: AudioUnitElement) -> AudioDeviceID? {
        var value = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, element, &value, &size) == noErr else { return nil }
        return value
    }

    static func peak(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var peak: Float = 0
        for index in 0..<Int(buffer.frameLength) {
            peak = max(peak, abs(channel[index]))
        }
        return peak
    }

    private static func hasInput(_ id: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return false }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, raw) == noErr else { return false }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) } > 0
    }

    private static func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }
}

@MainActor
@Observable
final class MicrophoneCatalog {
    static let shared = MicrophoneCatalog()

    private(set) var devices: [Microphone] = []
    private(set) var systemName = ""
    private(set) var selectedUID: String?
    private(set) var lostName: String?

    @ObservationIgnored private var listening = false

    private init() {
        reload()
    }

    func reload() {
        devices = Microphones.all()
        systemName = Microphones.systemDefault()?.name ?? ""
        if case .missing(let name) = Microphones.selection() {
            lostName = name
            selectedUID = nil
        } else {
            selectedUID = Microphones.savedUID
        }
        listen()
    }

    func select(_ microphone: Microphone?) {
        adopt(microphone)
        PreferencesSync.push(.object(["microphone": microphone.map { .string($0.name) } ?? .null]))
    }

    func adopt(_ microphone: Microphone?) {
        Microphones.save(microphone)
        selectedUID = microphone?.uid
        lostName = nil
    }

    func dismissLost() {
        lostName = nil
    }

    private func listen() {
        guard !listening else { return }
        listening = true
        for selector in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice] {
            var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, DispatchQueue.main) { _, _ in
                MainActor.assumeIsolated {
                    MicrophoneCatalog.shared.reload()
                }
            }
        }
    }
}

final class MicrophoneMeter: @unchecked Sendable {
    private let lock = NSLock()
    private var engine: AVAudioEngine?
    private var latest: Float = 0

    var level: Float {
        lock.withLock {
            let value = latest
            latest *= 0.6
            return value
        }
    }

    func watch(_ microphone: Microphone?) {
        stop()
        let engine = AVAudioEngine()
        let input = engine.inputNode
        if let microphone {
            Microphones.use(microphone.id, on: input, voiceProcessing: false, name: microphone.name)
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return }
        input.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
            let peak = Microphones.peak(of: buffer)
            self?.lock.withLock {
                self?.latest = max(self?.latest ?? 0, peak)
            }
        }
        engine.prepare()
        do {
            try engine.start()
            lock.withLock { self.engine = engine }
        } catch {
            input.removeTap(onBus: 0)
        }
    }

    func stop() {
        let current = lock.withLock { () -> AVAudioEngine? in
            let value = engine
            engine = nil
            latest = 0
            return value
        }
        guard let current else { return }
        current.inputNode.removeTap(onBus: 0)
        current.stop()
    }

    static func display(_ peak: Float) -> Double {
        let decibels = 20 * log10(max(Double(peak), 0.000_01))
        return min(max((decibels + 70) / 64, 0), 1)
    }
}
