import AVFoundation
import Foundation

let args = CommandLine.arguments
let scenario = args.count > 1 ? args[1] : "turno"
let firstWav = args.count > 2 ? args[2] : "/tmp/rbv/longa.wav"
let secondWav = args.count > 3 ? args[3] : ""
let botID = args.count > 4 ? args[4] : "boss"
let server = args.count > 5 ? args[5] : "https://vps.taile89599.ts.net:10447"
let t0 = Date()

func say(_ line: String) {
    print(String(format: "%6.2fs ", Date().timeIntervalSince(t0)) + line)
    fflush(stdout)
}

func call(_ path: String, method: String, body: JSONValue? = nil) async throws -> JSONValue {
    var request = URLRequest(url: URL(string: server + path)!)
    request.httpMethod = method
    if let body {
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let json = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
    if !(200..<300).contains(status) {
        say("HTTP \(status) \(path): \(String(decoding: data, as: UTF8.self).prefix(200))")
    }
    return json
}

final class Shared: @unchecked Sendable {
    let lock = NSLock()
    var ttsBytes = 0
    var commits = 0
    var turns: [String] = []
    var interrupts = 0
    var kinds: [String: String] = [:]
    var audible: [String] = []
    var live: Set<String> = []
    var working = false
    var queue: [AVAudioPCMBuffer] = []
}

let shared = Shared()
let root = "/bots/\(botID)/voice/session"
let session = try await call(root, method: "POST", body: .object([:]))
guard let callID = session["callId"]?.stringValue,
      let sttURL = session["stt"]?["url"]?.stringValue.flatMap(URL.init(string:)),
      let ttsURL = session["tts"]?["url"]?.stringValue.flatMap(URL.init(string:))
else {
    say("sessão sem credenciais")
    exit(1)
}
let sttRate = session["stt"]?["sampleRate"]?.doubleValue ?? 16_000
let ttsRate = session["tts"]?["sampleRate"]?.doubleValue ?? 24_000
say("cenário \(scenario) · chamada \(callID) · vad \(session["stt"]?["vadSilenceSecs"]?.doubleValue ?? 0) s")

let audio = try CallAudio(captureRate: sttRate, playbackRate: ttsRate, usesMicrophone: false)
let scribe = ScribeSocket(url: sttURL, sampleRate: sttRate)
let speech = SpeechSocket(url: ttsURL, speed: 1)
let turns = TurnTaker()
audio.setPlaybackGate(turns.playbackLevel)

@MainActor
func syncTurns() {
    let busy = shared.lock.withLock { shared.working || !shared.live.isEmpty }
    turns.botAudible = audio.isPlaying
    turns.botBusy = busy
}

turns.onLog = { say("turnos: \($0)") }
turns.onBargeIn = {
    shared.lock.withLock { shared.interrupts += 1 }
    audio.stopPlayback()
    speech.cancelAll()
    shared.lock.withLock { shared.live.removeAll() }
    say("INTERROMPEU a voz do bot")
    Task { _ = try? await call("\(root)/\(callID)/interrupt", method: "POST", body: .object([:])) }
}
turns.onTurn = { text, interrupted in
    shared.lock.withLock { shared.turns.append(text) }
    Task {
        let result = try? await call("\(root)/\(callID)/utterance", method: "POST", body: .object(["text": .string(text), "interrupted": .bool(interrupted)]))
        say("utterance → \(result?["action"]?.stringValue ?? "erro") continuação=\(result?["continuation"]?.boolValue.map(String.init) ?? "?")")
    }
}

audio.onEvent = { say("áudio: \($0)") }
final class GateLog: @unchecked Sendable {
    var open = false
    var since = Date()
    var peak: Float = -100
}
let gateLog = GateLog()
audio.onVoiceFrame = { frame in
    if frame.open != gateLog.open {
        if frame.open {
            gateLog.since = Date()
            gateLog.peak = frame.snr
        } else {
            say(String(format: "portão abriu por %.2f s (pico %.0f dB acima do fundo)", Date().timeIntervalSince(gateLog.since), gateLog.peak))
        }
        gateLog.open = frame.open
    } else if frame.open {
        gateLog.peak = max(gateLog.peak, frame.snr)
    }
    Task { @MainActor in turns.voiceFrame(frame) }
}
audio.onChunk = { scribe.send(audio: $0) }
audio.onInputLevel = { level in
    Task { @MainActor in
        syncTurns()
        turns.level(level)
    }
}
scribe.onStarted = { say("scribe: sessão aberta") }
scribe.onPartial = { text in
    Task { @MainActor in
        syncTurns()
        if turns.partial(text) {
            say("parcial: \(text)")
        }
    }
}
scribe.onClose = { say("scribe fechou: \($0)") }
scribe.onCommitted = { text in
    guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    shared.lock.withLock { shared.commits += 1 }
    say("commit do Scribe: \(text)")
    Task { @MainActor in
        syncTurns()
        turns.committed(text)
    }
}
speech.onAudio = { _, data in
    shared.lock.withLock { shared.ttsBytes += data.count }
    audio.play(pcm16: data)
}
speech.onFirstAudio = { id in
    let kind = shared.lock.withLock { () -> String in
        let kind = shared.kinds[id] ?? "?"
        shared.audible.append(kind)
        return kind
    }
    say("tts: primeiro áudio (\(kind))")
}
speech.onClose = { say("tts fechou") }

try audio.start()
scribe.open()
speech.open()

let events = Task {
    var request = URLRequest(url: URL(string: server + "\(root)/\(callID)/stream")!)
    request.timeoutInterval = 180
    let (bytes, _) = try await URLSession.shared.bytes(for: request)
    for try await line in bytes.lines {
        guard let json = JSONValue.parse(line) else { continue }
        let type = json["type"]?.stringValue ?? ""
        let id = json["id"]?.stringValue ?? ""
        switch type {
        case "speech.started":
            let kind = json["kind"]?.stringValue ?? ""
            shared.lock.withLock {
                shared.kinds[id] = kind
                shared.live.insert(id)
            }
            say("bot começou a falar (\(kind))")
            speech.begin(id)
        case "speech.delta":
            let text = json["text"]?.stringValue ?? ""
            speech.append(id, text: text)
        case "speech.done":
            let text = json["text"]?.stringValue ?? ""
            shared.lock.withLock { _ = shared.live.remove(id) }
            say("bot disse: \(text)")
            Task { @MainActor in turns.botSaid(id: id, text: text) }
            speech.finish(id)
        case "speech.cancelled":
            shared.lock.withLock { _ = shared.live.remove(id) }
            say("fala do bot cancelada")
            speech.cancel(id)
        case "bot.state":
            let state = json["state"]?.stringValue ?? ""
            shared.lock.withLock { shared.working = state == "working" }
            say("bot \(state)")
        case "heartbeat", "bot.tool":
            break
        default:
            say("evento \(type)")
        }
    }
}

let feeder = Task.detached {
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!
    let frames: AVAudioFrameCount = 1024
    let step = Double(frames) / 48_000
    let noise = Float(pow(10.0, -62.0 / 20.0) * sqrt(3.0))
    var next = Date()
    while !Task.isCancelled {
        let queued = shared.lock.withLock { shared.queue.isEmpty ? nil : shared.queue.removeFirst() }
        let buffer: AVAudioPCMBuffer
        if let queued {
            buffer = queued
        } else {
            buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
            buffer.frameLength = frames
            memset(buffer.floatChannelData![0], 0, Int(frames) * 4)
        }
        let samples = buffer.floatChannelData![0]
        for index in 0..<Int(buffer.frameLength) {
            samples[index] += Float.random(in: -noise...noise)
        }
        audio.ingest(buffer)
        next = next.addingTimeInterval(step)
        let wait = next.timeIntervalSinceNow
        if wait > 0 {
            try? await Task.sleep(for: .seconds(wait))
        }
    }
}

func enqueue(_ path: String) throws -> Double {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path), commonFormat: .pcmFormatFloat32, interleaved: false)
    let source = file.processingFormat
    let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!
    guard let whole = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(file.length)) else { return 0 }
    try file.read(into: whole)
    let converter = AVAudioConverter(from: source, to: target)!
    let capacity = AVAudioFrameCount(Double(whole.frameLength) * 48_000 / source.sampleRate) + 1024
    let resampled = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity)!
    var consumed = false
    _ = converter.convert(to: resampled, error: nil) { _, status in
        if consumed {
            status.pointee = .endOfStream
            return nil
        }
        consumed = true
        status.pointee = .haveData
        return whole
    }
    var buffers: [AVAudioPCMBuffer] = []
    var offset = 0
    let total = Int(resampled.frameLength)
    while offset < total {
        let count = min(1024, total - offset)
        let chunk = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 1024)!
        chunk.frameLength = AVAudioFrameCount(count)
        memcpy(chunk.floatChannelData![0], resampled.floatChannelData![0].advanced(by: offset), count * 4)
        buffers.append(chunk)
        offset += count
    }
    shared.lock.withLock { shared.queue.append(contentsOf: buffers) }
    let seconds = Double(total) / 48_000
    say("tocando \(URL(fileURLWithPath: path).lastPathComponent) (\(String(format: "%.1f", seconds)) s)")
    return seconds
}

