# Image Processing

## Crates

| Crate           | Purpose              | Notes                                        |
|-----------------|----------------------|----------------------------------------------|
| `kamadak-exif`  | EXIF metadata reader | Pure Rust, no system dependencies            |
| `zune-jpeg`     | JPEG decode / encode | Pure Rust, auto-SIMD (SSE/AVX/NEON), no system dependencies |

Both crates are fully cross-platform (macOS, Windows, Linux, ARM, x86-64) and require no
system libraries or build tools such as cmake or libjpeg-turbo.

## EXIF reading

```rust
use std::fs::File;
use std::io::BufReader;

let file = File::open("photo.jpg")?;
let mut buf = BufReader::new(file);
let exif = exif::Reader::new().read_from_container(&mut buf)?;

for field in exif.fields() {
    println!("{} = {}", field.tag, field.display_value());
}

// Read a specific tag
if let Some(f) = exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY) {
    println!("Taken: {}", f.display_value());
}
```

## JPEG decoding

```rust
use zune_jpeg::JpegDecoder;
use zune_core::options::DecoderOptions;

let bytes = std::fs::read("photo.jpg")?;
let mut decoder = JpegDecoder::new_with_options(&bytes, DecoderOptions::default());
let pixels = decoder.decode()?;       // Vec<u8>, interleaved RGB or RGBA
let (width, height) = decoder.dimensions().unwrap();
```

`zune-jpeg` automatically selects the best SIMD path at compile time:

| Architecture | Acceleration |
|---|---|
| x86 / x86-64 | SSE2, SSE4, AVX2 |
| ARM / Apple Silicon | NEON |
| Anything else | Scalar fallback |

No runtime detection is needed — the right path is baked in at build time.

## Performance notes

- `zune-jpeg` decoding benchmarks on par with or faster than libjpeg-turbo, especially on ARM.
- For thumbnail generation, decode directly to a smaller size using `DecoderOptions::set_scale_factor`.
- EXIF reads are zero-copy from a buffered reader — no full decode is needed to extract metadata.
