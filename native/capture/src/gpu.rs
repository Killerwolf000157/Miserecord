// The Direct3D 11 device everything runs on: capture, colour conversion and the
// hardware encoder share it, so frames never leave the graphics card.
use windows::core::{Interface, Result};
use windows::Win32::Foundation::{HANDLE, HMODULE, LUID};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIDevice, IDXGIFactory6, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
};
use windows::Win32::System::Threading::{GetCurrentProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS};

pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub luid: LUID,
    pub name: String,
}

// COM pointers moved between our own threads; Direct3D 11 is free-threaded with
// multithread protection on, and Media Foundation objects are used from one thread.
pub struct Sendable<T>(pub T);
unsafe impl<T> Send for Sendable<T> {}
unsafe impl<T> Sync for Sendable<T> {}

/// The high-performance graphics card: on a gaming laptop the separate NVIDIA or
/// AMD chip, which is also where the game runs and where NVENC/AMF live.
pub fn create() -> Result<Gpu> {
    unsafe {
        let factory: IDXGIFactory6 = CreateDXGIFactory1()?;
        let adapter: IDXGIAdapter1 = factory.EnumAdapterByGpuPreference(0, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE)?;
        create_on(&adapter)
    }
}

/// A device on this particular adapter (the one driving the captured monitor).
pub fn create_on(adapter: &IDXGIAdapter1) -> Result<Gpu> {
    unsafe {
        let desc = adapter.GetDesc1()?;
        let name = String::from_utf16_lossy(&desc.Description).trim_end_matches('\0').trim().to_string();
        let mut device = None;
        let mut context = None;
        D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
        let device = device.unwrap();
        let context = context.unwrap();
        // Capture callbacks, the converter and the encoder use the device from different threads.
        let mt: ID3D11Multithread = device.cast()?;
        let _ = mt.SetMultithreadProtected(true);
        Ok(Gpu { device, context, luid: desc.AdapterLuid, name })
    }
}

#[link(name = "gdi32")]
extern "system" {
    fn D3DKMTSetProcessSchedulingPriorityClass(process: HANDLE, priority: i32) -> i32;
}

/// Ask Windows to schedule our GPU work ahead of normal apps (a game using the
/// whole card), the way OBS does. HIGH works without administrator rights;
/// REALTIME would need them. Returns what was granted, for the log.
pub fn raise_priority(gpu: &Gpu) -> String {
    let mut got = Vec::new();
    unsafe {
        const HIGH: i32 = 4;
        if D3DKMTSetProcessSchedulingPriorityClass(GetCurrentProcess(), HIGH) == 0 {
            got.push("gpu scheduling high");
        }
        if let Ok(dxgi) = gpu.device.cast::<IDXGIDevice>() {
            if dxgi.SetGPUThreadPriority(7).is_ok() {
                got.push("gpu thread +7");
            }
        }
        if SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS).is_ok() {
            got.push("cpu above normal");
        }
    }
    got.join(", ")
}
