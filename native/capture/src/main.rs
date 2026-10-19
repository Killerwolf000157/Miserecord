// miserecord-capture: Miserecord's native screen capture and hardware encoder.
//
//   miserecord-capture --probe
//       prints {"adapter": ..., "codecs": ["AV1", "H264"]} and exits
//   miserecord-capture [--monitor N|primary | --point X,Y | --window HWND] [--codec auto|av1|h264]
//                      [--width 2560] [--height 1440] [--fps 60] [--bitrate 8000000]
//                      [--seconds N] [--out FILE]
//       streams encoded frames to stdout (or FILE), each as a 20-byte header
//       (u32 length, u8 flags: 1 = keyframe, u8 codec: 1 = H.264, 2 = AV1,
//       u16 width, u16 height, u16 0, u64 capture time in microseconds, all
//       little-endian) and the payload (Annex B for H.264, OBUs for AV1).
//       stdin takes lines: "key", "bitrate N", "size W H FPS" (a new stream size
//       and frame rate, live), "quit".
//       stderr gets one JSON line per event: ready, stats (every second), error.
//
// See docs/native-engine.md.
mod capture;
mod convert;
mod cursor;
mod dup;
mod encode;
mod gpu;

use std::collections::VecDeque;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
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
    dump: Option<String>, // test: save the Y plane of frames 60..60+N as they enter the encoder
    dump_frames: usize,
    replay: Option<String>, // test: encode frames saved with --dump instead of capturing
    scale: Option<(u32, u32)>, // test: replay at this size
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
        dump: None,
        dump_frames: 90,
        replay: None,
        scale: None,
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
            "--point" => {
                let s = v();
                let mut p = s.split(',').map(|n| n.trim().parse::<i32>().unwrap_or(0));
                a.target = capture::Target::Point(p.next().unwrap_or(0), p.next().unwrap_or(0));
            }
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
            "--dump" => a.dump = Some(v()),
            "--dump-frames" => a.dump_frames = v().parse().unwrap_or(90),
            "--replay" => a.replay = Some(v()),
            "--scale" => {
                let w = v().parse().unwrap_or(1280);
                let h = it.next().and_then(|x| x.parse().ok()).unwrap_or(720);
                a.scale = Some((w, h));
            }
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

// Test-only: an NV12 texture (luma rows, then the interleaved chroma rows) read
// back to a file.
fn dump_nv12(gpu: &gpu::Gpu, tex: &windows::Win32::Graphics::Direct3D11::ID3D11Texture2D, w: u32, h: u32, path: &str) -> windows::core::Result<()> {
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
    unsafe {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w, Height: h, MipLevels: 1, ArraySize: 1, Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 }, Usage: D3D11_USAGE_STAGING,
            BindFlags: 0, CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32, MiscFlags: 0,
        };
        let mut staging = None;
        gpu.device.CreateTexture2D(&desc, None, Some(&mut staging))?;
        let staging = staging.unwrap();
        gpu.context.CopyResource(&staging, tex);
        let mut map = D3D11_MAPPED_SUBRESOURCE::default();
        gpu.context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut map))?;
        let mut y = Vec::with_capacity((w * h * 3 / 2) as usize);
        for row in 0..(h * 3 / 2) as usize {
            let p = (map.pData as *const u8).add(row * map.RowPitch as usize);
            y.extend_from_slice(std::slice::from_raw_parts(p, w as usize));
        }
        gpu.context.Unmap(&staging, 0);
        let _ = std::fs::write(path, y);
    }
    Ok(())
}

