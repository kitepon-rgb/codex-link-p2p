// Widget extension entry. WidgetKit が main() を期待するので @main の WidgetBundle
// を定義する. 中身の Live Activity widget は CodexLinkIOS package の
// LiveActivity.swift 側に実装してある.

import SwiftUI
import WidgetKit
import CodexLinkIOS

@main
struct CodexLinkWidgetBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 17.0, *) {
            CodexLinkTurnLiveActivityWidget()
        }
    }
}
