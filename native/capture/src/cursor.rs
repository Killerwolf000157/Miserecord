// The mouse pointer for Desktop Duplication, which hands it over separately from
// the picture: its shape (colour, monochrome or masked) is turned into a
// premultiplied BGRA bitmap once per change and drawn on each frame with Direct2D.
use windows::core::{Interface, Result};
use windows::Win32::Graphics::Direct2D::Common::{D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT, D2D_RECT_F, D2D_SIZE_U};
use windows::Win32::Graphics::Direct2D::*;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Dxgi::*;

const MONOCHROME: u32 = 1;
const COLOR: u32 = 2;
const MASKED_COLOR: u32 = 4;

pub struct Cursor {
    target: ID2D1RenderTarget,
    bitmap: Option<ID2D1Bitmap>,
    size: (u32, u32),
    pub visible: bool,
    pub x: i32,
    pub y: i32,
}

impl Cursor {
    /// Draws onto `texture` (BGRA, render target).
    pub fn new(texture: &ID3D11Texture2D) -> Result<Cursor> {
        unsafe {
            let factory: ID2D1Factory = D2D1CreateFactory(D2D1_FACTORY_TYPE_MULTI_THREADED, None)?;
            let surface: IDXGISurface = texture.cast()?;
            let props = D2D1_RENDER_TARGET_PROPERTIES {
                r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
                pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED },
                dpiX: 96.0,
                dpiY: 96.0,
                ..Default::default()
            };
            let target = factory.CreateDxgiSurfaceRenderTarget(&surface, &props)?;
            Ok(Cursor { target, bitmap: None, size: (0, 0), visible: false, x: 0, y: 0 })
        }
    }

    /// Take the pointer position (and new shape, if any) from this frame.
    pub fn update(&mut self, dup: &IDXGIOutputDuplication, info: &DXGI_OUTDUPL_FRAME_INFO) {
        if info.LastMouseUpdateTime != 0 {
            self.visible = info.PointerPosition.Visible.as_bool();
            self.x = info.PointerPosition.Position.x;
            self.y = info.PointerPosition.Position.y;
        }
        if info.PointerShapeBufferSize == 0 {
            return;
        }
        let mut buf = vec![0u8; info.PointerShapeBufferSize as usize];
        let mut needed = 0u32;
        let mut shape = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
        if unsafe { dup.GetFramePointerShape(buf.len() as u32, buf.as_mut_ptr() as *mut _, &mut needed, &mut shape) }.is_err() {
            return;
        }
        let (w, pitch) = (shape.Width as usize, shape.Pitch as usize);
        // Monochrome shapes stack an AND mask on top of an XOR mask.
        let h = if shape.Type == MONOCHROME { shape.Height as usize / 2 } else { shape.Height as usize };
        let mut px = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let o = (y * w + x) * 4;
                let (b, g, r, a) = match shape.Type {
                    COLOR => {
                        let i = y * pitch + x * 4;
                        let a = buf[i + 3] as u32;
                        // premultiply
                        ((buf[i] as u32 * a / 255) as u8, (buf[i + 1] as u32 * a / 255) as u8, (buf[i + 2] as u32 * a / 255) as u8, a as u8)
                    }
                    MASKED_COLOR => {
                        let i = y * pitch + x * 4;
                        // Alpha 0: show the colour. 0xFF: XOR with the screen, which a
                        // bitmap can't do; drawn as the colour where it isn't black.
                        let (b, g, r) = (buf[i], buf[i + 1], buf[i + 2]);
                        if buf[i + 3] == 0 || (b | g | r) != 0 { (b, g, r, 255) } else { (0, 0, 0, 0) }
                    }
                    _ => {
                        let bit = 0x80u8 >> (x % 8);
                        let and = buf[y * pitch + x / 8] & bit != 0;
                        let xor = buf[(y + h) * pitch + x / 8] & bit != 0;
                        match (and, xor) {
                            (false, false) => (0, 0, 0, 255),
                            (false, true) => (255, 255, 255, 255),
                            (true, false) => (0, 0, 0, 0),
                            (true, true) => (0, 0, 0, 255), // "invert the screen": black reads best
                        }
                    }
                };
                px[o] = b;
                px[o + 1] = g;
                px[o + 2] = r;
                px[o + 3] = a;
            }
        }
        unsafe {
            let props = D2D1_BITMAP_PROPERTIES {
                pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED },
                dpiX: 96.0,
                dpiY: 96.0,
            };
            self.bitmap = self.target.CreateBitmap(D2D_SIZE_U { width: w as u32, height: h as u32 }, Some(px.as_ptr() as *const _), (w * 4) as u32, &props).ok();
        }
        self.size = (w as u32, h as u32);
    }

    pub fn draw(&self) {
        let Some(bitmap) = &self.bitmap else { return };
        if !self.visible {
            return;
        }
        let r = D2D_RECT_F { left: self.x as f32, top: self.y as f32, right: (self.x + self.size.0 as i32) as f32, bottom: (self.y + self.size.1 as i32) as f32 };
        unsafe {
            self.target.BeginDraw();
            self.target.DrawBitmap(bitmap, Some(&r), 1.0, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR, None);
            let _ = self.target.EndDraw(None, None);
        }
    }
}