// Test-only: encode frames saved with --dump, the same clip for every setting
// compared, to the --out file; prints average encode time.
fn replay(args: &Args, dir: &str) -> windows::core::Result<()> {
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
    let meta = std::fs::read_to_string(format!("{dir}/size.txt")).unwrap_or_default();
    let n: Vec<u32> = meta.split_whitespace().filter_map(|v| v.parse().ok()).collect();
    let (w, h, fps) = (n[0], n[1], n[2]);
    let mut files: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().map(|x| x == "nv12").unwrap_or(false)).collect();
    files.sort();
    let gpu = gpu::create()?;
    let codec = args.codec.unwrap_or(Codec::H264);
    let (ew, eh) = args.scale.unwrap_or((w, h));
    let scaler = if (ew, eh) != (w, h) { Some(convert::Converter::with_input(&gpu, w, h, ew, eh, RING, true)?) } else { None };
    let Some(mut encoder) = Encoder::new(&gpu, codec, ew, eh, fps, args.bitrate)? else {
        return Err(windows::core::Error::new(windows::core::HRESULT(0x80004001u32 as i32), "no encoder"));
    };
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w, Height: h, MipLevels: 1, ArraySize: 1, Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 }, Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32, CPUAccessFlags: 0, MiscFlags: 0,
    };
    let mut ring = Vec::new();
    for _ in 0..RING {
        let mut t = None;
        unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut t))? };
        ring.push(t.unwrap());
    }
    let mut out = std::io::BufWriter::new(std::fs::File::create(args.out.clone().unwrap_or("NUL".into())).unwrap());
    let interval = 10_000_000 / fps as i64;
    let (mut next, mut done, mut ms) = (0usize, 0usize, 0f64);
    let mut frames = Vec::new();
    let mut pushed: VecDeque<Instant> = VecDeque::new();
    let started = Instant::now();
    let mut drained = false;
    while done < files.len() && started.elapsed() < Duration::from_secs(60) {
        if next == files.len() && !drained {
            encoder.finish();
            drained = true;
        }
        encoder.poll(&mut frames)?;
        for f in frames.drain(..) {
            if let Some(at) = pushed.pop_front() { ms += at.elapsed().as_secs_f64() * 1000.0; }
            let mut header = [0u8; 20];
            header[0..4].copy_from_slice(&(f.data.len() as u32).to_le_bytes());
            header[4] = f.key as u8;
            header[5] = codec.id();
            header[6..8].copy_from_slice(&(ew as u16).to_le_bytes());
            header[8..10].copy_from_slice(&(eh as u16).to_le_bytes());
            header[12..20].copy_from_slice(&((f.time / 10) as u64).to_le_bytes());
            out.write_all(&header).unwrap();
            out.write_all(&f.data).unwrap();
            done += 1;
        }
        if next < files.len() && encoder.wants_input() {
            let data = std::fs::read(&files[next]).unwrap();
            let tex = &ring[next % RING];
            unsafe { gpu.context.UpdateSubresource(tex, 0, None, data.as_ptr() as *const _, w, 0) };
            match &scaler {
                Some(s) => {
                    s.convert(tex, w, h, next % RING)?;
                    encoder.push(&s.targets[next % RING].0, next as i64 * interval)?;
                }
                None => encoder.push(tex, next as i64 * interval)?,
            }
            pushed.push_back(Instant::now());
            next += 1;
        } else {
            std::thread::sleep(Duration::from_micros(200));
        }
    }
    let _ = out.flush();
    println!("{{\"frames\":{},\"encodeMs\":{:.2},\"encoder\":\"{}\",\"refused\":\"{}\"}}", done, ms / done.max(1) as f64, esc(&encoder.name), encoder.refused);
    Ok(())
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

    if let Some(dir) = &args.replay {
        return replay(&args, dir);
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
    let fit = |bw: u32, bh: u32| {
        let scale = f64::min(1.0, f64::min(bw as f64 / cw as f64, bh as f64 / ch as f64));
        (((cw as f64 * scale) as u32) & !1, ((ch as f64 * scale) as u32) & !1)
    };
    let (mut ow, mut oh) = fit(args.width, args.height);
    let mut fps = args.fps;
    let mut bitrate = args.bitrate; // what the app asked for
    // The encoder's real output over its target (AV1 overshot by ~40%): the target
    // given to the encoder is divided by this, so what goes out matches the app's.
    let mut overshoot = 1.0f64;
    let mut commanded = bitrate;

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

    // Swapped for a new one when the stream changes size; capture skips frames meanwhile.
    let converter: Arc<Mutex<Sendable<Option<convert::Converter>>>> =
        Arc::new(Mutex::new(Sendable(Some(convert::Converter::new(&gpu, cw, ch, ow, oh, RING)?))));
    let free: Arc<Mutex<VecDeque<usize>>> = Arc::new(Mutex::new((0..RING).collect()));
    let (tx, rx) = mpsc::channel::<(usize, i64)>();
    let captured = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicU64::new(0));
    let interval = Arc::new(AtomicI64::new(10_000_000 / args.fps as i64)); // 100 ns units

    {
        let converter = converter.clone();
        let free = free.clone();
        let captured = captured.clone();
        let dropped = dropped.clone();
        let mut due: i64 = i64::MIN / 2;
        let interval = interval.clone();
        let on_frame = move |texture: &windows::Win32::Graphics::Direct3D11::ID3D11Texture2D, time: i64, w: u32, h: u32| {
            let interval = interval.load(Ordering::Relaxed);
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
            let ok = match converter.lock().unwrap().0.as_ref() {
                Some(c) => c.convert(texture, w.min(cw), h.min(ch), slot).is_ok(),
                None => false,
            };
            if ok {
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
    let new_size: Arc<Mutex<Option<(u32, u32, u32)>>> = Arc::new(Mutex::new(None));
    {
        let (quit, want_key, new_rate, new_size) = (quit.clone(), want_key.clone(), new_rate.clone(), new_size.clone());
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                let mut parts = line.split_whitespace();
                match parts.next() {
                    Some("key") => want_key.store(true, Ordering::Relaxed),
                    Some("bitrate") => new_rate.store(parts.next().and_then(|v| v.parse().ok()).unwrap_or(0), Ordering::Relaxed),
                    Some("size") => {
                        let n: Vec<u32> = parts.filter_map(|v| v.parse().ok()).collect();
                        if n.len() == 3 && n[0] >= 160 && n[1] >= 90 && n[2] >= 1 {
                            *new_size.lock().unwrap() = Some((n[0], n[1], n[2].min(240)));
                        }
                    }
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
    let mut pushes: u64 = 0;
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
            bitrate = r;
            commanded = (bitrate as f64 / overshoot) as u32;
            encoder.set_bitrate(commanded);
        }
        // A new size or frame rate: a fresh converter and encoder, then a keyframe.
        let resize = new_size.lock().unwrap().take();
        if let Some((w, h, f)) = resize {
            let (nw, nh) = fit(w, h);
            if (nw, nh, f) != (ow, oh, fps) {
                let codec = encoder.codec;
                converter.lock().unwrap().0 = None;
                while rx.try_recv().is_ok() {}
                inflight.clear();
                pushed_at.clear();
                *free.lock().unwrap() = (0..RING).collect();
                encoder.finish();
                match Encoder::new(&gpu, codec, nw, nh, f, commanded)? {
                    Some(e) => encoder = e,
                    None => return Err(windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32), "encoder lost on resize")),
                }
                converter.lock().unwrap().0 = Some(convert::Converter::new(&gpu, cw, ch, nw, nh, RING)?);
                interval.store(10_000_000 / f as i64, Ordering::Relaxed);
                (ow, oh, fps) = (nw, nh, f);
                event(format!("{{\"event\":\"resized\",\"width\":{},\"height\":{},\"fps\":{}}}", ow, oh, fps));
            }
        }
        if encoder.wants_input() {
            match rx.recv_timeout(Duration::from_millis(2)) {
                Ok((slot, time)) => {
                    let texture = match converter.lock().unwrap().0.as_ref() {
                        Some(c) => c.targets[slot].0.clone(),
                        None => continue,
                    };
                    if let Some(dir) = &args.dump {
                        if pushes >= 60 && pushes < 60 + args.dump_frames as u64 {
                            dump_nv12(&gpu, &texture, ow, oh, &format!("{dir}/f_{:04}.nv12", pushes - 60))?;
                            let _ = std::fs::write(format!("{dir}/size.txt"), format!("{ow} {oh} {fps}"));
                        }
                    }
                    pushes += 1;
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
            // Only judge overshoot on a busy picture (a still screen sends far less).
            let actual = (bytes - last_bytes) as f64 * 8.0 / secs;
            if actual > commanded as f64 * 0.7 {
                overshoot = (overshoot * 0.7 + (actual / commanded as f64) * 0.3).clamp(1.0, 2.0);
                let next = (bitrate as f64 / overshoot) as u32;
                if (next as f64 - commanded as f64).abs() / commanded as f64 > 0.05 {
                    commanded = next;
                    encoder.set_bitrate(commanded);
                }
            }
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
