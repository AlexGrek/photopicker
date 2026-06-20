import { invoke } from "@tauri-apps/api/core";

export interface ExifField {
  label: string;
  value: string;
}

export interface ExifOverlay {
  lens: string | null;
  aperture: string | null;
  shutter: string | null;
  iso: string | null;
  focusDistance: string | null;
}

export interface ExifInfo {
  fields: ExifField[];
  overlay: ExifOverlay;
}

export function getExifInfo(path: string): Promise<ExifInfo> {
  return invoke<ExifInfo>("get_exif_info", { path });
}

export function overlayHasData(overlay: ExifOverlay): boolean {
  return !!(overlay.lens || overlay.aperture || overlay.shutter || overlay.iso || overlay.focusDistance);
}
