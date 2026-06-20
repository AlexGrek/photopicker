//! MakerNote focus-distance extraction for cameras that store it outside standard EXIF.
//!
//! Fujifilm does not record focus distance in MakerNote or standard EXIF tags.

const TIFF_SHORT: u16 = 3;
const TIFF_LONG: u16 = 4;

fn read_u16(data: &[u8], off: usize, le: bool) -> Option<u16> {
    let b = data.get(off..off + 2)?;
    Some(if le {
        u16::from_le_bytes([b[0], b[1]])
    } else {
        u16::from_be_bytes([b[0], b[1]])
    })
}

fn read_u32(data: &[u8], off: usize, le: bool) -> Option<u32> {
    let b = data.get(off..off + 4)?;
    Some(if le {
        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
    } else {
        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
    })
}

fn tiff_header(data: &[u8], base: usize) -> Option<(usize, bool)> {
    if data.len() < base + 8 {
        return None;
    }
    let le = match &data[base..base + 2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    if read_u16(data, base + 2, le)? != 42 {
        return None;
    }
    Some((base + read_u32(data, base + 4, le)? as usize, le))
}

fn ifd_entry(data: &[u8], ifd_off: usize, tag: u16, le: bool) -> Option<(u16, u32, u32)> {
    let count = read_u16(data, ifd_off, le)? as usize;
    for i in 0..count {
        let entry = ifd_off + 2 + i * 12;
        if read_u16(data, entry, le)? != tag {
            continue;
        }
        return Some((
            read_u16(data, entry + 2, le)?,
            read_u32(data, entry + 4, le)?,
            read_u32(data, entry + 8, le)?,
        ));
    }
    None
}

fn read_u32_pair(data: &[u8], typ: u16, count: u32, value_offset: u32, le: bool) -> Option<(u32, u32)> {
    if typ != TIFF_LONG || count != 2 {
        return None;
    }
    let off = value_offset as usize;
    Some((read_u32(data, off, le)?, read_u32(data, off + 4, le)?))
}

fn read_u16_value(data: &[u8], typ: u16, count: u32, value_offset: u32, le: bool) -> Option<u16> {
    if typ != TIFF_SHORT || count < 1 {
        return None;
    }
    if count == 1 && value_offset <= u16::MAX as u32 {
        return Some(value_offset as u16);
    }
    read_u16(data, value_offset as usize, le)
}

/// Returns focus distance in meters, or `None` when unavailable.
pub fn focus_distance_meters(data: &[u8]) -> Option<f64> {
    olympus_focus_distance(data)
        .or_else(|| nikon_focus_distance(data))
}

fn olympus_focus_distance(data: &[u8]) -> Option<f64> {
    if !data.starts_with(b"OLYMPUS") {
        return None;
    }
    let (ifd_off, le) = tiff_header(data, 8)?;
    let (typ, count, vo) = ifd_entry(data, ifd_off, 0x0305, le)?;
    let (num, _den) = read_u32_pair(data, typ, count, vo, le)?;
    if num == 0xffff_ffff {
        return Some(f64::INFINITY);
    }
    if num == 0 {
        return None;
    }
    Some(num as f64 / 1000.0)
}

fn nikon_focus_distance(data: &[u8]) -> Option<f64> {
    if data.len() < 14 || &data[0..6] != b"Nikon\0" {
        return None;
    }
    let le = match &data[6..8] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let ifd_off = read_u32(data, 10, le)? as usize + 10;
    if let Some(m) = nikon_type3_focus(data, ifd_off, le) {
        return Some(m);
    }
    nikon_legacy_focus(data, ifd_off, le)
}

fn nikon_type3_focus(data: &[u8], ifd_off: usize, le: bool) -> Option<f64> {
    let (typ, count, vo) = ifd_entry(data, ifd_off, 0x004e, le)?;
    let raw = read_u16_value(data, typ, count, vo, le)?;
    if raw == 0 {
        return None;
    }
    let scaled = f64::from(raw) / 256.0;
    let meters = 2f64.powf((scaled - 80.0) / 12.0);
    if meters.is_finite() && meters > 0.0 {
        Some(meters)
    } else {
        None
    }
}

fn nikon_legacy_focus(data: &[u8], ifd_off: usize, le: bool) -> Option<f64> {
    let (typ, count, vo) = ifd_entry(data, ifd_off, 0x0094, le)?;
    let raw = read_u16_value(data, typ, count, vo, le)?;
    if raw == 0 {
        return None;
    }
    let meters = 0.01 * 10f64.powf(f64::from(raw) / 40.0);
    if meters.is_finite() && meters > 0.0 {
        Some(meters)
    } else {
        None
    }
}
