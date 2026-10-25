import SwiftUI

@main
struct BrowserFixtureLauncher: App {
    var body: some Scene {
        WindowGroup {
            Text("LexiLoop isolated Safari QA").onAppear {
                if let raw = ProcessInfo.processInfo.environment["LEXILOOP_FIXTURE_URL"], let url = URL(string: raw) {
                    UIApplication.shared.open(url)
                }
            }
        }
    }
}
