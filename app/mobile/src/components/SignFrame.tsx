// Native: the web app's camera screen in a react-native-webview (14.x).
// Camera inside the page (getUserMedia):
//  - the page must be a secure context: https://, or http://localhost (e.g. `adb reverse tcp:8787 tcp:8787`).
//    A plain http://<LAN-IP> page has no navigator.mediaDevices in Android WebView or WKWebView.
//  - iOS (WKWebView, iOS 15+): NSCameraUsageDescription + allowsInlineMediaPlayback, and
//    mediaCapturePermissionGrantType="grant" so the page does not show a second web prompt.
//  - Android: CAMERA in the manifest and granted at runtime (Sign screen asks first). RNCWebChromeClient's
//    onPermissionRequest then grants RESOURCE_VIDEO_CAPTURE itself (asks the OS if still missing).
//    allowsProtectedMedia is only for DRM (RESOURCE_PROTECTED_MEDIA_ID), not needed for the camera.
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { INJECTED_BRIDGE, parseBridge, type BridgeMsg, type FrameError } from "../lib/bridge";

interface Props {
  url: string;
  onMessage: (m: BridgeMsg) => void;
  onError: (e: FrameError) => void;
  onReady: () => void;
}

export function SignFrame({ url, onMessage, onError, onReady }: Props) {
  return (
    <WebView
      source={{ uri: url }}
      style={{ flex: 1, backgroundColor: "transparent" }}
      containerStyle={{ backgroundColor: "#10208a" }}
      originWhitelist={["*"]}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      mediaCapturePermissionGrantType="grant"
      androidLayerType="hardware"
      setSupportMultipleWindows={false}
      bounces={false}
      overScrollMode="never"
      webviewDebuggingEnabled={__DEV__}
      injectedJavaScriptBeforeContentLoaded={INJECTED_BRIDGE}
      onMessage={(e: WebViewMessageEvent): void => { const m = parseBridge(e.nativeEvent.data); if (m) onMessage(m); }}
      onLoadEnd={onReady}
      onError={(e) => onError({ kind: "unreachable", detail: e.nativeEvent.description })}
      onHttpError={(e) => { if (e.nativeEvent.url.split("#")[0] === url.split("#")[0]) onError({ kind: "not-served", detail: `HTTP ${e.nativeEvent.statusCode}` }); }}
      testID="sign-frame"
    />
  );
}
