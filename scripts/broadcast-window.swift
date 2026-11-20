import AppKit
import WebKit

private final class BroadcastWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "w" {
            close()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { close() } // Escape
        else { super.keyDown(with: event) }
    }
}

@MainActor
private final class BroadcastApp: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKScriptMessageHandler {
    private let stageURL: URL
    private var window: BroadcastWindow!
    private var webView: WKWebView!
    private var ready = false
    private var landscape = false

    init(url: URL) {
        self.stageURL = url
        self.landscape = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "layout" }?.value == "landscape"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "broadcastReady")
        config.userContentController.add(self, name: "stageLayout")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self

        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        window = BroadcastWindow(
            contentRect: frame(on: screen), styleMask: .borderless, backing: .buffered, defer: false
        )
        window.title = "大肥鱼直播画面"
        window.delegate = self
        window.backgroundColor = NSColor(srgbRed: 0.09, green: 0.19, blue: 0.28, alpha: 1)
        window.hasShadow = false
        window.isMovableByWindowBackground = true
        window.collectionBehavior = [.fullScreenAuxiliary]
        window.contentView = webView
        webView.load(URLRequest(url: stageURL))
        show()

        DispatchQueue.global(qos: .utility).async {
            while let command = readLine() {
                if command == "show" {
                    DispatchQueue.main.async { self.show() }
                }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func frame(on screen: NSScreen?) -> NSRect {
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let scale = screen?.backingScaleFactor ?? 1
        let ratio = landscape ? NSSize(width: 16, height: 9) : NSSize(width: 9, height: 16)
        let unit = floor(min(120 / scale, (visible.width - 16) / ratio.width, (visible.height - 16) / ratio.height))
        let size = NSSize(width: ratio.width * unit, height: ratio.height * unit)
        return NSRect(x: visible.maxX - size.width - 8, y: visible.maxY - size.height - 8,
                      width: size.width, height: size.height)
    }

    private func show() {
        window.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) { NSApp.activate() }
        else { NSApp.activate(ignoringOtherApps: true) }
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        if message.name == "stageLayout", let layout = message.body as? String,
           layout == "landscape" || layout == "portrait" {
            let next = layout == "landscape"
            if next != landscape {
                landscape = next
                window.setFrame(frame(on: window.screen), display: true)
            }
            return
        }
        if message.name == "broadcastReady", !ready {
            ready = true
            print("ready")
            fflush(stdout)
            return
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.targetFrame?.isMainFrame == true && action.request.url == stageURL ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSApp.terminate(nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(URLRequest(url: stageURL))
    }
}

@main
private struct Main {
    @MainActor static func main() {
        guard let address = readLine(), let url = URL(string: address),
              url.scheme == "http", url.host == "127.0.0.1" else { exit(2) }
        let app = NSApplication.shared
        let delegate = BroadcastApp(url: url)
        app.setActivationPolicy(.regular)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
