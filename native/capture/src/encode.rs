// The hardware video encoder (NVIDIA NVENC, AMD AMF, Intel Quick Sync) through
// Media Foundation, fed NV12 textures straight from the GPU.
use std::mem::ManuallyDrop;

use windows::core::{Interface, Result, GUID, PWSTR, VARIANT};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;

use crate::gpu::Gpu;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Codec {
    Av1,
    H264,
}

impl Codec {
    fn subtype(self) -> GUID {
        match self {
            Codec::Av1 => MFVideoFormat_AV1,
            Codec::H264 => MFVideoFormat_H264,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Codec::Av1 => "AV1",
            Codec::H264 => "H264",
        }
    }
    pub fn id(self) -> u8 {
        match self {
            Codec::Av1 => 2,
            Codec::H264 => 1,
        }
    }
}

pub struct Encoded {
    pub data: Vec<u8>,
    pub key: bool,
    pub time: i64, // 100 ns units
}

pub struct Encoder {
    mft: IMFTransform,
    events: IMFMediaEventGenerator,
    api: Option<ICodecAPI>,
    _manager: IMFDXGIDeviceManager,
    pub codec: Codec,
    pub name: String,
    pub refused: String, // encoder settings this encoder didn't take
    fps: u32,
    pending_inputs: u32, // how many METransformNeedInput we owe
}

/// The first hardware encoder for this codec on our graphics card, and its name.
fn find(gpu: &Gpu, codec: Codec) -> Result<Option<(IMFActivate, String)>> {
    unsafe {
        let out = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: codec.subtype() };
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 1)?;
        let attrs = attrs.unwrap();
        let luid = gpu.luid;
        let bytes = std::slice::from_raw_parts(&luid as *const _ as *const u8, std::mem::size_of_val(&luid));
        attrs.SetBlob(&MFT_ENUM_ADAPTER_LUID, bytes)?;
        let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        MFTEnum2(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            None,
            Some(&out),
            &attrs,
            &mut list,
            &mut count,
        )?;
        if list.is_null() || count == 0 {
            return Ok(None);
        }
        let items = std::slice::from_raw_parts_mut(list, count as usize);
        let first = items[0].take();
        for item in items.iter_mut() {
            drop(item.take());
        }
        CoTaskMemFree(Some(list as *const _));
        let Some(first) = first else { return Ok(None) };
        let mut name = PWSTR::null();
        let mut len = 0u32;
        let label = if first.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len).is_ok() {
            let s = name.to_string().unwrap_or_default();
            CoTaskMemFree(Some(name.0 as *const _));
            s
        } else {
            String::from("hardware encoder")
        };
        Ok(Some((first, label)))
    }
}

/// Which of the wanted codecs this graphics card can encode in hardware, best first.
pub fn available(gpu: &Gpu) -> Vec<Codec> {
    [Codec::Av1, Codec::H264].into_iter().filter(|c| matches!(find(gpu, *c), Ok(Some(_)))).collect()
}

/// Test: the input pixel formats this card's encoder for a codec accepts.
pub fn input_formats(gpu: &Gpu, codec: Codec) -> Result<Vec<String>> {
    let Some((activate, _)) = find(gpu, codec)? else { return Ok(vec![]) };
    unsafe {
        let mft: IMFTransform = activate.ActivateObject()?;
        let _ = mft.GetAttributes()?.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1);
        let output = MFCreateMediaType()?;
        output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        output.SetGUID(&MF_MT_SUBTYPE, &codec.subtype())?;
        output.SetUINT32(&MF_MT_AVG_BITRATE, 8_000_000)?;
        output.SetUINT64(&MF_MT_FRAME_SIZE, pack(1920, 1080))?;
        output.SetUINT64(&MF_MT_FRAME_RATE, pack(60, 1))?;
        output.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        mft.SetOutputType(0, &output, 0)?;
        let names = [
            (MFVideoFormat_NV12, "NV12"), (MFVideoFormat_ARGB32, "ARGB32"), (MFVideoFormat_RGB32, "RGB32"),
            (MFVideoFormat_AYUV, "AYUV"), (MFVideoFormat_YUY2, "YUY2"), (MFVideoFormat_IYUV, "IYUV"),
            (MFVideoFormat_P010, "P010"), (MFVideoFormat_A2R10G10B10, "A2R10G10B10"),
        ];
        let mut out = Vec::new();
        let mut i = 0;
        while let Ok(t) = mft.GetInputAvailableType(0, i) {
            let sub = t.GetGUID(&MF_MT_SUBTYPE)?;
            out.push(names.iter().find(|(g, _)| *g == sub).map(|(_, n)| n.to_string()).unwrap_or(format!("{sub:?}")));
            i += 1;
        }
        Ok(out)
    }
}

