import { describe, expect, it, vi } from "vitest";
import { LruMap } from "../lru";
import { probeOffsets } from "../photoScroll";
import { buildRawCouplingMeta, detectRawCouplingBySample } from "../rawCoupling";
import { sortEntries } from "../sort";
import { type ImageEntry } from "../thumbnails";
import { baseName, plural, shortenPath, toggleInSet } from "../utils";

function entry(name: string, extra: Partial<ImageEntry> = {}): ImageEntry {
  return { path: `/d/${name}`, name, size: 1, created: null, modified: null, raw: false, video: false, ...extra };
}

describe("shortenPath", () => {
  it("handles macOS, Linux and Windows home directories", () => {
    expect(shortenPath("/Users/ann/Pictures")).toBe("~/Pictures");
    expect(shortenPath("/home/ann")).toBe("~");
    expect(shortenPath(String.raw`C:\Users\ann\Pictures\x`)).toBe(String.raw`~\Pictures\x`);
    expect(shortenPath(String.raw`D:\Cards\A`)).toBe(String.raw`D:\Cards\A`);
  });
});

describe("small helpers", () => {
  it("baseName ignores trailing separators", () => {
    expect(baseName(String.raw`C:\a\b` + "\\")).toBe("b");
    expect(baseName("/a/b.jpg")).toBe("b.jpg");
  });
  it("plural / toggleInSet", () => {
    expect(plural(1, "photo")).toBe("1 photo");
    expect(plural(2, "photo")).toBe("2 photos");
    const s = new Set(["a"]);
    expect([...toggleInSet(s, "b")]).toEqual(["a", "b"]);
    expect([...toggleInSet(s, "a")]).toEqual([]);
    expect(s.size).toBe(1); // input untouched
  });
});

describe("sortEntries", () => {
  const list = [entry("IMG_10.jpg", { created: 3 }), entry("IMG_2.jpg", { created: 1 }), entry("IMG_1.jpg", { created: 2 })];
  it("orders names naturally", () => {
    expect(sortEntries(list, "nameAsc").map((e) => e.name)).toEqual(["IMG_1.jpg", "IMG_2.jpg", "IMG_10.jpg"]);
    expect(sortEntries(list, "nameDesc").map((e) => e.name)).toEqual(["IMG_10.jpg", "IMG_2.jpg", "IMG_1.jpg"]);
  });
  it("orders by creation time and does not mutate its input", () => {
    expect(sortEntries(list, "createdAsc").map((e) => e.name)).toEqual(["IMG_2.jpg", "IMG_1.jpg", "IMG_10.jpg"]);
    expect(sortEntries(list, "createdDesc")[0].name).toBe("IMG_10.jpg");
    expect(list[0].name).toBe("IMG_10.jpg");
  });
  it("sorts by shot date, unknown dates first when ascending", () => {
    const shots = { "/d/IMG_1.jpg": 20240102000000, "/d/IMG_2.jpg": 20240101000000 };
    expect(sortEntries(list, "shotAsc", shots).map((e) => e.name)).toEqual(["IMG_10.jpg", "IMG_2.jpg", "IMG_1.jpg"]);
  });
});

describe("raw coupling", () => {
  const files = [entry("A.jpg"), entry("A.CR3", { raw: true }), entry("B.jpg")];
  it("hides the RAW and couples actions on the JPEG", () => {
    const meta = buildRawCouplingMeta(files);
    expect([...meta.hiddenRawPaths]).toEqual(["/d/A.CR3"]);
    expect(meta.actionPathsByPath["/d/A.jpg"]).toEqual(["/d/A.jpg", "/d/A.CR3"]);
    expect(meta.actionPathsByPath["/d/B.jpg"]).toBeUndefined();
  });
  it("auto-detects from a sample", () => {
    expect(detectRawCouplingBySample(files)).toBe(true);
    expect(detectRawCouplingBySample([entry("B.jpg")])).toBe(false);
  });
});

describe("LruMap", () => {
  it("evicts the least recently used entry and reports it", () => {
    const evicted = vi.fn();
    const m = new LruMap<string, number>(2, evicted);
    m.set("a", 1);
    m.set("b", 2);
    m.get("a");
    m.set("c", 3);
    expect(m.has("b")).toBe(false);
    expect(evicted).toHaveBeenCalledWith(2, "b");
  });
  it("never evicts pinned entries", () => {
    const m = new LruMap<string, { pinned: boolean }>(1, undefined, (v) => !v.pinned);
    m.set("a", { pinned: true });
    m.set("b", { pinned: false });
    expect(m.has("a")).toBe(true);
  });
});

describe("probeOffsets", () => {
  it("is bounded, clamped and free of duplicates", () => {
    const offsets = probeOffsets(100, 500, 800, 6);
    expect(offsets.length).toBeLessThanOrEqual(6);
    expect(offsets.every((y) => y >= 0 && y <= 800)).toBe(true);
    expect(new Set(offsets.map(Math.round)).size).toBe(offsets.length);
    expect(offsets).not.toContain(100);
  });
});
