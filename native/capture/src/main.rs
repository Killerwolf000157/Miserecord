// miserecord-capture: Miserecord's native screen capture and hardware encoder.
//
//   miserecord-capture --probe
//       prints {"adapter": ..., "codecs": ["AV1", "H264"]} and exits
//   miserecord-capture [--monitor N | --window HWND] [--codec auto|av1|h264]
//                      [--width 2560] [--height 1440] [--fps 60] [--bitrate 8000000]
//                      [--seconds N] [--out FILE]
//       streams encoded frames to stdout (or FILE), each as a 20-byte header
//       (u32 length, u8 flags: 1 = keyframe, u8 codec: 1 = H.264, 2 = AV1,
//       u16 width, u16 height, u16 0, u64 capture time in microseconds, all
//       little-endian) and the payload (Annex B for H.264, OBUs for AV1).
//       stdin takes lines: "key", "bitrate N", "quit".
//       stderr gets one JSON line per event: ready, stats (every second), error.
//
// See docs/native-engine.md.
mod capture;
mod convert;
mod dup;
mod encode;
mod gpu;

use std::collections::VecDeque;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use windows::Win32::Media::MediaFoundation::{MFStartup, MFSTARTUP_FULL, MF_VERSION};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};

use encode::{Codec, Encoder};
use gpu::Sendable;

// NV12 textures between capture and encoder; the encoder keeps a few in flight.
const RING: usize = 8;

struct Args {
    probe: bool,
    target: capture::Target,
    codec: Option<Codec>,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    seconds: u64,
    out: Option<String>,
}

fn parse() -> Args {
    let mut a = Args {
        probe: false,
        target: capture::Target::Primary,
        codec: None,
        width: 2560,
        height: 1440,
        fps: 60,
        bitrate: 8_000_000,
        seconds: 0,
        out: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut v = || it.next().unwrap_or_default();
        match k.as_str() {
            "--probe" => a.probe = true,
            "--monitor" => {
                let s = v();
                a.target = if s == "primary" { capture::Target::Primary } else { capture::Target::Monitor(s.parse().unwrap_or(0)) }
            }
            "--window" => a.target = capture::Target::Window(v().parse().unwrap_or(0)),
            "--codec" => {
                a.codec = match v().to_lowercase().as_str() {
                    "av1" => Some(Codec::Av1),
                    "h264" => Some(Codec::H264),
                    _ => None,
                }
            }
            "--width" => a.width = v().parse().unwrap_or(2560),
            "--height" => a.height = v().parse().unwrap_or(1440),
            "--fps" => a.fps = v().parse::<u32>().unwrap_or(60).clamp(1, 240),
            "--bitrate" => a.bitrate = v().parse().unwrap_or(8_000_000),
            "--seconds" => a.seconds = v().parse().unwrap_or(0),
            "--out" => a.out = Some(v()),
            _ => {}
        }
    }
    a
}

fn event(json: String) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{json}");
    let _ = err.flush();
}

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn main() {
    if let Err(e) = run() {
        event(format!("{{\"event\":\"error\",\"message\":\"{}\"}}", esc(&e.message())));
        std::process::exit(1);
    }
}

