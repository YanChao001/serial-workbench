import AppKit
import Carbon
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
    var ok: Bool? = nil
    var foreground: Bool? = nil
    var foregroundPID: Int32? = nil
    var peerWindowClickable: Bool? = nil
    var focusClickPosted: Bool? = nil
    var error: String? = nil
}

@MainActor
final class GlobalSendPeer: NSObject, NSApplicationDelegate {
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 360, height: 130),
        styleMask: [.titled],
        backing: .buffered,
        defer: false
    )
    private var occupied: EventHotKeyRef?
    private var reclaimed: EventHotKeyRef?
    private var focusClickPosted = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            window.title = "Serial Workbench global send peer"
            window.center()
            occupied = try reserve(key: UInt32(kVK_F10), id: 1)
            reply(ProbeReply(ready: true, pid: ProcessInfo.processInfo.processIdentifier,
                             canPost: CGPreflightPostEventAccess()))
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
        if let reclaimed { _ = UnregisterEventHotKey(reclaimed) }
        if let occupied { _ = UnregisterEventHotKey(occupied) }
    }

    private var foreground: Bool {
        NSWorkspace.shared.frontmostApplication?.processIdentifier ==
            ProcessInfo.processInfo.processIdentifier
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

    private func execute(_ command: String) {
        do {
            var peerWindowClickable: Bool? = nil
            switch command {
            case "focus":
                window.makeKeyAndOrderFront(nil)
                window.orderFrontRegardless()
                NSApp.activate()
            case "foreground":
                peerWindowClickable = !foreground && visiblePeerClickPoint() != nil
            case "focus-click":
                if !foreground { try postFocusClick() }
            case "press":
                try press()
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
            let foregroundPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
            reply(ProbeReply(ok: true,
                             foreground: foregroundPID == ProcessInfo.processInfo.processIdentifier,
                             foregroundPID: foregroundPID, peerWindowClickable: peerWindowClickable,
                             focusClickPosted: focusClickPosted))
        } catch {
            reply(ProbeReply(ok: false, error: String(describing: error)))
        }
    }

    private func visiblePeerClickPoint() -> CGPoint? {
        // AppKit may decline a background activation request. A click on our own
        // visible window exercises normal desktop activation with input permission.
        guard window.isVisible, window.windowNumber > 0 else { return nil }
        let number = window.windowNumber
        let pid = ProcessInfo.processInfo.processIdentifier
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]],
            let peer = windows.first(where: {
                ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == number &&
                    ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
            }), let peerBounds = bounds(of: peer), !peerBounds.isEmpty else { return nil }
        let point = CGPoint(x: peerBounds.midX, y: peerBounds.midY)
        let front = windows.first { info in
            ((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0 &&
                bounds(of: info)?.contains(point) == true
        }
        return (front?[kCGWindowNumber as String] as? NSNumber)?.intValue == number ? point : nil
    }

    private func postFocusClick() throws {
        guard !focusClickPosted, CGPreflightPostEventAccess(),
              let point = visiblePeerClickPoint() else {
            throw ProbeError("The independent peer window cannot receive the activation click.")
        }
        guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                                 mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                               mouseCursorPosition: point, mouseButton: .left) else {
            throw ProbeError("Cannot create the mouse click to activate the independent peer.")
        }
        focusClickPosted = true
        down.setIntegerValueField(.mouseEventClickState, value: 1)
        up.setIntegerValueField(.mouseEventClickState, value: 1)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    private func bounds(of info: [String: Any]) -> CGRect? {
        guard let value = info[kCGWindowBounds as String] as? [String: Any] else { return nil }
        return CGRect(dictionaryRepresentation: value as CFDictionary)
    }

    private func press() throws {
        guard CGPreflightPostEventAccess() else {
            throw ProbeError("The macOS session has not authorized posting keyboard events.")
        }
        let key = CGKeyCode(kVK_F9)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) else {
            throw ProbeError("Cannot create the native keyboard event.")
        }
        guard foreground else { throw ProbeError("The independent peer is not in the foreground.") }
        down.flags = [.maskCommand, .maskShift]
        up.flags = down.flags
        down.post(tap: .cghidEventTap)
        defer { up.post(tap: .cghidEventTap) }
        for _ in 0..<4 {
            Thread.sleep(forTimeInterval: 0.2)
            guard foreground else { throw ProbeError("The independent peer lost foreground.") }
            down.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
            down.post(tap: .cghidEventTap)
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
        application.setActivationPolicy(.accessory)
        application.delegate = peer
        withExtendedLifetime(peer) { application.run() }
    }
}
