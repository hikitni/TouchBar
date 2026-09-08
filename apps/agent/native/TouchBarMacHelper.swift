import AppKit
import ApplicationServices
import Foundation

struct HelperRequest: Decodable {
    let operation: String
    let bundleId: String
    let keyCode: UInt16?
    let modifiers: [String]?
    let activationTimeoutMs: Int?
    let keepForeground: Bool?
}

struct HelperResponse: Encodable {
    let ok: Bool
    let code: String
    let message: String
    let appInstalled: Bool
    let accessibilityTrusted: Bool
    let activated: Bool
    let eventPosted: Bool
}

func respond(
    ok: Bool,
    code: String,
    message: String,
    appInstalled: Bool = false,
    accessibilityTrusted: Bool = false,
    activated: Bool = false,
    eventPosted: Bool = false
) -> Never {
    let response = HelperResponse(
        ok: ok,
        code: code,
        message: message,
        appInstalled: appInstalled,
        accessibilityTrusted: accessibilityTrusted,
        activated: activated,
        eventPosted: eventPosted
    )
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(response) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
    exit(0)
}

func waitUntil(_ predicate: () -> Bool, timeoutMs: Int) -> Bool {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000.0)
    while Date() < deadline {
        if predicate() { return true }
        RunLoop.current.run(until: Date().addingTimeInterval(0.04))
    }
    return predicate()
}

func openAndActivate(bundleId: String, appURL: URL, timeoutMs: Int) -> NSRunningApplication? {
    var running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
    if running == nil {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.addsToRecentItems = false
        var completedApplication: NSRunningApplication?
        NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { application, _ in
            completedApplication = application
        }
        _ = waitUntil({
            running = completedApplication ?? NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
            return running != nil
        }, timeoutMs: timeoutMs)
    }

    guard let application = running else { return nil }
    _ = application.activate(options: [.activateAllWindows])
    guard waitUntil({ NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId }, timeoutMs: timeoutMs) else {
        return nil
    }
    return application
}

func eventFlags(_ modifiers: [String]) -> CGEventFlags? {
    var flags = CGEventFlags()
    for modifier in modifiers {
        switch modifier {
        case "command": flags.insert(.maskCommand)
        case "option": flags.insert(.maskAlternate)
        case "control": flags.insert(.maskControl)
        case "shift": flags.insert(.maskShift)
        case "fn": flags.insert(.maskSecondaryFn)
        default: return nil
        }
    }
    return flags
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let decoder = JSONDecoder()
guard let request = try? decoder.decode(HelperRequest.self, from: input), !request.bundleId.isEmpty else {
    respond(ok: false, code: "misconfigured", message: "原生助手请求格式无效")
}

let trusted = AXIsProcessTrusted()
guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: request.bundleId) else {
    respond(ok: false, code: "app_missing", message: "目标应用未安装", accessibilityTrusted: trusted)
}

if request.operation == "check" {
    respond(
        ok: true,
        code: "ok",
        message: "能力检查完成",
        appInstalled: true,
        accessibilityTrusted: trusted
    )
}

guard request.operation == "launch" || request.operation == "shortcut" else {
    respond(
        ok: false,
        code: "misconfigured",
        message: "原生助手操作无效",
        appInstalled: true,
        accessibilityTrusted: trusted
    )
}

if request.operation == "shortcut" {
    guard request.keyCode != nil else {
        respond(
            ok: false,
            code: "misconfigured",
            message: "快捷键配置无效",
            appInstalled: true,
            accessibilityTrusted: trusted
        )
    }

    guard trusted else {
        respond(
            ok: false,
            code: "permission_required",
            message: "需要授予辅助功能权限",
            appInstalled: true,
            accessibilityTrusted: false
        )
    }
}

let timeoutMs = min(max(request.activationTimeoutMs ?? 2_000, 250), 10_000)
let previousApplication = NSWorkspace.shared.frontmostApplication
guard openAndActivate(bundleId: request.bundleId, appURL: appURL, timeoutMs: timeoutMs) != nil else {
    respond(
        ok: false,
        code: "activation_failed",
        message: "目标应用未能进入前台",
        appInstalled: true,
        accessibilityTrusted: trusted
    )
}

if request.operation == "launch" {
    respond(
        ok: true,
        code: "ok",
        message: "应用已启动并进入前台",
        appInstalled: true,
        accessibilityTrusted: trusted,
        activated: true
    )
}

guard let keyCode = request.keyCode else {
    respond(ok: false, code: "misconfigured", message: "快捷键配置无效", appInstalled: true, accessibilityTrusted: true, activated: true)
}

guard let flags = eventFlags(request.modifiers ?? []),
      let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
      let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
    respond(
        ok: false,
        code: "misconfigured",
        message: "快捷键配置无效",
        appInstalled: true,
        accessibilityTrusted: true,
        activated: true
    )
}

keyDown.flags = flags
keyUp.flags = flags
keyDown.post(tap: .cghidEventTap)
Thread.sleep(forTimeInterval: 0.04)
keyUp.post(tap: .cghidEventTap)

if request.keepForeground == false,
   let previousApplication,
   previousApplication.bundleIdentifier != request.bundleId {
    _ = previousApplication.activate(options: [.activateAllWindows])
}

respond(
    ok: true,
    code: "ok",
    message: "快捷键已发送",
    appInstalled: true,
    accessibilityTrusted: true,
    activated: true,
    eventPosted: true
)