func waitFor(_ seconds: Double, _ condition: () -> Bool) async -> Bool {
    let limit = Date().addingTimeInterval(seconds)
    while Date() < limit {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(50))
    }
    return false
}

_ = await waitFor(8) { scribe.hasStarted }
_ = await waitFor(3) { Date().timeIntervalSince(t0) > 2.6 }
say(String(format: "fundo calibrado em %.1f dBFS", audio.noiseFloor))
let length = try enqueue(firstWav)
try await Task.sleep(for: .seconds(length))

switch scenario {
case "backchannel":
    let heard = await waitFor(30) { audio.isPlaying }
    say(heard ? "bot está falando, mandando o \"tá\"" : "bot não falou a tempo")
    try await Task.sleep(for: .milliseconds(300))
    _ = try enqueue(secondWav)
    _ = await waitFor(60) { shared.lock.withLock { shared.audible.contains("result") } && !audio.isPlaying }
case "interrupcao":
    let heard = await waitFor(90) { shared.lock.withLock { shared.audible.contains("result") } && audio.isPlaying }
    say(heard ? "bot está falando o resultado, interrompendo" : "bot não chegou no resultado, interrompendo o que estiver tocando")
    try await Task.sleep(for: .milliseconds(400))
    _ = try enqueue(secondWav)
    _ = await waitFor(60) { shared.lock.withLock { shared.turns.count >= 2 && shared.audible.count >= 3 } }
    try await Task.sleep(for: .seconds(4))
default:
    _ = await waitFor(20) { shared.lock.withLock { !shared.turns.isEmpty && shared.ttsBytes > 0 } }
    try await Task.sleep(for: .seconds(4))
}

let result = shared.lock.withLock { (shared.commits, shared.turns, shared.interrupts, shared.audible) }
say("RESULTADO commits_do_scribe=\(result.0) turnos=\(result.1.count) interrupções=\(result.2) falas_ouvidas=\(result.3.joined(separator: ","))")
for (index, text) in result.1.enumerated() {
    say("  turno \(index + 1): \(text)")
}
feeder.cancel()
events.cancel()
scribe.close()
speech.close()
audio.stop()
_ = try? await call("\(root)/\(callID)", method: "DELETE")
let passed: Bool
switch scenario {
case "backchannel": passed = result.1.count == 1 && result.2 == 0
case "interrupcao": passed = result.1.count == 2 && result.2 == 1
case "ambiente":
    let leaked = ["jogo", "gol", "tecnico", "almocar", "restaurante", "esquina"].filter { word in result.1.contains { TurnTaker.words($0).contains(word) } }
    if !leaked.isEmpty { say("vazou fala distante: \(leaked.joined(separator: ", "))") }
    passed = result.1.count == 1 && leaked.isEmpty
default: passed = result.1.count == 1
}
say(passed ? "PASSOU" : "FALHOU")
exit(passed ? 0 : 1)
