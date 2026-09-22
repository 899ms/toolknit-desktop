//! Shadow geometry shares the WebView's logical radius, not DWM's fixed presets.
#[cfg(target_os = "windows")]
mod win32;
#[cfg(target_os = "windows")]
pub(crate) use win32::configure;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Shape {
    width: u32,
    height: u32,
    radius: u32,
    dpi: u32,
}

impl Shape {
    fn scale(self) -> f64 {
        self.dpi as f64 / 96.0
    }
    fn padding(self) -> u32 {
        (12.0 * self.scale()).ceil() as u32
    }
    fn dimensions(self) -> Result<(u32, u32, usize), String> {
        if self.width == 0 || self.height == 0 || !(48..=768).contains(&self.dpi) {
            return Err("Invalid shadow geometry".into());
        }
        let width = self.width.checked_add(self.padding() * 2);
        let height = self.height.checked_add(self.padding() * 2);
        let (Some(width), Some(height)) = (width, height) else {
            return Err("Shadow geometry overflow".into());
        };
        let bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4));
        match bytes {
            Some(bytes) if bytes <= 128 * 1024 * 1024 => Ok((width, height, bytes)),
            _ => Err("Shadow surface exceeds memory limit".into()),
        }
    }

    fn alpha(self, x: f64, y: f64) -> u8 {
        let r = (self.radius.min(32) as f64 * self.scale())
            .min(self.width.min(self.height) as f64 / 2.0);
        let half_x = self.width as f64 / 2.0;
        let half_y = self.height as f64 / 2.0;
        let qx = (x - half_x).abs() - (half_x - r);
        let qy = (y - half_y).abs() - (half_y - r);
        let distance = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r;
        // A transparent interior prevents the shadow tinting the WebView's
        // antialiased corners. Only the exterior contour receives soft alpha.
        let coverage = (distance + 0.5).clamp(0.0, 1.0);
        let sigma = 3.5 * self.scale();
        // Keep the light-theme companion shadow present but deliberately soft.
        // Dark theme never enables this surface; the caller controls that state.
        (24.0 * (-distance.max(0.0).powi(2) / (2.0 * sigma * sigma)).exp() * coverage).round() as u8
    }

    fn raster(self) -> Result<Vec<u8>, String> {
        let (width, height, bytes) = self.dimensions()?;
        let mut pixels = Vec::new();
        pixels
            .try_reserve_exact(bytes)
            .map_err(|_| "Unable to allocate shadow surface")?;
        pixels.resize(bytes, 0);
        let pad = self.padding();
        let edge = pad + (self.radius.min(32) as f64 * self.scale()).ceil() as u32 + 1;
        for y in 0..height {
            // Most pixels are fully transparent. Rasterize the perimeter only.
            let spans = if y < edge || y >= height.saturating_sub(edge) {
                [(0, width), (0, 0)]
            } else {
                [(0, edge.min(width)), (width.saturating_sub(edge), width)]
            };
            for (start, end) in spans {
                for x in start..end {
                    let offset = (y as usize * width as usize + x as usize) * 4;
                    pixels[offset + 3] =
                        self.alpha(x as f64 + 0.5 - pad as f64, y as f64 + 0.5 - pad as f64);
                }
            }
        }
        Ok(pixels)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shadow_follows_all_custom_radii_and_dpi() {
        for dpi in [96, 120, 144, 192, 288] {
            for radius in [0, 1, 10, 18, 32] {
                let shape = Shape {
                    width: dpi * 2,
                    height: dpi,
                    radius,
                    dpi,
                };
                let pixels = shape.raster().unwrap();
                let (w, h, bytes) = shape.dimensions().unwrap();
                assert_eq!(pixels.len(), bytes);
                assert!(pixels
                    .chunks_exact(4)
                    .all(|p| p[0..3] == [0, 0, 0] && p[3] <= 24));
                assert_eq!(
                    shape.alpha(shape.width as f64 / 2.0, shape.height as f64 / 2.0),
                    0
                );
                assert!(shape.alpha(shape.width as f64 / 2.0, -1.0) > 20);
                for y in 0..h {
                    for x in 0..w {
                        let alpha = pixels[((y * w + x) * 4 + 3) as usize];
                        assert_eq!(alpha, pixels[((y * w + (w - 1 - x)) * 4 + 3) as usize]);
                        assert_eq!(alpha, pixels[(((h - 1 - y) * w + x) * 4 + 3) as usize]);
                    }
                }
                if radius >= 10 {
                    assert!(
                        shape.alpha(0.0, 0.0) < shape.alpha(shape.width as f64 / 2.0, -1.0),
                        "rounded corner must not resemble a rectangular shadow"
                    );
                }
                assert_eq!(pixels[3], 0, "outer surface must fade to transparent");
            }
        }
    }

    #[test]
    fn shadow_geometry_is_bounded() {
        let shape = Shape {
            width: 1100,
            height: 700,
            radius: 18,
            dpi: 96,
        };
        assert!(shape.dimensions().is_ok());
        assert!(Shape { width: 0, ..shape }.raster().is_err());
        assert!(Shape {
            width: u32::MAX,
            ..shape
        }
        .raster()
        .is_err());
        assert!(Shape { dpi: 0, ..shape }.raster().is_err());
        assert!(Shape {
            width: 20000,
            height: 20000,
            ..shape
        }
        .raster()
        .is_err());
    }
}
