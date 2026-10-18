#![cfg(test)]
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Accuracy regression for the vendored rounded-shadow polynomial fit.
use vello_cpu::fine::phi_coefficients;

fn phi_exact(exponent: f64, t: f64) -> f64 {
    (1.0 + t.powf(exponent)).powf(1.0 / exponent)
}

fn phi_fit(coeffs: &[f32; 8], t: f32) -> f32 {
    let mut acc = coeffs[7];
    for k in (0..7).rev() {
        acc = acc.mul_add(t, coeffs[k]);
    }
    acc
}

const EXPONENT_MIN: f64 = 2.0;
const EXPONENT_MAX: f64 = 4.0 / 1.15;

const MAX_FIT_ERROR: f64 = 3e-5;

#[test]
fn phi_fit_tracks_the_exact_pnorm_across_the_exponent_domain() {
    let mut worst = 0.0f64;
    let mut worst_at = (0.0f64, 0.0f64);

    for i in 0..=1000 {
        let exponent = EXPONENT_MIN + (EXPONENT_MAX - EXPONENT_MIN) * (i as f64 / 1000.0);
        let coeffs = phi_coefficients(exponent as f32);
        for j in 0..=1000 {
            let t = j as f64 / 1000.0;
            let err = (f64::from(phi_fit(&coeffs, t as f32)) - phi_exact(exponent, t)).abs();
            if err > worst {
                worst = err;
                worst_at = (exponent, t);
            }
        }
    }

    eprintln!(
        "worst |phi_fit - phi_exact| = {worst:.6e} at e={:.4} t={:.3}",
        worst_at.0, worst_at.1
    );
    assert!(
        worst < MAX_FIT_ERROR,
        "phi fit drifted: worst error {worst:.6e} at e={:.4} t={:.3} exceeds {MAX_FIT_ERROR:.1e}",
        worst_at.0,
        worst_at.1
    );
}

#[test]
fn phi_fit_hits_the_analytic_anchors() {
    for i in 0..=100 {
        let exponent = EXPONENT_MIN + (EXPONENT_MAX - EXPONENT_MIN) * (i as f64 / 100.0);
        let coeffs = phi_coefficients(exponent as f32);

        let at_zero = f64::from(phi_fit(&coeffs, 0.0));
        assert!(
            (at_zero - 1.0).abs() < MAX_FIT_ERROR,
            "phi(0) = {at_zero} at e={exponent}, must be 1 to match the straight-edge path"
        );

        let at_one = f64::from(phi_fit(&coeffs, 1.0));
        let expected = 2.0f64.powf(1.0 / exponent);
        assert!(
            (at_one - expected).abs() < MAX_FIT_ERROR,
            "phi(1) = {at_one} at e={exponent}, expected 2^(1/e) = {expected}"
        );
    }
}

const REFERENCE_ROTATION_RAD: f64 = 1e-6;

fn render_blur(transform: vello_cpu::kurbo::Affine, std_dev: f32, radius: f32) -> Vec<u8> {
    use vello_cpu::color::{AlphaColor, Srgb};
    use vello_cpu::kurbo::Rect;
    const W: u16 = 480;
    const H: u16 = 360;
    let mut ctx = vello_cpu::RenderContext::new(W, H);
    ctx.set_transform(transform);
    ctx.set_paint(AlphaColor::<Srgb>::from_rgba8(213, 88, 16, 153));
    ctx.fill_blurred_rounded_rect(
        &Rect::new(120.0, 90.0, 360.0, 270.0),
        radius,
        std_dev,
        false,
    );
    let mut target = vello_cpu::Pixmap::new(W, H);
    ctx.flush();
    ctx.render(&mut target, &mut vello_cpu::Resources::new());
    target.data_as_u8_slice().to_vec()
}

#[test]
fn interpolated_wide_blur_stays_within_one_step_of_per_pixel() {
    use vello_cpu::kurbo::Affine;
    for (std_dev, radius) in [(16.0, 0.0), (40.0, 10.0), (60.0, 60.0), (100.0, 30.0)] {
        for transform in [Affine::translate((0.4, 0.0)), Affine::scale(1.5)] {
            let interpolated = render_blur(transform, std_dev, radius);
            let reference = render_blur(
                transform * Affine::rotate(REFERENCE_ROTATION_RAD),
                std_dev,
                radius,
            );
            let worst = interpolated
                .iter()
                .zip(&reference)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap();
            assert!(
                worst <= 1,
                "std_dev={std_dev} radius={radius} {transform:?}: off by {worst} from per-pixel"
            );
        }
    }
}

#[test]
fn blurred_shadow_corner_keeps_its_pnorm_falloff() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
  body { margin: 0; background: #fff; }
  .s { position: absolute; left: 50px; top: 50px; width: 100px; height: 100px;
       border-radius: 30px; box-shadow: 0 0 20px 0 #000; }
</style></head><body><div class="s"></div></body></html>"##;
    let png =
        crate::paint::screenshot::ks_render_html_to_png(html, "https://test.example/", 200, 200);
    let decoder = png::Decoder::new(std::io::Cursor::new(&png[..]));
    let mut reader = decoder.read_info().expect("png info");
    let mut buf = vec![0u8; reader.output_buffer_size().expect("buf size")];
    let info = reader.next_frame(&mut buf).expect("png frame");
    let stride = info.line_size;
    let lum = |x: usize, y: usize| i32::from(buf[y * stride + x * 4]);

    let diagonal: Vec<i32> = (30..54).step_by(2).map(|d| lum(d, d)).collect();
    const EXPECTED: [i32; 12] = [255, 255, 255, 255, 255, 254, 253, 251, 247, 240, 230, 217];
    for (k, (&got, &want)) in diagonal.iter().zip(EXPECTED.iter()).enumerate() {
        assert!(
            (got - want).abs() <= 2,
            "corner falloff changed at d={}: got {got}, expected ~{want} (full ramp {diagonal:?})",
            30 + 2 * k
        );
    }

    for w in diagonal.windows(2) {
        assert!(w[1] <= w[0], "corner falloff is not monotone: {diagonal:?}");
    }
    assert!(
        diagonal[0] - diagonal[11] > 30,
        "corner barely falls off at all: {diagonal:?}"
    );

    let corners = [lum(44, 44), lum(155, 44), lum(44, 155), lum(155, 155)];
    for c in corners {
        assert!(
            (c - corners[0]).abs() <= 1,
            "corners disagree, coordinate folding is broken: {corners:?}"
        );
    }
}
