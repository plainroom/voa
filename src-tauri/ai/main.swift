// voa-ai: one question to Apple's on-device model. Reads on stdin
//   {"instructions": "...", "schema": <shape>, "input": "..."}
// and prints the answer as JSON in that shape, or {"unavailable": true} when the Mac has no
// model (no Apple Intelligence). It knows no task: the app writes the instructions and the shape,
// and checks the answer. A shape is {"type": "string" | "boolean" | "integer"}, an array
// {"type": "array", "items": shape, "maxItems": n}, or an object {"type": "object", "properties": [shape with
// "name"]}, in the order the model should fill them; any shape may carry "description", and a
// property "optional": true.
// {"translate": ["...", ...], "to": "pt-BR"} asks no model either: macOS's own translation (Translation) prints
// {"from": "en", "texts": [...]}, one per text, or {"from": ..., "why": "same" | "download" | "unsupported" | "unknown"}.
// `voa-ai listen` hears the microphone until stdin closes: a line per change, {"level": 0...1} and {"text": "..."} (all
// said so far), then {"done": "..."} with the final text, or {"why": "microphone" | "unsupported"} when it cannot listen.
import AVFoundation
import Foundation
import FoundationModels
import NaturalLanguage
import Speech
import Translation

struct Shape: Decodable {
  let type: String
  let name: String?
  let description: String?
  let optional: Bool?
  let items: Box?
  let maxItems: Int?
  let properties: [Shape]?
  final class Box: Decodable {
    let shape: Shape
    init(from decoder: Decoder) throws { shape = try Shape(from: decoder) }
  }
}

struct Request: Decodable {
  let instructions: String
  let schema: Shape
  let input: String
}

struct BadShape: Error { let type: String }

/// The shape as the model's schema; an object is named by where it sits (Answer, Answer.trips, ...).
func dynamic(_ s: Shape, _ name: String) throws -> DynamicGenerationSchema {
  switch s.type {
  case "string": return DynamicGenerationSchema(type: String.self)
  case "boolean": return DynamicGenerationSchema(type: Bool.self)
  case "integer": return DynamicGenerationSchema(type: Int.self)
  case "array":
    guard let items = s.items else { throw BadShape(type: "array without items") }
    // A bound the model cannot pass: without one it can repeat items until its context runs out.
    return DynamicGenerationSchema(arrayOf: try dynamic(items.shape, name), maximumElements: s.maxItems)
  case "object":
    let props = try (s.properties ?? []).map { p in
      guard let key = p.name else { throw BadShape(type: "property without name") }
      return DynamicGenerationSchema.Property(name: key, description: p.description, schema: try dynamic(p, "\(name).\(key)"), isOptional: p.optional ?? false)
    }
    return DynamicGenerationSchema(name: name, description: s.description, properties: props)
  default: throw BadShape(type: s.type)
  }
}

/// The shape as JSON written out, then what each field is, for an answer asked as text.
func written(_ s: Shape) -> String {
  switch s.type {
  case "array": return "[\(s.items.map { written($0.shape) } ?? "")]"
  case "object": return "{" + (s.properties ?? []).map { "\"\($0.name ?? "")\": \(written($0))" }.joined(separator: ", ") + "}"
  default: return s.type
  }
}
func fields(_ s: Shape) -> [String] {
  let own = s.name.flatMap { n in s.description.map { "- \(n): \($0)" } }
  return [own].compactMap { $0 } + (s.properties ?? []).flatMap(fields) + (s.items.map { fields($0.shape) } ?? [])
}

/// The model refuses some mail (news about a company, a tax change: "May contain sensitive content") when the
/// answer has a shape, and never when it is text: only a text answer takes the permissive guardrails Apple gives for reading
/// the user's own content. So a refused question is asked again for its answer as JSON text, which the
/// app checks like any answer. Nil when that is no JSON either.
func asText(_ req: Request) async -> String? {
  let shape = "\n\nAnswer with JSON only, no other text, in this shape: \(written(req.schema))\n" + fields(req.schema).joined(separator: "\n")
  let session = LanguageModelSession(model: SystemLanguageModel(guardrails: .permissiveContentTransformations), instructions: req.instructions + shape)
  guard let text = try? await session.respond(to: req.input, options: GenerationOptions(temperature: 0, maximumResponseTokens: 1500)).content,
    (try? JSONSerialization.jsonObject(with: Data(text.utf8))) != nil
  else { return nil }
  return text
}

/// What the same question fails with every time: the app keeps it and does not ask again.
let failed = #"{"failed": true}"#

struct TranslateAsk: Decodable { let translate: [String]; let to: String }

func printJSON(_ value: [String: Any]) {
  print(String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!)
  fflush(stdout)
}

