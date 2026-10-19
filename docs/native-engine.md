# Native streaming engine (branch `native-engine`)

Shipped in 2.0 (Settings > Video > Native streaming engine). Before it, the app streamed screens through Chromium's WebRTC,
which on Windows only uses the graphics card for H.264: AV1, VP9 and VP8 run on
the processor, the capture runs at normal priority, and frames are copied off the
GPU before encoding. On a gaming laptop that can drop a stream to a few frames per
second. This engine does what Discord does: the UI stays in Electron, the screen
streaming moves to native code.

## Shape

```
 sender                                                     viewer
 ┌───────────────────────────┐                              ┌─────────────────────────┐
 │ native helper (Rust)      │                              │ page (Chromium)         │
 │  Windows Graphics Capture │  encoded frames              │  WebCodecs VideoDecoder │
 │   → D3D11 texture (GPU)   │ ─── stdout / named pipe ──┐  │   (GPU decode)          │
 │   → Media Foundation MFT  │                           │  │   → canvas in the tile  │
 │     (NVENC / AMF / QSV)   │                           │  └───────────▲─────────────┘
 │     AV1 · HEVC · H.264    │                           │              │
 └───────────────────────────┘                           ▼              │
                                    page: engine/send.js ── RTCDataChannel "video"
                                    (packetise, pace, rate control)   (unordered, no retransmits)
```

- **Capture**: Windows Graphics Capture on the monitor or window, in a D3D11
  device on the same adapter as the encoder, at high priority. No copy off the GPU.
- **Encode**: the Media Foundation hardware encoder for the codec (the same MFTs
  Windows ships for NVIDIA NVENC, AMD AMF and Intel Quick Sync), fed D3D11
  textures through an `IMFDXGIDeviceManager`. AV1 where the card has it (RTX 40,
  RX 7000, Arc), otherwise HEVC or H.264. Low-latency mode, CBR-ish, no B-frames,
  periodic intra refresh plus keyframes on request.
- **Video lanes**: one data channel (SCTP) halves its window at every lost packet,
  like one TCP connection: through a relay with a 50 ms round trip it carried
  39 Mbps with no loss but 2.6 Mbps at 1% loss and 1.7 at 2%. The sharer opens 9
  extra lanes to each viewer (small peer connections with one video channel
  each, set up with `engine-lane` / `engine-lane-answer` over the call's channel)
  and sends each packet on the lane with the least waiting. With 10 lanes the
  real fan-out reached 9-15 Mbps at 2% loss, 12-20 at 1%, and its cap with none.
- **Per-viewer quality**: viewers report how big they show each stream
  (`stream-view`: the picture's size in physical pixels, full when zoomed,
  hidden when minimized). A hidden viewer gets nothing. Viewers who show the
  stream at most 60% of its height get the **small layer**: a second encode of
  the same capture in the helper (`low W H FPS BITRATE`, 360p/540p/720p at
  30 fps, 0.6/1.2/2 Mbps), started only while someone needs it and stopped 10 s
  after. A viewer moves between layers on the new layer's keyframe; frame
  numbers are counted per viewer; each layer's rate follows only its own
  viewers. Frames carry their layer in header byte 10.
- **Stream delay** (viewer setting: automatic by default, live, or 1 to 2 s): the
  automatic delay notes how late each frame arrives and covers 99% of it plus a
  margin (0.4 to 3 s). A frame that misses its moment raises it at once; after
  15 calm seconds it comes down 20 ms every 2 s. The sender's ladder waits twice
  as long before giving up resolution while viewers are 1 s or more behind. The viewer holds
  frames, still compressed, until shortly before they're due, and the stream's
  sound waits as long (`jitterBufferTarget`). Stalls on the line and resends are
  absorbed instead of freezing the picture. The viewer tells the sender
  (`engine-delay`): the sender lets data wait up to half that delay before
  calling the line full, and the helper's rate buffer grows to 80% of the least
  delayed viewer's delay (`buffer MS`), so busy moments can take bits from calm ones.
- **Convert**: the GPU's video processor turns BGRA into NV12 and scales. When a
  monitor streams at its own size and the encoder takes BGRA itself (NVIDIA's do),
  frames are only copied instead (copy mode), leaving more of a busy graphics card
  to the game. The helper reports frames skipped because every texture was still
  waiting on the card (`busyDrops`); Stream info blames the busy card, not the
  encoder, when that lasts.
- **Transport**: the call's existing peer-to-peer connection (DTLS encrypted),
  a second data channel `video`, reliable but unordered (partly reliable modes
  lost ~40% of frames between two apps). Packets are paced at 3x the bitrate so
  big keyframes don't overflow the receiver; a viewer more than 2 MB behind skips
  to the next keyframe. No server, no relay.
- **Decode**: WebCodecs `VideoDecoder` with `hardwareAcceleration: 'prefer-hardware'`,
  drawn to a canvas in the stream tile. Audio stays on WebRTC.
- **Fallback**: no helper, no hardware encoder, or a viewer that can't decode the
  codec → the current WebRTC screen share, unchanged.

## Wire format (data channel `video`)

Each encoded frame is split into packets of at most 16 KiB:

| bytes | field |
| --- | --- |
| 1 | version (1) |
| 1 | flags: bit 0 keyframe, bit 1 first packet, bit 2 last packet |
| 2 | stream number |
| 4 | frame number |
| 2 | packet index, 2 packet count |
| 8 | capture time, microseconds |
| n | payload (Annex B / OBU bytes) |

Header: 20 bytes. The first packet of a frame whose stream changed codec or size
is preceded by a JSON `engine-config` message on the normal channel
(`{ codec, width, height, description? }`).

## Control (JSON on the normal channel)

- viewer → sender `engine-feedback` every 500 ms: frames received, frames
  complete, packets lost, decode time, queue length. Lost or late frames make
  the viewer ask for `engine-keyframe`.
- sender rate control: start at the level's bitrate, back off 20% when loss
  goes over 2% or the viewer's queue grows, add 5% per second while clean, never
  above the Settings cap. The data channel's `bufferedAmount` is a second brake.

## Stages (1-3 done in 2.0)

1. **Transport and decoding in the page** (this branch, now): send frames from
   Chromium's own WebCodecs encoder over the `video` channel and decode them on
   the other side. Proves the wire format, pacing, loss handling and rate control
   without native code.
2. **Native helper, local test**: capture + hardware encode to a file; measure
   frames per second with a game running. If it isn't clearly better than WebRTC
   on the same machine, stop here.
3. **Helper in the app**: the page starts the helper for a share and forwards its
   frames into stage 1's sender; the viewer side doesn't change.
4. **Ship behind a setting**, then make it the default where it works.

## Building the helper

Needs Visual Studio Build Tools (C++ workload) and Rust (`rustup`, MSVC target).
The helper is a single `.exe` in `native/` copied into the installer; people
installing Miserecord don't need either.
