import { browser } from "wxt/browser";

// The only background job: a click on the toolbar icon opens the side panel (the whole product).
// We open it from action.onClicked instead of setPanelBehavior({ openPanelOnActionClick }): the click is then a
// regular action invocation, which grants activeTab on that tab (what tabCapture.getMediaStreamId needs), and a
// second click on another tab re-grants it there without toggling the panel closed.
export default defineBackground(() => {
  browser.action.onClicked.addListener((tab) => {
    if (tab.windowId != null) browser.sidePanel.open({ windowId: tab.windowId }).catch((e) => console.warn("[signlayer] side panel", e));
  });
});
