// BGRA capture -> NV12 for the encoder, scaled to the stream size, in one pass of
// the GPU's video processor. A small ring of NV12 textures lets the capture run
// ahead of the encoder by a frame or two without overwriting one in use.
// Copy mode skips the conversion: when the stream is the screen's own size and the
// encoder takes BGRA itself (NVIDIA's do), frames are only copied into the ring,
// which is far less work for a graphics card a game keeps busy.
use std::mem::ManuallyDrop;

use windows::core::Result;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM,
    DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::core::Interface;

use crate::gpu::Gpu;

pub struct Converter {
    process: Option<Process>, // None: copy mode
    context: ID3D11DeviceContext,
    pub targets: Vec<ID3D11Texture2D>,
    pub width: u32,
    pub height: u32,
}

struct Process {
    vctx: ID3D11VideoContext1,
    vdev: ID3D11VideoDevice,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    views: Vec<ID3D11VideoProcessorOutputView>,
}

fn ring_texture(gpu: &Gpu, w: u32, h: u32, format: DXGI_FORMAT) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut tex = None;
    unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut tex))? };
    Ok(tex.unwrap())
}

impl Converter {
    pub fn new(gpu: &Gpu, in_w: u32, in_h: u32, out_w: u32, out_h: u32, ring: usize) -> Result<Converter> {
        Self::with_input(gpu, in_w, in_h, out_w, out_h, ring, false)
    }

    /// Copy mode: BGRA ring textures of the capture's size, filled by plain copies.
    pub fn copier(gpu: &Gpu, w: u32, h: u32, ring: usize) -> Result<Converter> {
        let targets = (0..ring).map(|_| ring_texture(gpu, w, h, DXGI_FORMAT_B8G8R8A8_UNORM)).collect::<Result<Vec<_>>>()?;
        Ok(Converter { process: None, context: gpu.context.clone(), targets, width: w, height: h })
    }


    /// input_yuv: the source is NV12 video (tests replaying saved frames), not screen RGB.
    pub fn with_input(gpu: &Gpu, in_w: u32, in_h: u32, out_w: u32, out_h: u32, ring: usize, input_yuv: bool) -> Result<Converter> {
        unsafe {
            let vdev: ID3D11VideoDevice = gpu.device.cast()?;
            let vctx: ID3D11VideoContext1 = gpu.context.cast()?;
            let rate = DXGI_RATIONAL { Numerator: 60, Denominator: 1 };
            let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: rate,
                InputWidth: in_w,
                InputHeight: in_h,
                OutputFrameRate: rate,
                OutputWidth: out_w,
                OutputHeight: out_h,
                Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
            };
            let enumerator = vdev.CreateVideoProcessorEnumerator(&desc)?;
            let processor = vdev.CreateVideoProcessor(&enumerator, 0)?;
            // Screen pixels are full-range RGB; encoders expect studio-range BT.709.
            vctx.VideoProcessorSetStreamColorSpace1(&processor, 0, if input_yuv { DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709 } else { DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709 });
            vctx.VideoProcessorSetOutputColorSpace1(&processor, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
            vctx.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            let mut targets = Vec::with_capacity(ring);
            let mut views = Vec::with_capacity(ring);
            for _ in 0..ring {
                let tex = ring_texture(gpu, out_w, out_h, DXGI_FORMAT_NV12)?;
                let vdesc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
                };
                let mut view = None;
                vdev.CreateVideoProcessorOutputView(&tex, &enumerator, &vdesc, Some(&mut view))?;
                views.push(view.unwrap());
                targets.push(tex);
            }
            Ok(Converter {
                process: Some(Process { vctx, vdev, enumerator, processor, views }),
                context: gpu.context.clone(),
                targets,
                width: out_w,
                height: out_h,
            })
        }
    }

    /// Convert the captured content (content_w x content_h of src) into ring slot
    /// `slot`, letterboxed to keep its shape.
    pub fn convert(&self, src: &ID3D11Texture2D, content_w: u32, content_h: u32, slot: usize) -> Result<()> {
        let Some(p) = &self.process else {
            unsafe {
                self.context.CopyResource(&self.targets[slot], src);
                self.context.Flush();
            }
            return Ok(());
        };
        unsafe {
            let ivdesc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
            };
            let mut input = None;
            p.vdev.CreateVideoProcessorInputView(src, &p.enumerator, &ivdesc, Some(&mut input))?;
            let src_rect = RECT { left: 0, top: 0, right: content_w as i32, bottom: content_h as i32 };
            p.vctx.VideoProcessorSetStreamSourceRect(&p.processor, 0, true, Some(&src_rect));
            // Fit inside the output, centred.
            let scale = f64::min(self.width as f64 / content_w as f64, self.height as f64 / content_h as f64);
            let w = ((content_w as f64 * scale) as i32) & !1;
            let h = ((content_h as f64 * scale) as i32) & !1;
            let x = ((self.width as i32 - w) / 2) & !1;
            let y = ((self.height as i32 - h) / 2) & !1;
            let dst = RECT { left: x, top: y, right: x + w, bottom: y + h };
            p.vctx.VideoProcessorSetStreamDestRect(&p.processor, 0, true, Some(&dst));
            let target = RECT { left: 0, top: 0, right: self.width as i32, bottom: self.height as i32 };
            p.vctx.VideoProcessorSetOutputTargetRect(&p.processor, true, Some(&target));
            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                OutputIndex: 0,
                InputFrameOrField: 0,
                PastFrames: 0,
                FutureFrames: 0,
                ppPastSurfaces: std::ptr::null_mut(),
                pInputSurface: ManuallyDrop::new(input),
                ppFutureSurfaces: std::ptr::null_mut(),
                ppPastSurfacesRight: std::ptr::null_mut(),
                pInputSurfaceRight: ManuallyDrop::new(None),
                ppFutureSurfacesRight: std::ptr::null_mut(),
            };
            let streams = [stream];
            let result = p.vctx.VideoProcessorBlt(&p.processor, &p.views[slot], 0, &streams);
            let [mut stream] = streams;
            ManuallyDrop::drop(&mut stream.pInputSurface);
            // The encoder reads this texture next: make sure the conversion is queued first.
            self.context.Flush();
            result
        }
    }
}
