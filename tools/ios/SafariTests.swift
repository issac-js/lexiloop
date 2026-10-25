import XCTest

final class SafariTests: XCTestCase {
    func testSafariSettingsAndLearning() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let launcher = XCUIApplication()
        launcher.launchEnvironment["LEXILOOP_FIXTURE_URL"] = "http://127.0.0.1:8765/?fixture=normal&nosw=1&ios=1"
        launcher.launch()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.webViews.firstMatch.waitForExistence(timeout: 60))
        let web = safari.webViews.firstMatch
        let run = safari.buttons["运行兼容性复测"].firstMatch
        XCTAssertTrue(run.waitForExistence(timeout: 30), "Fixture bootstrap must finish before native taps")
        let me = web.buttons["我的"].firstMatch
        XCTAssertTrue(me.waitForExistence(timeout: 30))
        let rhythm = web.staticTexts["学习节奏"].firstMatch
        for _ in 0..<3 {
            me.tap()
            if rhythm.waitForExistence(timeout: 3) { break }
        }
        if !rhythm.exists { print(safari.debugDescription) }
        XCTAssertTrue(rhythm.exists, "Settings navigation did not complete")
        let interval = web.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "新卡跨日复习间隔")).firstMatch
        for _ in 0..<8 {
            if interval.exists && interval.isHittable { break }
            web.swipeUp()
        }
        XCTAssertTrue(interval.exists, "Missing labelled day interval field")
        interval.tap()
        XCTAssertTrue(safari.keyboards.firstMatch.waitForExistence(timeout: 5), "Number input did not open the software keyboard")
        interval.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        safari.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8) + "1")
        print("Native day interval after typing: \(interval.value ?? "no value")")
        let save = web.buttons["保存设置"].firstMatch
        for _ in 0..<8 {
            if save.exists && save.isHittable { break }
            web.swipeUp()
        }
        XCTAssertTrue(save.exists)
        save.tap()
        XCTAssertTrue(run.waitForExistence(timeout: 10))
        run.tap()
        let result = safari.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "IOS_QA_")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 45), "Safari report did not arrive")
        XCTAssertEqual(result.label, "IOS_QA_PASS", "Safari DOM checks did not pass")
        let portrait = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        portrait.name = "iOS Safari portrait"; portrait.lifetime = .keepAlways; add(portrait)
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        let landscape = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        landscape.name = "iOS Safari landscape"; landscape.lifetime = .keepAlways; add(landscape)
        XCTAssertTrue(web.exists)
    }
}
