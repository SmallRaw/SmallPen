import Cocoa
import Darwin
import UniformTypeIdentifiers
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKDownloadDelegate, WKNavigationDelegate {
    private var allowedOrigin: String?
    private var hostOutput = Data()
    private var hostOutputPipe: Pipe?
    private var hostProcess: Process?
    private var initialPackagePath: String?
    private var knownPackagePaths: Set<String> = []
    private var pendingPackages: [String] = []
    private var smokeMode = false
    private var smokeHomeMode = false
    private var smokePackageName: String?
    private var terminating = false
    private var hostReady = false
    private var initialWorkspaceReady = false
    private var webViews: [WKWebView] = []
    private var windowPackagePaths: [ObjectIdentifier: String] = [:]
    private var windowWorkspaceURLs: [ObjectIdentifier: URL] = [:]
    private var windows: [NSWindow] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        smokeMode = CommandLine.arguments.contains("--smoke")
        smokeHomeMode = CommandLine.arguments.contains("--smoke-home")
        NSApp.setActivationPolicy(smokeMode || smokeHomeMode ? .accessory : .regular)
        configureMenu()
        let packages = CommandLine.arguments.dropFirst().filter {
            !$0.hasPrefix("--") && $0.hasSuffix(".smallpen")
        }
        if let package = packages.first {
            startHost(packagePath: package)
            for path in packages.dropFirst() { openPackage(path) }
        } else if hostProcess != nil {
            return
        } else if smokeMode {
            failSmoke("--smoke requires a .smallpen package path")
        } else {
            startHost(packagePath: nil)
        }
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        let packages = filenames.filter { $0.hasSuffix(".smallpen") }
        if hostProcess == nil, let first = packages.first {
            startHost(packagePath: first)
            for path in packages.dropFirst() { openPackage(path) }
        } else {
            for path in packages { openPackage(path) }
        }
        sender.reply(toOpenOrPrint: packages.isEmpty ? .failure : .success)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        terminating = true
        hostOutputPipe?.fileHandleForReading.readabilityHandler = nil
        stopHost()
    }

    private func configureMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit SmallPen", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem()
        mainMenu.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        let create = fileMenu.addItem(withTitle: "New Package…", action: #selector(newPackageFromMenu), keyEquivalent: "n")
        create.target = self
        let open = fileMenu.addItem(withTitle: "Open Package…", action: #selector(openPackageFromMenu), keyEquivalent: "o")
        open.target = self
        fileMenu.addItem(NSMenuItem.separator())
        fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        let reload = viewMenu.addItem(withTitle: "Reload", action: #selector(reloadWebView), keyEquivalent: "r")
        reload.target = self
        viewItem.submenu = viewMenu
        NSApp.mainMenu = mainMenu
    }

    @objc private func openPackageFromMenu() {
        choosePackage { [weak self] path in
            if let path { self?.openPackage(path) }
        }
    }

    @objc private func newPackageFromMenu() {
        chooseNewPackage()
    }

    @objc private func reloadWebView() {
        (NSApp.keyWindow?.contentView as? WKWebView)?.reload()
    }

    private func choosePackage(completion: @escaping (String?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "Open a SmallPen Package"
        panel.prompt = "Open"
        panel.message = "Choose one independent .smallpen package directory."
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.begin { response in
            guard response == .OK, let path = panel.url?.path else {
                completion(nil)
                return
            }
            completion(path)
        }
    }

    private func chooseNewPackage(replacing windowId: ObjectIdentifier? = nil) {
        let panel = NSSavePanel()
        panel.title = "Create a SmallPen Package"
        panel.prompt = "Create"
        panel.nameFieldStringValue = "Untitled.smallpen"
        if let packageType = UTType(filenameExtension: "smallpen") {
            panel.allowedContentTypes = [packageType]
        }
        panel.canCreateDirectories = true
        panel.begin { [weak self] response in
            guard response == .OK, let path = panel.url?.path else { return }
            self?.createPackage(path, replacing: windowId)
        }
    }

    private func startHost(packagePath: String?) {
        guard hostProcess == nil else {
            if let packagePath { openPackage(packagePath) }
            return
        }
        let packagePath = packagePath.map(canonicalPackagePath)
        if let packagePath {
            guard knownPackagePaths.insert(packagePath).inserted else { return }
            initialPackagePath = packagePath
        }
        guard let resources = Bundle.main.resourceURL else {
            fail("Desktop bundle Resources directory is unavailable")
            return
        }
        let node = resources.appendingPathComponent("runtime/node")
        let hostScript = resources.appendingPathComponent("app/apps/desktop/bin/desktop-host.mjs")
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = node
        process.arguments = [hostScript.path] + (packagePath.map { [$0] } ?? [])
        process.currentDirectoryURL = resources.appendingPathComponent("app")
        process.standardOutput = output
        process.standardError = errors
        hostProcess = process
        hostOutputPipe = output
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { [weak self, data] in self?.consumeHostOutput(data) }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if !data.isEmpty { FileHandle.standardError.write(data) }
        }
        process.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.terminating else { return }
                self.fail("Local Desktop host exited unexpectedly (status \(status))")
            }
        }
        do {
            try process.run()
        } catch {
            if let packagePath { knownPackagePaths.remove(packagePath) }
            initialPackagePath = nil
            fail("Unable to start the bundled SmallPen runtime: \(error.localizedDescription)")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            if self?.webViews.isEmpty == true { self?.fail("Local Desktop host startup timed out") }
        }
    }

    private func consumeHostOutput(_ data: Data) {
        hostOutput.append(data)
        guard let newline = hostOutput.firstIndex(of: 10) else { return }
        let line = hostOutput.prefix(upTo: newline)
        hostOutputPipe?.fileHandleForReading.readabilityHandler = nil
        do {
            guard
                let value = try JSONSerialization.jsonObject(with: line) as? [String: Any],
                value["status"] as? String == "ready",
                let source = value["web"] as? String,
                let url = URL(string: source)
            else {
                let source = String(data: line, encoding: .utf8) ?? "invalid host response"
                fail("SmallPen Desktop host failed: \(source)")
                return
            }
            smokePackageName = value["packageName"] as? String
            hostReady = true
            openWindow(url, packagePath: initialPackagePath)
            let queuedPackages = pendingPackages
            pendingPackages.removeAll()
            for path in queuedPackages { requestPackage(path) }
        } catch {
            fail("SmallPen Desktop host returned invalid JSON: \(error.localizedDescription)")
        }
    }

    private func openWindow(_ url: URL, packagePath: String?) {
        guard url.scheme == "http", url.host == "127.0.0.1" || url.host == "localhost" else {
            if let packagePath { knownPackagePaths.remove(packagePath) }
            fail("Desktop host returned a non-loopback URL")
            return
        }
        allowedOrigin = origin(url)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.closable, .miniaturizable, .resizable, .titled],
            backing: .buffered,
            defer: false
        )
        window.title = "SmallPen"
        window.contentView = web
        window.delegate = self
        if let previous = windows.last {
            window.setFrameOrigin(
                NSPoint(x: previous.frame.origin.x + 24, y: previous.frame.origin.y - 24)
            )
        } else {
            window.center()
        }
        // WKWebView may suspend an entirely hidden window, which makes the
        // smoke test report a false rendering timeout. Keep the accessory
        // window composited behind other apps without taking keyboard focus.
        if smokeMode { window.orderBack(nil) }
        else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        webViews.append(web)
        windows.append(window)
        let windowId = ObjectIdentifier(window)
        if let packagePath {
            windowPackagePaths[windowId] = packagePath
            windowWorkspaceURLs[windowId] = url
        }
        web.load(URLRequest(url: url))
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        let windowId = ObjectIdentifier(window)
        if let webView = window.contentView as? WKWebView {
            // 当前页面可能已经进入预览或其他 hash；关闭的仍是此窗口最初绑定的文件。
            closePackageSession(for: windowWorkspaceURLs.removeValue(forKey: windowId))
            webView.stopLoading()
            webView.navigationDelegate = nil
            webViews.removeAll { $0 === webView }
        }
        if let packagePath = windowPackagePaths.removeValue(forKey: windowId) {
            knownPackagePaths.remove(packagePath)
        }
        windows.removeAll { $0 === window }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme == "smallpen" {
            decisionHandler(.cancel)
            let windowId = webView.window.map(ObjectIdentifier.init)
            switch url.host {
            case "create":
                chooseNewPackage(replacing: windowId)
            case "open":
                choosePackage { [weak self] path in
                    if let path { self?.openPackage(path, replacing: windowId) }
                }
            default:
                fail("Unsupported SmallPen Desktop action")
            }
            return
        }
        guard let url = navigationAction.request.url, allowedNavigation(url) else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        syncWindowTitle(webView, attemptsRemaining: 40)
        if webViews.first === webView, smokeHomeMode {
            waitForHome(webView, deadline: Date().addingTimeInterval(15))
        } else if webViews.first === webView, initialPackagePath != nil, !initialWorkspaceReady {
            let timeout: TimeInterval = smokeMode ? 15 : 30
            waitForInitialWorkspace(webView, deadline: Date().addingTimeInterval(timeout))
        }
    }

    private func waitForHome(_ webView: WKWebView, deadline: Date) {
        webView.evaluateJavaScript("document.querySelector('[data-testid=\"smallpen-home\"]') !== null") {
            [weak self, weak webView] value, error in
            guard let self else { return }
            if error == nil, value as? Bool == true {
                let result: [String: Any] = ["status": "ready", "ui": "home"]
                if let bytes = try? JSONSerialization.data(withJSONObject: result) {
                    FileHandle.standardOutput.write(bytes)
                    FileHandle.standardOutput.write(Data([10]))
                }
                NSApp.terminate(nil)
                return
            }
            guard Date() < deadline, let webView else {
                self.failSmoke(error?.localizedDescription ?? "SmallPen Home did not render")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self, weak webView] in
                guard let self, let webView else { return }
                self.waitForHome(webView, deadline: deadline)
            }
        }
    }

    private func syncWindowTitle(_ webView: WKWebView, attemptsRemaining: Int) {
        webView.evaluateJavaScript("document.title") { [weak self, weak webView] value, _ in
            guard let self, let webView else { return }
            if let title = value as? String, title.hasSuffix(" - Penpot") {
                webView.window?.title = title
                return
            }
            guard attemptsRemaining > 0 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self, weak webView] in
                guard let self, let webView else { return }
                self.syncWindowTitle(webView, attemptsRemaining: attemptsRemaining - 1)
            }
        }
    }

    private func waitForInitialWorkspace(_ webView: WKWebView, deadline: Date) {
        webView.evaluateJavaScript("document.querySelector('[data-testid=\"viewport\"]') !== null") {
            [weak self, weak webView] value, error in
            guard let self else { return }
            if error == nil, value as? Bool == true {
                guard !self.initialWorkspaceReady else { return }
                self.initialWorkspaceReady = true
                let queuedPackages = self.pendingPackages
                self.pendingPackages.removeAll()
                for path in queuedPackages { self.requestPackage(path) }
                if self.smokeMode { self.finishSmoke() }
                return
            }
            guard Date() < deadline, let webView else {
                let message = error?.localizedDescription ?? "Penpot workspace viewport did not render"
                if self.smokeMode { self.failSmoke(message) }
                else { self.fail(message) }
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self, weak webView] in
                guard let self, let webView else { return }
                self.waitForInitialWorkspace(webView, deadline: deadline)
            }
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction,
                 didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse,
                 didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let manager = FileManager.default
        let configured = ProcessInfo.processInfo.environment["SMALLPEN_DESKTOP_DOWNLOADS"]
        let directory = configured.map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? manager.urls(for: .downloadsDirectory, in: .userDomainMask).first
        guard let directory else {
            completionHandler(nil)
            return
        }
        try? manager.createDirectory(at: directory, withIntermediateDirectories: true)
        let safeName = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        let stem = (safeName as NSString).deletingPathExtension
        let suffix = (safeName as NSString).pathExtension
        var destination = directory.appendingPathComponent(safeName.isEmpty ? "smallpen-download" : safeName)
        var sequence = 2
        while manager.fileExists(atPath: destination.path) {
            let name = suffix.isEmpty ? "\(stem)-\(sequence)" : "\(stem)-\(sequence).\(suffix)"
            destination = directory.appendingPathComponent(name)
            sequence += 1
        }
        completionHandler(destination)
    }

    private func openPackage(_ path: String, replacing windowId: ObjectIdentifier? = nil) {
        guard path.lowercased().hasSuffix(".smallpen") else {
            fail("Selected path is not a .smallpen package")
            return
        }
        let path = canonicalPackagePath(path)
        guard knownPackagePaths.insert(path).inserted else { return }
        guard hostReady else {
            pendingPackages.append(path)
            return
        }
        requestPackage(path, replacing: windowId)
    }

    private func createPackage(_ rawPath: String, replacing windowId: ObjectIdentifier? = nil) {
        let suffixed = rawPath.lowercased().hasSuffix(".smallpen")
            ? rawPath
            : "\(rawPath).smallpen"
        let path = canonicalPackagePath(suffixed)
        guard knownPackagePaths.insert(path).inserted else { return }
        requestPackage(path, action: "create", replacing: windowId)
    }

    private func requestPackage(
        _ path: String,
        action: String = "open",
        replacing windowId: ObjectIdentifier? = nil
    ) {
        guard let allowedOrigin, let endpoint = URL(
            string: "/desktop/\(action)-package",
            relativeTo: URL(string: allowedOrigin)
        )?.absoluteURL else {
            fail("Local Desktop host is unavailable")
            return
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["locator": path]
        )
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode
            let message = error?.localizedDescription
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard message == nil, status == 201, let data else {
                    self.knownPackagePaths.remove(path)
                    self.fail("Unable to open the SmallPen package: \(message ?? "local host returned \(status ?? 0)")")
                    return
                }
                do {
                    guard
                        let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                        let source = value["url"] as? String,
                        let url = URL(string: source),
                        self.allowedNavigation(url)
                    else { throw NSError(domain: "SmallPenDesktop", code: 1) }
                    if
                        let windowId,
                        let window = self.windows.first(where: { ObjectIdentifier($0) == windowId }),
                        let webView = window.contentView as? WKWebView
                    {
                        self.windowPackagePaths[windowId] = path
                        self.windowWorkspaceURLs[windowId] = url
                        webView.load(URLRequest(url: url))
                    } else {
                        self.openWindow(url, packagePath: path)
                    }
                } catch {
                    self.knownPackagePaths.remove(path)
                    self.fail("Local host returned an invalid Penpot workspace URL")
                }
            }
        }.resume()
    }

    private func closePackageSession(for workspaceURL: URL?) {
        guard
            let workspaceURL,
            origin(workspaceURL) == allowedOrigin,
            let endpoint = URL(string: "/desktop/close-package", relativeTo: workspaceURL)?.absoluteURL,
            let body = try? JSONSerialization.data(withJSONObject: ["url": workspaceURL.absoluteString])
        else { return }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        URLSession.shared.dataTask(with: request).resume()
    }

    private func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme, let host = url.host else { return nil }
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    private func allowedNavigation(_ url: URL) -> Bool {
        if origin(url) == allowedOrigin { return true }
        guard url.scheme == "blob", let allowedOrigin else { return false }
        return url.absoluteString.hasPrefix("blob:\(allowedOrigin)/")
    }

    private func canonicalPackagePath(_ path: String) -> String {
        if path.hasPrefix("/") { return URL(fileURLWithPath: path).standardizedFileURL.path }
        return URL(
            fileURLWithPath: path,
            relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        ).standardizedFileURL.path
    }

    private func failSmoke(_ message: String) {
        FileHandle.standardError.write(Data("\(message)\n".utf8))
        terminating = true
        stopHost()
        exit(1)
    }

    private func stopHost() {
        guard let process = hostProcess, process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(3)
        while process.isRunning, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
    }

    private func finishSmoke() {
        let result: [String: Any] = [
            "packageName": smokePackageName ?? "",
            "status": "ready",
            "ui": "penpot",
        ]
        if let bytes = try? JSONSerialization.data(withJSONObject: result) {
            FileHandle.standardOutput.write(bytes)
            FileHandle.standardOutput.write(Data([10]))
        }
        NSApp.terminate(nil)
    }

    private func fail(_ message: String) {
        if smokeMode { failSmoke(message); return }
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "SmallPen could not open"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.run()
}
