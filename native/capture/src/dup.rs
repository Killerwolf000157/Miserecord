// DXGI Desktop Duplication: monitor capture that keeps delivering frames while a
// full-screen game is in front (Windows Graphics Capture mostly stops then, since
// such games bypass the desktop compositor). It runs on the graphics chip that
// drives the monitor, so on a laptop that's usually the built-in one, which also
// encodes the stream while the game has the NVIDIA or AMD card to itself.
use windows::core::{Interface, Result};
use windows::Win32::Foundation::LUID;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

use crate::gpu::{Gpu, Sendable};

/// The graphics adapter and output (connector) showing this monitor.
pub fn find_output(monitor: HMONITOR) -> Result<Option<(IDXGIAdapter1, IDXGIOutput1)>> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        let mut a = 0;
        while let Ok(adapter) = factory.EnumAdapters1(a) {
            let mut o = 0;
            while let Ok(output) = adapter.EnumOutputs(o) {
                if output.GetDesc()?.Monitor == monitor {
                    return Ok(Some((adapter, output.cast()?)));
                }
                o += 1;
            }
            a += 1;
        }
        Ok(None)
    }
}

pub fn adapter_luid(adapter: &IDXGIAdapter1) -> LUID {
    unsafe { adapter.GetDesc1().map(|d| d.AdapterLuid).unwrap_or_default() }
}

/// Capture on a thread of its own; on_frame gets a BGRA texture valid for the call.
pub fn start<F>(gpu: &Gpu, output: IDXGIOutput1, mut on_frame: F) -> Result<(u32, u32)>
where
    F: FnMut(&ID3D11Texture2D, i64, u32, u32) + Send + 'static,
{
    let desc = unsafe { output.GetDesc()? };
    let r = desc.DesktopCoordinates;
    let (w, h) = ((r.right - r.left) as u32, (r.bottom - r.top) as u32);
    let device = gpu.device.clone();
    let context = gpu.context.clone();
    // Our own copies of each frame: the duplicated surface is only lent until
    // ReleaseFrame. "clean" is the picture; "copy" is the picture with the pointer,
    // redrawn when only the pointer moves.
    let make = || unsafe {
        let tdesc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut t = None;
        device.CreateTexture2D(&tdesc, None, Some(&mut t))?;
        Ok::<ID3D11Texture2D, windows::core::Error>(t.unwrap())
    };
    let copy = make()?;
    let clean = make()?;
    let pointer = crate::cursor::Cursor::new(&copy).ok();
    let mut parts = Sendable((device, context, output, copy, clean, pointer));
    std::thread::spawn(move || {
        let (device, context, output, copy, clean, pointer) = &mut parts.0;
        let (device, context, output, copy, clean) = (&*device, &*context, &*output, &*copy, &*clean);
        let mut freq = 0i64;
        unsafe {
            let _ = QueryPerformanceFrequency(&mut freq);
        }
        let to_100ns = |qpc: i64| ((qpc as i128) * 10_000_000 / freq.max(1) as i128) as i64;
        loop {
            // (Re)start duplication: it's lost on resolution changes, UAC prompts and
            // games switching to exclusive full screen.
            let dup = match unsafe { output.DuplicateOutput(device) } {
                Ok(d) => d,
                Err(_) => {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    continue;
                }
            };
            loop {
                let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
                let mut resource = None;
                // Poll instead of waiting inside AcquireNextFrame: a waiting call holds the
                // device lock, which stalled the encoder (about 20 ms per frame).
                match unsafe { dup.AcquireNextFrame(0, &mut info, &mut resource) } {
                    Ok(()) => {}
                    Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        continue;
                    }
                    Err(_) => break,
                }
                // A new picture, or only the pointer moved (LastPresentTime 0): either
                // way the frame sent is the latest picture with the pointer on top.
                let new_picture = info.LastPresentTime != 0;
                let moved = info.LastMouseUpdateTime != 0;
                if let Some(p) = pointer.as_mut() {
                    p.update(&dup, &info);
                }
                if new_picture {
                    if let Some(Ok(tex)) = resource.as_ref().map(|r| r.cast::<ID3D11Texture2D>()) {
                        unsafe { context.CopyResource(clean, &tex) };
                    }
                }
                if new_picture || (moved && pointer.is_some()) {
                    unsafe { context.CopyResource(copy, clean) };
                    if let Some(p) = pointer.as_ref() {
                        p.draw();
                    }
                    let mut now = 0i64;
                    unsafe {
                        let _ = QueryPerformanceCounter(&mut now);
                    }
                    let t = if new_picture { info.LastPresentTime.max(now - freq) } else { now };
                    on_frame(copy, to_100ns(t), w, h);
                }
                drop(resource);
                unsafe {
                    let _ = dup.ReleaseFrame();
                }
            }
        }
    });
    Ok((w, h))
}