fn run() -> windows::core::Result<()> {
    let args = parse();
    unsafe {
        RoInitialize(RO_INIT_MULTITHREADED)?;
        MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    if args.probe {
        let gpu = gpu::create()?;
        let codecs: Vec<String> = encode::available(&gpu).iter().map(|c| format!("\"{}\"", c.name())).collect();
        println!("{{\"adapter\":\"{}\",\"codecs\":[{}]}}", esc(&gpu.name), codecs.join(","));
        return Ok(());
    }

    // A monitor is captured with Desktop Duplication on the chip that drives it,
    // and encoded there if that chip has a hardware encoder; a window (or a monitor
    // on a chip without one) with Windows Graphics Capture on the fast card.
    let mut duplicate = None;
    let mut gpu = None;
    if let Some(m) = capture::monitor_of(&args.target) {
        {
            if let Some((adapter, output)) = dup::find_output(m)? {
                let g = gpu::create_on(&adapter)?;
                if !encode::available(&g).is_empty() {
                    gpu = Some(g);
                    duplicate = Some(output);
                }
            }
        }
    }
    let gpu = match gpu {
        Some(g) => g,
        None => gpu::create()?,
    };

    let priority = gpu::raise_priority(&gpu);
    let item = if duplicate.is_none() { Some(capture::item(&args.target)?) } else { None };
    let (cw, ch) = match (&duplicate, &item) {
        (Some(output), _) => {
            let r = unsafe { output.GetDesc()?.DesktopCoordinates };
            ((r.right - r.left).max(2) as u32, (r.bottom - r.top).max(2) as u32)
        }
        (None, Some(item)) => {
            let s = item.Size()?;
            (s.Width.max(2) as u32, s.Height.max(2) as u32)
        }
        _ => unreachable!(),
    };
    // The stream keeps the screen's shape and fits inside width x height.
    let scale = f64::min(1.0, f64::min(args.width as f64 / cw as f64, args.height as f64 / ch as f64));
    let (ow, oh) = (((cw as f64 * scale) as u32) & !1, ((ch as f64 * scale) as u32) & !1);

    // The asked-for codec if the card has it in hardware, else the best one it has.
    let order: Vec<Codec> = match args.codec {
        Some(c) => vec![c, Codec::H264, Codec::Av1],
        None => vec![Codec::Av1, Codec::H264],
    };
    let mut encoder = None;
    for c in order {
        if let Some(e) = Encoder::new(&gpu, c, ow, oh, args.fps, args.bitrate)? {
            encoder = Some(e);
            break;
        }
    }
    let Some(mut encoder) = encoder else {
        return Err(windows::core::Error::new(windows::core::HRESULT(0x80004001u32 as i32), "no hardware video encoder on this graphics card"));
    };

    let converter = Arc::new(Sendable(convert::Converter::new(&gpu, cw, ch, ow, oh, RING)?));
    let free: Arc<Mutex<VecDeque<usize>>> = Arc::new(Mutex::new((0..RING).collect()));
    let (tx, rx) = mpsc::channel::<(usize, i64)>();
    let captured = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicU64::new(0));
    let interval = 10_000_000 / args.fps as i64; // 100 ns units

    {
        let converter = converter.clone();
        let free = free.clone();
        let captured = captured.clone();
        let dropped = dropped.clone();
        let mut due: i64 = i64::MIN / 2;
        let on_frame = move |texture: &windows::Win32::Graphics::Direct3D11::ID3D11Texture2D, time: i64, w: u32, h: u32| {
            // A 144 Hz screen hands over more frames than the stream needs. Frames come
            // with some jitter, so keep a schedule instead of a strict minimum gap.
            if time < due - interval / 4 {
                return;
            }
            due = (due + interval).max(time);
            captured.fetch_add(1, Ordering::Relaxed);
            let slot = free.lock().unwrap().pop_front();
            let Some(slot) = slot else {
                dropped.fetch_add(1, Ordering::Relaxed); // the encoder is behind: skip, don't queue up delay
                return;
            };
            if converter.0.convert(texture, w.min(cw), h.min(ch), slot).is_ok() {
                let _ = tx.send((slot, time));
            } else {
                free.lock().unwrap().push_back(slot);
            }
        };
        match (duplicate.clone(), &item) {
            (Some(output), _) => {
                dup::start(&gpu, output, on_frame)?;
            }
            (None, Some(item)) => {
                let cap = capture::start(&gpu, item, on_frame)?;
                std::mem::forget(cap); // lives as long as the process
            }
            _ => unreachable!(),
        }
    }

    event(format!(
        "{{\"event\":\"ready\",\"codec\":\"{}\",\"encoder\":\"{}\",\"adapter\":\"{}\",\"capture\":\"{}\",\"width\":{},\"height\":{},\"fps\":{},\"priority\":\"{}\",\"refused\":\"{}\"}}",
        encoder.codec.name(), esc(&encoder.name), esc(&gpu.name), if duplicate.is_some() { "desktop duplication" } else { "graphics capture" }, ow, oh, args.fps, priority, encoder.refused
    ));

    // Control from the app on stdin.
    let quit = Arc::new(AtomicBool::new(false));
    let want_key = Arc::new(AtomicBool::new(false));
    let new_rate = Arc::new(AtomicU32::new(0));
    {
        let (quit, want_key, new_rate) = (quit.clone(), want_key.clone(), new_rate.clone());
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                let mut parts = line.split_whitespace();
                match parts.next() {
                    Some("key") => want_key.store(true, Ordering::Relaxed),
                    Some("bitrate") => new_rate.store(parts.next().and_then(|v| v.parse().ok()).unwrap_or(0), Ordering::Relaxed),
                    Some("quit") => break,
                    _ => {}
                }
            }
            quit.store(true, Ordering::Relaxed); // stdin closed: the app is gone
        });
    }

    let mut out: Box<dyn Write> = match &args.out {
        Some(path) => Box::new(std::io::BufWriter::new(std::fs::File::create(path).map_err(|e| windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32), e.to_string()))?)),
        None => Box::new(std::io::BufWriter::new(std::io::stdout().lock())),
    };

    let started = Instant::now();
    let mut inflight: VecDeque<usize> = VecDeque::new();
    let mut pushed_at: VecDeque<Instant> = VecDeque::new();
    let (mut delay_sum, mut delay_n) = (0f64, 0u32);
    let mut frames = Vec::new();
    let mut first_time: Option<i64> = None;
    let (mut encoded, mut bytes, mut keys) = (0u64, 0u64, 0u64);
    let mut last_stats = Instant::now();
    let (mut last_cap, mut last_enc, mut last_bytes) = (0u64, 0u64, 0u64);

    while !quit.load(Ordering::Relaxed) && (args.seconds == 0 || started.elapsed() < Duration::from_secs(args.seconds)) {
        encoder.poll(&mut frames)?;
        for f in frames.drain(..) {
            // One output per input, in order: the oldest texture is free again.
            if let Some(slot) = inflight.pop_front() {
                free.lock().unwrap().push_back(slot);
            }
            if let Some(at) = pushed_at.pop_front() {
                delay_sum += at.elapsed().as_secs_f64() * 1000.0;
                delay_n += 1;
            }
            let t0 = *first_time.get_or_insert(f.time);
            let mut header = [0u8; 20];
            header[0..4].copy_from_slice(&(f.data.len() as u32).to_le_bytes());
            header[4] = f.key as u8;
            header[5] = encoder.codec.id();
            header[6..8].copy_from_slice(&(ow as u16).to_le_bytes());
            header[8..10].copy_from_slice(&(oh as u16).to_le_bytes());
            header[12..20].copy_from_slice(&(((f.time - t0).max(0) / 10) as u64).to_le_bytes());
            if out.write_all(&header).and_then(|_| out.write_all(&f.data)).and_then(|_| out.flush()).is_err() {
                return Ok(()); // the app closed the pipe
            }
            encoded += 1;
            bytes += f.data.len() as u64;
            keys += f.key as u64;
        }
        if want_key.swap(false, Ordering::Relaxed) {
            encoder.force_keyframe();
        }
        let r = new_rate.swap(0, Ordering::Relaxed);
        if r > 0 {
            encoder.set_bitrate(r);
        }
        if encoder.wants_input() {
            match rx.recv_timeout(Duration::from_millis(2)) {
                Ok((slot, time)) => {
                    let texture = converter.0.targets[slot].0.clone();
                    encoder.push(&texture, time)?;
                    inflight.push_back(slot);
                    pushed_at.push_back(Instant::now());
                    // An encoder that skipped a frame never answers for it: don't hold textures forever.
                    while inflight.len() > RING - 1 {
                        if let Some(s) = inflight.pop_front() {
                            free.lock().unwrap().push_back(s);
                            pushed_at.pop_front();
                        }
                    }
                }
                Err(_) => {}
            }
        } else {
            std::thread::sleep(Duration::from_micros(500));
        }
        if last_stats.elapsed() >= Duration::from_secs(1) {
            let secs = last_stats.elapsed().as_secs_f64();
            let cap = captured.load(Ordering::Relaxed);
            event(format!(
                "{{\"event\":\"stats\",\"captureFps\":{:.0},\"encodeFps\":{:.0},\"mbps\":{:.1},\"dropped\":{},\"keyframes\":{},\"encodeMs\":{:.1},\"inFlight\":{}}}",
                (cap - last_cap) as f64 / secs,
                (encoded - last_enc) as f64 / secs,
                (bytes - last_bytes) as f64 * 8.0 / secs / 1e6,
                dropped.load(Ordering::Relaxed),
                keys,
                if delay_n > 0 { delay_sum / delay_n as f64 } else { 0.0 },
                inflight.len()
            ));
            delay_sum = 0.0;
            delay_n = 0;
            last_cap = cap;
            last_enc = encoded;
            last_bytes = bytes;
            last_stats = Instant::now();
        }
    }
    encoder.finish();
    let _ = out.flush();
    Ok(())
}
