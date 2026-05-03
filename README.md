# Glass

A glassmorphic YouTube frontend for Windows. Pure custom UI — [Piped](https://github.com/TeamPiped/Piped) for browse / search / metadata, **yt-dlp** for the actual video streams.

## Architecture

- **Browse** (trending, search, channels, your subscription feed) → Piped public API. Instance list is auto-refreshed from Piped's index on startup, with multi-instance failover.
- **Stream URLs** → local `yt-dlp.exe`, run as a subprocess. This is what makes Glass actually keep working: requests come from your home IP, sidestepping the "Sign in to confirm you're not a bot" wall that periodically takes down Piped instances.
- **Account** (optional) → either a Piped account (username/password, no email) or real Google sign-in via OAuth (you provide your own Cloud OAuth client ID — see Google sign-in setup below).

## What's built in

- **Custom UI**: dark glassmorphic shell with frosted cards, animated gradient blobs, custom titlebar.
- **Ad/tracker blocking**: request-level blocking in the Electron main process via a curated domain + pattern list (uBO-style, not literally uBlock Origin since uBO is a browser extension that can't run in Electron). Edit [adblock.js](adblock.js) to extend.
- **Proton Pass**: the 🔑 button in the titlebar opens Proton's official extension download page in your default browser. Proton Pass is proprietary and can't be bundled — install the real extension into your real browser.
- **YouTube Takeout import**: drop the CSV or JSON from [takeout.google.com](https://takeout.google.com) into Glass — works with or without a Piped account.
- **Google sign-in (real OAuth)**: after a one-time setup of your own Google Cloud OAuth client, Glass auto-pulls your real YouTube subscriptions via the YouTube Data API. Tokens stored locally; refreshes silently. See setup below.
- **YouTube URL paste**: paste any `youtube.com/watch?v=…`, `youtu.be/…`, or `/shorts/…` link into the search box and it jumps straight to that video.

## Run

You need **Node.js 18+** and npm. Then either double-click [run.bat](run.bat) or:

```bash
cd youtube-glass
npm install
npm start
```

First launch downloads Electron (~100 MB). The first time you click *Install yt-dlp* in the banner at the top of the window, the app fetches `yt-dlp.exe` (~17 MB) from the official GitHub releases into Electron's user-data directory. After that, both are cached.

If you'd rather provide yt-dlp yourself, drop `yt-dlp.exe` at:

```
%APPDATA%\youtube-glass\yt-dlp.exe
```

## Google sign-in setup (one-time)

Glass uses **your own** OAuth Client ID — the app never proxies your YouTube data through anyone else's project. Trade-off: 5 minutes of clicking in the Google Cloud Console.

1. Create a project at [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate).
2. Enable the [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) for that project.
3. [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent): choose **External** → fill the required fields (app name, your email) → add scope **`youtube.readonly`** → add your own email under **Test users**. (Leave the app in *Testing* status — no verification needed for personal use.)
4. [Credentials](https://console.cloud.google.com/apis/credentials) → *Create Credentials* → *OAuth client ID* → **Desktop app** → name it whatever → **Copy the Client ID**.
5. In Glass: Sign in → "Sign in with Google" → paste the Client ID → "Save and sign in". Your default browser opens to Google's consent screen. Approve, and Glass picks up the rest automatically.

On first sign-in, Google may show **"Google hasn't verified this app"** — that's expected because the OAuth client is your own. Click *Advanced* → *Go to (project) (unsafe)*. It's safe; the project is yours.

Tokens are stored at `%APPDATA%\youtube-glass\google-auth.json`. To disconnect, use the account panel's *Disconnect Google* button.

## Customize

- **Piped instance** — [renderer/api.js](renderer/api.js). The app refreshes the live list from Piped's index on boot; the seed list at the top is the fallback.
- **Adblock list** — extend `AD_DOMAINS` / `AD_PATTERNS` in [adblock.js](adblock.js).
- **Theme** — CSS variables at the top of [renderer/styles.css](renderer/styles.css) drive every color.

## Caveats

- yt-dlp itself updates often to keep pace with YouTube changes. To upgrade it, delete `%APPDATA%\youtube-glass\yt-dlp.exe` and click *Install yt-dlp* again.
- "Up next" suggestions come from the channel's recent uploads (since yt-dlp doesn't have access to YouTube's recommendation algorithm without a logged-in session).
- Account login is per-Piped-instance — accounts don't sync across instances. If your instance disappears, your subscription list goes with it; export it via the account panel before that happens (or rely on the Takeout import to rebuild).
