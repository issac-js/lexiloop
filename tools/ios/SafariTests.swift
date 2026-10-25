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
        let me = web.buttons["我的"].firstMatch
        XCTAssertTrue(me.waitForExistence(timeout: 30))
        me.tap()
        let interval = web.textFields.matching(NSPredicate(format: "label CONTAINS %@", "新卡跨日复习间隔")).firstMatch
        for _ in 0..<8 {
            if interval.exists && interval.isHittable { break }
            web.swipeUp()
        }
        XCTAssertTrue(interval.exists, "Missing labelled day interval field")
        interval.tap()
        let old = (interval.value as? String) ?? "7"
        interval.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count) + "1")
        let save = web.buttons["保存设置"].firstMatch
        for _ in 0..<8 {
            if save.exists && save.isHittable { break }
            web.swipeUp()
        }
        XCTAssertTrue(save.exists)
        save.tap()
        let run = safari.buttons["运行兼容性复测"].firstMatch
        XCTAssertTrue(run.waitForExistence(timeout: 10))
        run.tap()
        XCTAssertTrue(safari.staticTexts["IOS_QA_PASS"].firstMatch.waitForExistence(timeout: 90), "Safari DOM checks did not pass")
        let portrait = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        portrait.name = "iOS Safari portrait"; portrait.lifetime = .keepAlways; add(portrait)
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        let landscape = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        landscape.name = "iOS Safari landscape"; landscape.lifetime = .keepAlways; add(landscape)
        XCTAssertTrue(web.exists)
    }
}
