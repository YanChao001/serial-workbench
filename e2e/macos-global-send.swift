import AppKit
import Carbon
import CoreFoundation
import CoreGraphics
import Foundation

struct ProbeError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

struct ProbeReply: Encodable {
    var ready: Bool? = nil
    var pid: Int32? = nil
    var canPost: Bool? = nil
    var canListen: Bool? = nil
    var secureInput: Bool? = nil
    var ok: Bool? = nil
    var foreground: Bool? = nil
    var foregroundPID: Int32? = nil
    var expectedForegroundPID: Int32? = nil
    var foregroundBundleIdentifier: String? = nil
    var controlPresses: Int? = nil
    var controlReleases: Int? = nil
    var sessionMonitor: Bool? = nil
    var sessionPresses: Int? = nil
    var sessionReleases: Int? = nil
    var sessionPressFlags: UInt64? = nil
    var error: String? = nil
}

private final class ControlEvents {
    var presses = 0
    var releases = 0
    var sessionPresses = 0
    var sessionReleases = 0
    var sessionPressFlags: UInt64?
}

private let controlEventTag: Int64 = 0x53574246

@MainActor
final class GlobalSendPeer: NSObject, NSApplicationDelegate {
    private let foregroundBundle = "com.apple.calculator"
    private var foregroundTarget: NSRunningApplication?
    private let controlEvents = ControlEvents()
    private var controlHandler: EventHandlerRef?
    private var sessionTap: CFMachPort?
    private var sessionSource: CFRunLoopSource?
    private var occupied: EventHotKeyRef?
    private var reclaimed: EventHotKeyRef?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try observeControlShortcut()
            occupied = try reserve(key: UInt32(kVK_F10), id: 1)
            reply(ProbeReply(ready: true, pid: ProcessInfo.processInfo.processIdentifier,
                             canPost: CGPreflightPostEventAccess(), canListen: CGPreflightListenEventAccess(),
                             secureInput: IsSecureEventInputEnabled()))
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
        DispatchQueue.global().async {
            while let command = readLine() {
                DispatchQueue.main.sync { self.execute(command) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        _ = foregroundTarget?.terminate()
        if let reclaimed { _ = UnregisterEventHotKey(reclaimed) }
        if let occupied { _ = UnregisterEventHotKey(occupied) }
        if let controlHandler { _ = RemoveEventHandler(controlHandler) }
        if let sessionSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), sessionSource, .commonModes) }
        if let sessionTap { CFMachPortInvalidate(sessionTap) }
    }

    private var foreground: Bool {
        guard let foregroundTarget else { return false }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier == foregroundTarget.processIdentifier
    }

    private func register(key: UInt32, id: UInt32, handle: inout EventHotKeyRef?) -> OSStatus {
        var hotkeyId = EventHotKeyID()
        hotkeyId.signature = 0x53574245
        hotkeyId.id = id
        return RegisterEventHotKey(
            key, UInt32(cmdKey | shiftKey), hotkeyId, GetApplicationEventTarget(),
            OptionBits(1), &handle // kEventHotKeyExclusive
        )
    }

    private func reserve(key: UInt32, id: UInt32) throws -> EventHotKeyRef {
        var handle: EventHotKeyRef?
        let status = register(key: key, id: id, handle: &handle)
        guard status == noErr, let handle else {
            throw ProbeError("Cannot acquire a native test shortcut (OSStatus \(status)).")
        }
        return handle
    }

    private func observeControlShortcut() throws {
        let types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let context = Unmanaged.passUnretained(controlEvents).toOpaque()
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            guard let event, let context else { return OSStatus(eventNotHandledErr) }
            var hotKey = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject),
                                           EventParamType(typeEventHotKeyID), nil,
                                           MemoryLayout<EventHotKeyID>.size, nil, &hotKey)
            guard status == noErr, hotKey.signature == 0x53574245, hotKey.id == 1 else {
                return OSStatus(eventNotHandledErr)
            }
            let events = Unmanaged<ControlEvents>.fromOpaque(context).takeUnretainedValue()
            if GetEventKind(event) == UInt32(kEventHotKeyPressed) { events.presses += 1 }
            else { events.releases += 1 }
            return noErr
        }, types.count, types, context, &controlHandler)
        guard status == noErr else {
            throw ProbeError("Cannot observe the native control shortcut (OSStatus \(status)).")
        }
    }

    private func observeSessionEvents() {
        guard sessionTap == nil, CGPreflightListenEventAccess() else { return }
        let context = Unmanaged.passUnretained(controlEvents).toOpaque()
        let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue) |
            (CGEventMask(1) << CGEventType.keyUp.rawValue)
        // 只记录探针在隔离会话中标记的对照事件，不保存其他输入。
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap,
                                         options: .listenOnly, eventsOfInterest: mask,
                                         callback: { _, type, event, context in
            if let context, event.getIntegerValueField(.eventSourceUserData) == controlEventTag,
               event.getIntegerValueField(.keyboardEventKeycode) == Int64(kVK_F10) {
                let events = Unmanaged<ControlEvents>.fromOpaque(context).takeUnretainedValue()
                if type == .keyDown {
                    events.sessionPresses += 1
                    events.sessionPressFlags = event.flags.rawValue
                }
                if type == .keyUp { events.sessionReleases += 1 }
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: context), let source = CFMachPortCreateRunLoopSource(nil, tap, 0) else { return }
        sessionTap = tap
        sessionSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func execute(_ command: String) {
        do {
            switch command {
            case "focus":
                try launchForegroundTarget()
                return
            case "foreground":
                break
            case "observe-session":
                observeSessionEvents()
            case "press-control":
                try press(CGKeyCode(kVK_F10), repeating: false)
            case "press":
                try press(CGKeyCode(kVK_F9), repeating: true)
            case "press-workbench":
                guard let value = ProcessInfo.processInfo.environment["STARTER_E2E_APP_PID"],
                      let pid = Int32(value), pid > 0 else {
                    throw ProbeError("Missing the owned workbench process ID.")
                }
                try press(CGKeyCode(kVK_F9), repeating: false, expectedPID: pid)
                let result = foregroundReply(expectedPID: pid)
                guard result.foreground == true else {
                    throw ProbeError("The owned workbench lost foreground.")
                }
                reply(result)
                return
            case "retained":
                var handle: EventHotKeyRef?
                let status = register(key: UInt32(kVK_F9), id: 2, handle: &handle)
                if let handle { _ = UnregisterEventHotKey(handle) }
                let eventHotKeyExistsErr: OSStatus = -9878
                guard status == eventHotKeyExistsErr else {
                    throw ProbeError("The original shortcut was not exclusively retained (OSStatus \(status)).")
                }
            case "reclaim":
                reclaimed = try reserve(key: UInt32(kVK_F9), id: 2)
            default:
                throw ProbeError("Unknown global send probe command.")
            }
            reply(foregroundReply())
        } catch {
            reply(ProbeReply(ok: false, error: String(describing: error)))
        }
    }

    private func launchForegroundTarget() throws {
        let workspace = NSWorkspace.shared
        guard foregroundTarget == nil,
              let url = workspace.urlForApplication(withBundleIdentifier: foregroundBundle) else {
            throw ProbeError("Cannot locate a new Calculator instance for the native test.")
        }
        let existing = Set(NSRunningApplication.runningApplications(withBundleIdentifier: foregroundBundle)
            .map(\.processIdentifier))
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.createsNewApplicationInstance = true
        configuration.addsToRecentItems = false
        configuration.promptsUserIfNeeded = false
        workspace.openApplication(at: url, configuration: configuration) { application, error in
            DispatchQueue.main.async {
                guard let application, application.bundleIdentifier == self.foregroundBundle,
                      !existing.contains(application.processIdentifier) else {
                    self.reply(ProbeReply(ok: false, error: error?.localizedDescription ??
                        "Launch Services did not create an independent Calculator process."))
                    return
                }
                self.foregroundTarget = application
                self.reply(self.foregroundReply())
            }
        }
    }

    private func foregroundReply(expectedPID: Int32? = nil) -> ProbeReply {
        let front = NSWorkspace.shared.frontmostApplication
        let expected = expectedPID ?? foregroundTarget?.processIdentifier
        return ProbeReply(ok: true, foreground: expected != nil && front?.processIdentifier == expected,
                          foregroundPID: front?.processIdentifier, expectedForegroundPID: expected,
                          foregroundBundleIdentifier: front?.bundleIdentifier,
                          controlPresses: controlEvents.presses, controlReleases: controlEvents.releases,
                          sessionMonitor: sessionTap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false,
                          sessionPresses: controlEvents.sessionPresses,
                          sessionReleases: controlEvents.sessionReleases,
                          sessionPressFlags: controlEvents.sessionPressFlags)
    }

    private func press(_ key: CGKeyCode, repeating: Bool, expectedPID: Int32? = nil) throws {
        guard CGPreflightPostEventAccess() else {
            throw ProbeError("The macOS session has not authorized posting keyboard events.")
        }
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ProbeError("Cannot create the native keyboard event source.")
        }
        func targetIsForeground() -> Bool {
            if let expectedPID {
                return NSWorkspace.shared.frontmostApplication?.processIdentifier == expectedPID
            }
            return foreground
        }
        func event(_ key: CGKeyCode, down: Bool, flags: CGEventFlags, modifier: Bool = false) throws -> CGEvent {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else {
                throw ProbeError("Cannot create the native keyboard event.")
            }
            if modifier { event.type = .flagsChanged }
            event.flags = flags
            return event
        }
        let command = CGKeyCode(kVK_Command)
        let shift = CGKeyCode(kVK_Shift)
        let flags: CGEventFlags = [.maskCommand, .maskShift]
        // F9/F10 事件需要平台功能键标志才能进入 Carbon 热键回调。
        let keyFlags = flags.union(.maskSecondaryFn)
        let commandDown = try event(command, down: true, flags: .maskCommand, modifier: true)
        let shiftDown = try event(shift, down: true, flags: flags, modifier: true)
        let down = try event(key, down: true, flags: keyFlags)
        let up = try event(key, down: false, flags: keyFlags)
        let shiftUp = try event(shift, down: false, flags: .maskCommand, modifier: true)
        let commandUp = try event(command, down: false, flags: [], modifier: true)
        if key == CGKeyCode(kVK_F10) {
            down.setIntegerValueField(.eventSourceUserData, value: controlEventTag)
            up.setIntegerValueField(.eventSourceUserData, value: controlEventTag)
        }
        guard targetIsForeground() else { throw ProbeError("The expected test application is not in the foreground.") }
        let tap = CGEventTapLocation.cgSessionEventTap
        commandDown.post(tap: tap)
        shiftDown.post(tap: tap)
        down.post(tap: tap)
        defer {
            up.post(tap: tap)
            shiftUp.post(tap: tap)
            commandUp.post(tap: tap)
        }
        guard repeating else { return }
        for _ in 0..<4 {
            Thread.sleep(forTimeInterval: 0.2)
            guard targetIsForeground() else { throw ProbeError("The expected test application lost foreground.") }
            down.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
            down.post(tap: tap)
        }
    }

    private func reply(_ fields: ProbeReply) {
        do {
            let data = try JSONEncoder().encode(fields)
            FileHandle.standardOutput.write(data + Data([10]))
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}

@main
struct GlobalSendProbe {
    @MainActor
    static func main() {
        let env = ProcessInfo.processInfo.environment
        guard env["GITHUB_ACTIONS"] == "true", env["RUNNER_OS"] == "macOS" else {
            FileHandle.standardError.write(Data("The native probe requires the independent macOS CI desktop.\n".utf8))
            exit(1)
        }
        let application = NSApplication.shared
        let peer = GlobalSendPeer()
        guard application.setActivationPolicy(.accessory) else {
            FileHandle.standardError.write(Data("Cannot apply the requested AppKit activation policy.\n".utf8))
            exit(1)
        }
        application.delegate = peer
        withExtendedLifetime(peer) { application.run() }
    }
}
