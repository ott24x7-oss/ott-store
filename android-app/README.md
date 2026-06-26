# OTT24x7 — Android app

A native Android app that wraps the gold mini-app store at **https://ott24x7.com/app**
in a full-screen WebView. The UI lives on the server (`public/store/app.html`), so
updating the store updates the app instantly — no rebuild needed.

## What you need
- **Node.js 18+** and npm (you already have these — the website runs on Node)
- **Android Studio** (Giraffe/Koala or newer) with the Android SDK + **JDK 17**

## Build the APK (one-time setup)
```bash
cd android-app
npm install
npx cap add android       # generates the native android/ Gradle project
npx cap sync android
npx cap open android       # opens the project in Android Studio
```
Then in **Android Studio**:
- Press **Run ▶** on a connected phone/emulator to try it, **or**
- **Build → Build Bundle(s) / APK(s) → Build APK(s)** → the debug APK lands at
  `android-app/android/app/build/outputs/apk/debug/app-debug.apk` (sideload this).

After any later change you only re-run `npx cap sync android` and rebuild — and for
*server-side* UI changes (editing `app.html`) you don't even need that, just redeploy
the website.

## Release build (for Google Play / signed install)
In Android Studio: **Build → Generate Signed Bundle / APK** → create a keystore
(keep it safe!) → choose **Android App Bundle (.aab)** for Play, or **APK** for direct
install.

## App name & icon
- **Name:** `appName` in `capacitor.config.json` (currently `OTT24x7`).
- **App ID:** `appId` is `com.ott24x7.app` — change it before publishing if you like
  (do this BEFORE `npx cap add android`).
- **Icon + splash:** drop a `1024×1024` `icon.png` (and optional `splash.png`) into
  `android-app/assets/`, then run:
  ```bash
  npm i -D @capacitor/assets
  npx @capacitor/assets generate --android
  npx cap sync android
  ```
  Or use Android Studio → right-click `res` → **New → Image Asset**.

## How it works / notes
- `server.url` points the WebView at the live `/app`, so login + every `/user/api`
  call is **same-origin** — the session cookie works exactly like in a browser.
- INTERNET permission is added by Capacitor automatically.
- Status bar + splash background are set to the store's dark `#06070C`.
- To point the app at a staging/dev server, change `server.url` and re-sync.

## Files in this folder
- `capacitor.config.json` — app id, name, the `server.url`, splash/status-bar.
- `package.json` — Capacitor dependencies.
- `www/index.html` — fallback splash shown only if the live store is unreachable.
- `android/` — created by `npx cap add android` (not committed; build artifact).
