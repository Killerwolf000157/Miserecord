# Miserecord

Private calls with your friends, 1:1 or in groups of up to 8, with no server to run:

- **Voice call** with mute and speaking indicators
- **Screen sharing**, including tab or system audio where the browser supports it
- **Media file streaming**: play a local video or song live to your friend
- **Chat and file transfer** of any size, with image previews
- **Group lobbies**: create a lobby, share its one code, and anyone with it can join (up to 8 people)
- **Saved friends**: swap codes once, then just press **Call**
- **Settings** (gear icon): microphone and speaker, echo cancellation and noise suppression,
  voice quality up to Hi-Fi stereo, streamed audio up to 510 kbps, screen-share resolution
  up to 4K at 60 fps, video bitrate up to 50 Mbps, codec (AV1, VP9, H.264, VP8), and live
  stats of what's actually being sent and received
- **Push to talk and shortcuts** (mute, leave), with side mouse buttons supported. In the desktop app they work even while a game is in front
- **AI noise suppression** that runs on your computer and removes keyboards, fans and hiss (Settings > Audio)
- **Sound panel** (speaker button in the call): your microphone volume, each person's voice and the streams, up to 200%
- **Zoom into streams**: the magnifier button, or scroll in full screen (Ctrl+scroll on the stage); drag to move, double-click to reset
- **Mute everyone else** next to Mute: silences every voice and stream you receive
- **Quick quality switch** (Low / Medium / High) on your own screen share or stream
- **Optional soft ringtone** for incoming calls, off by default
- Light and dark mode
- English and French (Settings > General > Language; Automatic follows Windows)

Audio, video, chat and files travel **directly between the two browsers** over WebRTC,
encrypted end to end (DTLS-SRTP / DTLS). Nothing relays them.

## Install

Download **Miserecord-Setup.exe** from the [latest release](https://github.com/Killerwolf000157/Miserecord/releases/latest)
and run it. It adds Miserecord to the Start menu and desktop, keeps your name, settings and
friends between launches, and updates itself: new versions download in the background and
install when you click **Restart to update** (or the next time you quit).

The installer isn't code-signed yet, so Windows SmartScreen may say "Windows protected your PC".
Click **More info → Run anyway**.

The desktop app adds:
- an in-app screen picker with full computer sound on Windows, leaving out Miserecord's own sound so friends never hear themselves; while you share a monitor, Miserecord hides itself from the capture (no mirror effect) and a rainbow frame only you can see marks the shared screen
- its own top bar with the real Windows minimize, maximize and close buttons
- running in the tray when you close the window, so friends can still call you, and an
  option to start hidden with Windows (Settings → General)
- push to talk and shortcuts that work everywhere, even in games
- a quiet notification when a friend calls while the window is hidden
- a first-launch setup to pick your microphone and speaker
- Uninstall in Settings, with an option to also delete your friends, settings and logs

### Without installing

Open `public/index.html` in Chrome or Edge. Everything works except the desktop extras.

### Group calls: lobbies

1. Click **Create a lobby**. You get a code like `7KQ4-XM2P-9DTA-H3VW`.
2. Share it however you like. Others type it under **Group call** and click **Join**.
3. As the lobby's creator you can **lock** it (the lock in the top bar) so nobody new can join,
   and **remove** someone (the × on their picture).

The code is the key: anyone who has it can join, so share it only with people you want in the call.

### First call with someone new: swap two codes

1. Enter your name and click **Start a call**. Send your friend the code shown, over any chat app.
2. Your friend clicks **Join with a code**, pastes it, and sends back the reply code.
3. Paste the reply and click **Connect**.

During that call the two apps save each other as friends.

### Every call after that

Your friend shows up under **Friends**. Press **Call**. Your friend gets an incoming-call
screen if they have Miserecord open, and can answer or decline.

## How it works

**Groups.** Everyone in a lobby connects directly to everyone else (a "mesh"), so there is still
no server. Each person uploads their voice and streams once per other person, which is why
lobbies stop at 8 and why streaming in 4K to several people needs plenty of upload.

**Lobby codes.** The 16-character code (80 random bits) is turned into the lobby's relay topic
and its encryption key, so relays only ever see encrypted messages, and only people with the
code can read them or find the lobby.


**First connection.** The codes carry each side's WebRTC connection info. Once the direct
connection is up, all further setup (such as starting a screen share) goes over it.

**Saving a friend.** Over that direct, encrypted connection the two apps swap
identity keys (ECDH P-256) and derive a shared secret, which gives:
- an AES-GCM key that encrypts every message the two of you send through relays, and
- a meeting topic name that changes every day.

**Calling a saved friend.** Both apps listen on a few public [Nostr](https://nostr.com)
relays (listed under *Network settings*) for their friends' topics. Calling sends an
encrypted "ring", the answer comes back, and the two apps swap encrypted connection info
until the direct call is up.

What the relays can and can't see:

| Relays see | Relays never see |
| --- | --- |
| Your IP address | Names, or who you are |
| An encrypted blob on a topic that changes daily | Connection info (it's encrypted) |
| When messages are sent | Audio, video, chat or files |

The messages are "ephemeral" Nostr events that relays forward and don't store. Each session
signs them with a throwaway key, so they can't be linked to you over time.

**STUN.** A public STUN server (Google's by default) tells each browser its public IP so the
two of you can find a direct route. No call data passes through it. You can change or clear
it under *Network settings*.

**No TURN relay, by design.** If both of you are behind very strict NATs or firewalls (some
corporate or mobile networks), a direct connection isn't possible and the call won't connect.

## Good to know

- Your friend only gets your call while Miserecord is open; there are no push notifications.
- Peer to peer means your friend can see your IP address.
- Saved friends and your identity key live in this browser's storage. Clearing site data
  removes them, and then you swap codes again.
- **Screen-share audio:** Chrome and Edge can share tab audio (and system audio on Windows).
- **Media file streaming** works best in Chrome and Edge.

## Development

```bash
npm install
```

```bash
npm start
```

`npm start` runs the version you are working on. It keeps its own data (%APPDATA%Miserecord Dev) and runs next to the installed app, so you can even call between the two.

`npm run dist` builds the installer into `dist/`. To publish an update, bump the version and push
the tag; the GitHub Actions workflow builds the installer and creates the release:

```bash
npm version patch
```

```bash
git push --follow-tags
```

## Files

```
public/index.html     UI
public/style.css      design system (light and dark)
public/app.js         calls: WebRTC, media, chat, files, saved-friend calling
public/settings.js    settings sheet: devices, quality, codecs, theme, network
public/rendezvous.js  friends, encryption, Nostr relay client, BIP-340 signatures
public/log.js         connection log (Settings → General → Troubleshooting)
public/extras.js      volume, ringtone, push to talk and shortcuts
public/desktop.js     desktop extras: screen picker, update banner, window buttons
public/denoise.js     AI noise suppression for the microphone (models in public/vendor/noise)
public/i18n.js        English and French
electron/main.js      desktop app: window, tray, permissions, screen capture, global hotkeys, auto-update
electron/preload.js   the small bridge between the page and the desktop app
build/make-icon.js    draws the app icon
```