/// The texts in another language, from the one the recognizer reads in them. Only a pair the Mac has downloaded
/// translates: without a window there is no asking to download one, so the app sends the user to System Settings.
func translate(_ ask: TranslateAsk) async {
  let recognizer = NLLanguageRecognizer()
  recognizer.processString(String(ask.translate.joined(separator: "\n").prefix(4000)))
  guard let code = recognizer.dominantLanguage?.rawValue else { return printJSON(["from": NSNull(), "why": "unknown"]) }
  let from = Locale.Language(identifier: code), to = Locale.Language(identifier: ask.to)
  if from.languageCode == to.languageCode { return printJSON(["from": code, "why": "same"]) }
  switch await LanguageAvailability().status(from: from, to: to) {
  case .unsupported: return printJSON(["from": code, "why": "unsupported"])
  case .supported: return printJSON(["from": code, "why": "download"])
  default: break
  }
  do {
    let session = TranslationSession(installedSource: from, target: to)
    let replies = try await session.translations(from: ask.translate.enumerated().map { .init(sourceText: $1, clientIdentifier: String($0)) })
    var texts = ask.translate
    for r in replies { if let i = r.clientIdentifier.flatMap(Int.init) { texts[i] = r.targetText } }
    printJSON(["from": code, "texts": texts])
  } catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
  }
}

/// The microphone through Apple's on-device speech recognizer (SpeechAnalyzer), in the first of the owner's languages it
/// knows. It downloads that language's model the first time. Claude reads the text after, so a misheard word is no harm.
func listen() async {
  guard await AVCaptureDevice.requestAccess(for: .audio) else { return printJSON(["why": "microphone"]) }
  var locale: Locale?
  for id in Locale.preferredLanguages where locale == nil {
    locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: id))
  }
  guard let locale else { return printJSON(["why": "unsupported"]) }
  let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
  do {
    if let download = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await download.downloadAndInstall() }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { return printJSON(["why": "unsupported"]) }
    let (input, feed) = AsyncStream<AnalyzerInput>.makeStream()
    let engine = AVAudioEngine()
    let mic = engine.inputNode.outputFormat(forBus: 0)
    guard let converter = AVAudioConverter(from: mic, to: format) else { return printJSON(["why": "unsupported"]) }
    // The tap runs on one audio thread, one buffer after another: the slice adds up across them.
    nonisolated(unsafe) var heard: (sum: Float, count: Int) = (0, 0)
    engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: mic) { buffer, _ in
      // The bars: how loud each fifteenth of a second is, in decibels from -50 (silence) to -10 (loud speech).
      if let data = buffer.floatChannelData?[0] {
        for i in 0..<Int(buffer.frameLength) {
          heard.sum += data[i] * data[i]
          heard.count += 1
          if heard.count >= Int(mic.sampleRate / 15) {
            let db = 20 * log10(max(1e-7, (heard.sum / Float(heard.count)).squareRoot()))
            printJSON(["level": Double(min(1, max(0, (db + 50) / 40)))])
            heard = (0, 0)
          }
        }
      }
      let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / mic.sampleRate) + 1
      guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
      var given = false
      converter.convert(to: out, error: nil) { _, status in
        if given { status.pointee = .noDataNow; return nil }
        given = true
        status.pointee = .haveData
        return buffer
      }
      feed.yield(AnalyzerInput(buffer: out))
    }
    let reader = Task {
      var final = ""
      for try await r in transcriber.results {
        let text = String(r.text.characters)
        // Segments as one text, a space between them.
        let said = [final, text.trimmingCharacters(in: .whitespaces)].filter { !$0.isEmpty }.joined(separator: " ")
        if r.isFinal { final = said }
        printJSON(["text": said])
      }
      return final
    }
    try await analyzer.start(inputSequence: input)
    try engine.start()
    // Until the app closes stdin (send or Esc).
    await Task.detached { _ = FileHandle.standardInput.readDataToEndOfFile() }.value
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    feed.finish()
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    printJSON(["done": try await reader.value])
  } catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
  }
}

@main struct Main {
  static func main() async {
    if CommandLine.arguments.dropFirst().first == "listen" { return await listen() }
    let stdin = FileHandle.standardInput.readDataToEndOfFile()
    if let ask = try? JSONDecoder().decode(TranslateAsk.self, from: stdin) { return await translate(ask) }
    guard case .available = SystemLanguageModel.default.availability else {
      print(#"{"unavailable": true}"#)
      return
    }
    do {
      let req = try JSONDecoder().decode(Request.self, from: stdin)
      let schema = try GenerationSchema(root: try dynamic(req.schema, "Answer"), dependencies: [])
      let session = LanguageModelSession(instructions: req.instructions)
      do {
        let reply = try await session.respond(to: req.input, schema: schema, options: GenerationOptions(temperature: 0, maximumResponseTokens: 1500))
        print(reply.content.jsonString)
      } catch LanguageModelSession.GenerationError.refusal, LanguageModelSession.GenerationError.guardrailViolation {
        print(await asText(req) ?? failed)
      } catch LanguageModelSession.GenerationError.exceededContextWindowSize, LanguageModelSession.GenerationError.unsupportedLanguageOrLocale {
        print(failed)
      }
    } catch {
      // Anything else (the model busy, its assets loading, a bad request) exits 1: the app asks again later.
      FileHandle.standardError.write(Data("\(error)\n".utf8))
      exit(1)
    }
  }
}
