// Windows Graphics Capture: the screen or a window as Direct3D 11 textures on our
// device, delivered on a capture thread as soon as Windows composes them.
use windows::core::{factory, IInspectable, Interface, Result};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, MonitorFromPoint, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use crate::gpu::Gpu;

pub enum Target {
    Primary,
    Monitor(usize),
    Point(i32, i32), // the monitor showing this point (physical pixels)
    Window(isize),
}

/// The monitor this target means (None for a window).
pub fn monitor_of(target: &Target) -> Option<HMONITOR> {
    match target {
        Target::Primary => Some(unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) }),
        Target::Point(x, y) => Some(unsafe { MonitorFromPoint(POINT { x: *x, y: *y }, MONITOR_DEFAULTTONEAREST) }),
        Target::Monitor(i) => {
            let list = monitors();
            list.get(*i).or(list.first()).copied()
        }
        Target::Window(_) => None,
    }
}

pub fn monitors() -> Vec<HMONITOR> {
    unsafe extern "system" fn add(m: HMONITOR, _: HDC, _: *mut RECT, list: LPARAM) -> BOOL {
        (*(list.0 as *mut Vec<HMONITOR>)).push(m);
        true.into()
    }
    let mut list: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(HDC::default(), None, Some(add), LPARAM(&mut list as *mut _ as isize));
    }
    list
}

pub fn item(target: &Target) -> Result<GraphicsCaptureItem> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    unsafe {
        match target {
            Target::Window(h) => interop.CreateForWindow(HWND(*h as *mut _)),
            other => interop.CreateForMonitor(monitor_of(other).unwrap()),
        }
    }
}

pub struct Capture {
    pub session: GraphicsCaptureSession,
    pub pool: Direct3D11CaptureFramePool,
    pub width: u32,
    pub height: u32,
}

/// on_frame(texture, capture time in 100 ns units, content width, content height)
/// runs on the capture thread; the texture is only valid during the call.
pub fn start<F>(gpu: &Gpu, item: &GraphicsCaptureItem, on_frame: F) -> Result<Capture>
where
    F: FnMut(&ID3D11Texture2D, i64, u32, u32) + Send + 'static,
{
    let dxgi: IDXGIDevice = gpu.device.cast()?;
    let inspectable: IInspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? };
    let device: IDirect3DDevice = inspectable.cast()?;
    let size = item.Size()?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, size)?;
    let session = pool.CreateCaptureSession(item)?;
    // Not on every Windows version; without them the yellow border and no cursor change stay as they are.
    let _ = session.SetIsBorderRequired(false);
    let _ = session.SetIsCursorCaptureEnabled(true);
    let mut on_frame = on_frame;
    pool.FrameArrived(&TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(move |pool, _| {
        let Some(pool) = pool.as_ref() else { return Ok(()) };
        let frame = pool.TryGetNextFrame()?;
        let time = frame.SystemRelativeTime()?.Duration;
        let content = frame.ContentSize()?;
        let surface = frame.Surface()?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
        let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };
        on_frame(&texture, time, content.Width.max(2) as u32, content.Height.max(2) as u32);
        frame.Close()?;
        Ok(())
    }))?;
    session.StartCapture()?;
    Ok(Capture { session, pool, width: size.Width as u32, height: size.Height as u32 })
}

impl Capture {
    pub fn stop(&self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}
