import { credit, photoOfDay, photos } from "./photos";

describe("photos", () => {
  it("has the 30 photos, each with a file and an Unsplash link", () => {
    expect(photos).toHaveLength(30);
    for (const p of photos) {
      expect(p.src).toMatch(/\.jpg/);
      expect(p.url).toMatch(/^https:\/\/images\.unsplash\.com\/photo-\d+-[0-9a-f]+$/);
    }
    expect(new Set(photos.map((p) => p.src)).size).toBe(30);
  });

  it("photoOfDay is stable through a day and different the next", () => {
    const morning = new Date(2026, 10, 11, 0, 1);
    const night = new Date(2026, 10, 11, 23, 59);
    const tomorrow = new Date(2026, 10, 12, 8, 0);
    expect(photoOfDay(morning)).toBe(photoOfDay(night));
    expect(photoOfDay(tomorrow)).not.toBe(photoOfDay(morning));
  });

  it("photoOfDay is dayOfYear modulo the count", () => {
    // 11 Nov 2026 is day 315 of the year: 315 % 30 = 15, and a swap is the next one, wrapping at the end
    expect(photoOfDay(new Date(2026, 10, 11))).toBe(photos[15]);
    expect(photoOfDay(new Date(2026, 10, 11), 1)).toBe(photos[16]);
    expect(photoOfDay(new Date(2026, 10, 11), 15)).toBe(photos[0]);
  });

  it("the credit names the photographer only when known", () => {
    expect(credit({ src: "", url: "", photographer: null })).toBe("Photo on Unsplash");
    expect(credit({ src: "", url: "", photographer: "Ana" })).toBe("Photo by Ana on Unsplash");
  });
});