fn pack(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

impl Encoder {
    /// argb: the input is BGRA frames (copy mode) instead of NV12.
    pub fn new(gpu: &Gpu, codec: Codec, width: u32, height: u32, fps: u32, bitrate: u32, argb: bool) -> Result<Option<Encoder>> {
        let Some((activate, name)) = find(gpu, codec)? else { return Ok(None) };
        unsafe {
            let mft: IMFTransform = activate.ActivateObject()?;
            let attrs = mft.GetAttributes()?;
            // Hardware encoders are asynchronous: they ask for input and announce output with events.
            attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
            let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);

            let mut token = 0u32;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
            let manager = manager.unwrap();
            manager.ResetDevice(&gpu.device, token)?;
            mft.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;

            // Streaming settings, before the formats (some encoders only take rate
            // control then): low latency, steady bitrate, no B-frames, a keyframe every 4 s.
            let api: Option<ICodecAPI> = mft.cast().ok();
            let mut refused = Vec::new();
            if let Some(api) = &api {
                // MR_* variables: test-only overrides for quality measurements.
                let env = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<u32>().ok());
                // Quality preset by size: the best one up to 1080p, the middle one at 1440p,
                // the fastest beyond, which keeps every size well inside 60 fps (measured:
                // ~5 ms a frame at 1080p on the best). Worth ~0.2 dB at the same bitrate.
                let pixels = width * height;
                let speed = env("MR_SPEED").unwrap_or(if pixels <= 1920 * 1080 { 100 } else if pixels <= 2560 * 1440 { 50 } else { 0 });
                let rc = env("MR_RC").unwrap_or(eAVEncCommonRateControlMode_CBR.0 as u32);
                let mut extra: Vec<(&GUID, VARIANT, &str)> = Vec::new();
                if let Some(q) = env("MR_MAXQP") { extra.push((&CODECAPI_AVEncVideoMaxQP, VARIANT::from(q), "max qp")); }
                if let Some(q) = env("MR_MINQP") { extra.push((&CODECAPI_AVEncVideoMinQP, VARIANT::from(q), "min qp")); }
                let settings: [(&GUID, VARIANT, &str); 8] = [
                    (&CODECAPI_AVLowLatencyMode, VARIANT::from(true), "low latency"),
                    (&CODECAPI_AVEncCommonRateControlMode, VARIANT::from(rc), "rate control"),
                    (&CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(bitrate), "bitrate"),
                    (&CODECAPI_AVEncCommonMaxBitRate, VARIANT::from(bitrate), "max bitrate"),
                    // Half a second of buffer: steady enough for the line, small enough for low delay.
                    (&CODECAPI_AVEncCommonBufferSize, VARIANT::from(bitrate / 2), "buffer"),
                    // A keyframe every 10 s: on a slow upload each one is a hiccup, and lost
                    // pictures are healed by keyframes on request anyway.
                    (&CODECAPI_AVEncMPVGOPSize, VARIANT::from(fps * 10), "gop"),
                    (&CODECAPI_AVEncMPVDefaultBPictureCount, VARIANT::from(0u32), "no b-frames"),
                    // Speed over squeezing every bit.
                    (&CODECAPI_AVEncCommonQualityVsSpeed, VARIANT::from(speed), "speed"),
                ];
                for (key, value, label) in settings.iter().chain(extra.iter()) {
                    if api.SetValue(*key, value).is_err() {
                        refused.push(*label);
                    }
                }
            }

            let output = MFCreateMediaType()?;
            output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            output.SetGUID(&MF_MT_SUBTYPE, &codec.subtype())?;
            output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
            output.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
            output.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            output.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            output.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            if codec == Codec::H264 {
                output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
            }
            mft.SetOutputType(0, &output, 0)?;

            let input = MFCreateMediaType()?;
            input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            input.SetGUID(&MF_MT_SUBTYPE, if argb { &MFVideoFormat_ARGB32 } else { &MFVideoFormat_NV12 })?;
            input.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
            input.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            input.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            mft.SetInputType(0, &input, 0)?;

            let events: IMFMediaEventGenerator = mft.cast()?;
            mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            Ok(Some(Encoder { mft, events, api, _manager: manager, codec, name, refused: refused.join(", "), fps, pending_inputs: 0 }))
        }
    }

    pub fn set_bitrate(&self, bitrate: u32) {
        if let Some(api) = &self.api {
            unsafe {
                let _ = api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bitrate));
                let _ = api.SetValue(&CODECAPI_AVEncCommonMaxBitRate, &VARIANT::from(bitrate));
            }
        }
    }

    pub fn force_keyframe(&self) {
        if let Some(api) = &self.api {
            unsafe {
                let _ = api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
            }
        }
    }

    /// Handle the encoder's queued events: count input requests, collect output.
    /// Returns as soon as there are no more events waiting.
    pub fn poll(&mut self, out: &mut Vec<Encoded>) -> Result<()> {
        loop {
            let event = match unsafe { self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(e) => e,
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(()),
                Err(e) => return Err(e),
            };
            let kind = unsafe { event.GetType()? };
            if kind == METransformNeedInput.0 as u32 {
                self.pending_inputs += 1;
            } else if kind == METransformHaveOutput.0 as u32 {
                if let Some(frame) = self.take_output()? {
                    out.push(frame);
                }
            }
        }
    }

    pub fn wants_input(&self) -> bool {
        self.pending_inputs > 0
    }

    pub fn push(&mut self, texture: &ID3D11Texture2D, time: i64) -> Result<()> {
        unsafe {
            let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false)?;
            let two_d: IMF2DBuffer = buffer.cast()?;
            buffer.SetCurrentLength(two_d.GetContiguousLength()?)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(time)?;
            sample.SetSampleDuration(10_000_000 / self.fps as i64)?;
            self.mft.ProcessInput(0, &sample, 0)?;
            self.pending_inputs -= 1;
            Ok(())
        }
    }

    fn take_output(&mut self) -> Result<Option<Encoded>> {
        unsafe {
            let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                pSample: ManuallyDrop::new(None),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            }];
            let mut status = 0u32;
            let result = self.mft.ProcessOutput(0, &mut buffers, &mut status);
            let [mut b] = buffers;
            let sample = ManuallyDrop::take(&mut b.pSample);
            ManuallyDrop::drop(&mut b.pEvents);
            if let Err(e) = result {
                if e.code() == MF_E_TRANSFORM_STREAM_CHANGE {
                    // The encoder changed its output format: take its new one and carry on.
                    let t = self.mft.GetOutputAvailableType(0, 0)?;
                    self.mft.SetOutputType(0, &t, 0)?;
                    return Ok(None);
                }
                if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT {
                    return Ok(None);
                }
                return Err(e);
            }
            let Some(sample) = sample else { return Ok(None) };
            let key = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0;
            let time = sample.GetSampleTime().unwrap_or(0);
            let buffer = sample.ConvertToContiguousBuffer()?;
            let mut ptr = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&mut ptr, None, Some(&mut len))?;
            let data = std::slice::from_raw_parts(ptr, len as usize).to_vec();
            buffer.Unlock()?;
            Ok(Some(Encoded { data, key, time }))
        }
    }

    pub fn finish(&self) {
        unsafe {
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
        }
    }
}
