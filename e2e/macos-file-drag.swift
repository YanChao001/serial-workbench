// SPDX-License-Identifier: Apache-2.0
import AppKit
import CoreGraphics

private final class FileSource: NSView, NSDraggingSource {
    var files: [URL] = []

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        let origin = convert(event.locationInWindow, from: nil)
        let items = files.enumerated().map { index, file in
            let item = NSDraggingItem(pasteboardWriter: file as NSURL)
            let frame = CGRect(x: origin.x - 16 + CGFloat(index * 8),
                               y: origin.y - 16 + CGFloat(index * 8),
                               width: 32, height: 32)
            item.setDraggingFrame(frame, contents: NSWorkspace.shared.icon(forFile: file.path))
            return item
        }
        let session = beginDraggingSession(with: items, event: event, source: self)
        session.animatesToStartingPositionsOnCancelOrFail = false
    }

    func draggingSession(_ session: NSDraggingSession,
                         sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .copy
    }

    func draggingSession(_ session: NSDraggingSession, willBeginAt screenPoint: NSPoint) {
        FileHandle.standardOutput.write(Data("file-drag-started\n".utf8))
    }

    func draggingSession(_ session: NSDraggingSession,
                         endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        if operation.contains(.copy) {
            FileHandle.standardOutput.write(Data("file-data-accepted\n".utf8))
        }
        NSApp.terminate(nil)
    }
}

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

private func dragPointer(from start: CGPoint, to destination: CGPoint) {
    guard let source = CGEventSource(stateID: .combinedSessionState) else {
        fail("Could not create the macOS pointer source.")
    }
    func event(_ type: CGEventType, at point: CGPoint) -> CGEvent {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                                  mouseCursorPosition: point, mouseButton: .left) else {
            fail("Could not construct the macOS pointer event.")
        }
        return event
    }
    let move = event(.mouseMoved, at: start)
    let down = event(.leftMouseDown, at: start)
    let begin = event(.leftMouseDragged, at: CGPoint(x: start.x + 32, y: start.y))
    let arrive = event(.leftMouseDragged, at: destination)
    let up = event(.leftMouseUp, at: destination)
    let session = CGEventTapLocation.cgSessionEventTap
    move.post(tap: session)
    Thread.sleep(forTimeInterval: 0.12)
    down.post(tap: session)
    defer { up.post(tap: session) }
    Thread.sleep(forTimeInterval: 0.18)
    begin.post(tap: session)
    Thread.sleep(forTimeInterval: 0.15)
    arrive.post(tap: session)
    Thread.sleep(forTimeInterval: 0.45)
}

@main
struct MacFileDrag {
    @MainActor
    static func main() {
        let args = CommandLine.arguments
        guard ProcessInfo.processInfo.environment["STARTER_E2E_PHASE"] == "fresh",
              args.count >= 4, let x = Double(args[1]), let y = Double(args[2]),
              x.isFinite, y.isFinite else {
            fail("The file drag requires the isolated desktop E2E and fixture paths.")
        }
        guard CGPreflightPostEventAccess() else {
            fail("The macOS test session has not authorized posting pointer events.")
        }
        guard let foreground = NSWorkspace.shared.frontmostApplication,
              let executable = foreground.executableURL?.lastPathComponent,
              executable.range(of: "serial[- ]workbench", options: [.regularExpression, .caseInsensitive]) != nil,
              let screen = NSScreen.screens.first else {
            fail("Serial Workbench is not the foreground window.")
        }
        let files = args.dropFirst(3).map { URL(fileURLWithPath: $0) }
        guard files.allSatisfy({ FileManager.default.fileExists(atPath: $0.path) }) else {
            fail("A file drag fixture is missing.")
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let visible = screen.visibleFrame
        let frame = CGRect(x: visible.minX + 20, y: visible.maxY - 106, width: 180, height: 64)
        let destination = CGPoint(x: x, y: y)
        guard !frame.insetBy(dx: -8, dy: -28).contains(
            CGPoint(x: x, y: screen.frame.maxY - y)
        ) else {
            fail("The source window overlaps the drop target.")
        }
        let window = NSWindow(contentRect: frame, styleMask: [.titled],
                              backing: .buffered, defer: false)
        window.title = "Test file drag"
        window.level = .floating
        let view = FileSource()
        view.files = files
        window.contentView = view
        DispatchQueue.main.async {
            app.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            let localStart = view.convert(CGPoint(x: 64, y: 32), to: nil)
            let screenStart = window.convertPoint(toScreen: localStart)
            let start = CGPoint(x: screenStart.x, y: screen.frame.maxY - screenStart.y)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                guard window.isKeyWindow, app.isActive else { fail("The macOS file source did not become active.") }
                DispatchQueue.global().async { dragPointer(from: start, to: destination) }
            }
        }
        app.run()
    }
}
