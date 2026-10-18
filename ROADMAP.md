# Miserecord roadmap

Goal: a private 1-to-1 app for calls and **crisp 4K streaming** with a friend, with none of
Discord's quality caps and no middleman. Media stays direct peer to peer.

## 0. Test the current version first

- [x] Codes work between two browsers (chat confirmed)
- [ ] **Saved friends:** after the first call, press **Call** and check your friend gets the incoming-call screen
- [ ] Real microphone audio on both sides (in the test the mic was blocked; allow it from the address bar)
- [ ] Call between two machines over the internet
- [ ] Status shows **Connected directly** with "over the internet"
- [ ] Screen share, media file streaming, chat and file transfer between the two machines
- [ ] Note anything that felt off (quality, latency, echo, UI)

## 1. Quality tuning — video

- [x] Bitrate cap up to 50 Mbps (Settings → Video)
- [x] Screen share up to 4K at 60 fps
- [x] Codec choice: AV1, VP9, H.264, VP8 (synced with your friend)
- [x] Keep sharp or keep smooth under load
- [x] Live stats in Settings → Video
- [ ] Test real 4K60 between two machines and tune the defaults
- [ ] Stats overlay on the stream itself (optional)

## 1b. Quality tuning — audio

- [x] Hi-Fi stereo voice (processing off, needs headphones)
- [x] Streamed and screen-share audio in stereo up to 510 kbps
- [x] Pick microphone and speaker; echo cancellation, noise suppression, auto volume switches

## 2. Security

- [ ] **Safety code:** short code from both peers' encryption fingerprints, read aloud to rule out anyone in the middle
- [x] Encrypted relay messages for saved friends (AES-GCM key from an ECDH exchange over the direct connection)
- [ ] Verify the saved friend's key on later calls (show a warning if it changes)
- [ ] Content Security Policy for the page

## 3. Desktop app (Electron)

- [ ] Package the current code as a Windows app (Mac/Linux later if needed)
- [ ] Launches like a normal program, can stay in the tray to receive calls
- [ ] Full system audio capture when screen sharing
- [ ] Custom screen/window picker, tray icon

## 4. Later / maybe

- [ ] Message history saved locally between calls
- [ ] Optional sound or notification for incoming calls (quiet by default)
- [ ] Native encoder (Go/Rust WebRTC with direct GPU encoding: NVENC/AMF, HEVC/AV1) if Electron quality still isn't enough
- [ ] Phone support

## Known limits to remember

- Streaming quality is capped by the **streamer's upload speed**. 4K needs about 25–50 Mbps of steady upload.
- No relay by design, so very strict networks (some corporate/mobile) can't connect directly.
- Peer to peer means your friend can see your IP address.
