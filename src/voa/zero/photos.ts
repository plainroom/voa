/**
 * The inbox-zero photos: landscape, from Unsplash (Unsplash License), one a day. The files live in
 * src/assets/zero/, named `NN-<unsplash photo id>.jpg`; add or swap one by dropping a file there.
 * `PHOTOGRAPHERS` holds the credit once it is known (the credit then reads "Photo by <name> on Unsplash").
 */
export interface Photo {
  src: string;
  photographer: string | null;
  /** Where the photo is on Unsplash. */
  url: string;
}

const PHOTOGRAPHERS: Record<string, string> = {};

const files = import.meta.glob<string>("../../assets/zero/*.jpg", { eager: true, query: "?url", import: "default" });

export const photos: Photo[] = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, src]) => {
    const id = /\d+-(\d+-[0-9a-f]+)\.jpg$/.exec(path)![1]!;
    return { src, photographer: PHOTOGRAPHERS[id] ?? null, url: `https://images.unsplash.com/photo-${id}` };
  });

/** The credit line: the photographer when known, else just Unsplash. */
export const credit = (p: Photo) => (p.photographer ? `Photo by ${p.photographer} on Unsplash` : "Photo on Unsplash");

/** Day of the year (1 to 366) by the calendar the person lives in, so it changes at their midnight. */
function dayOfYear(d: Date): number {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 86_400_000);
}

/** Today's photo: the same all day, the next one tomorrow; `skip` steps past it when the person swaps it. */
export function photoOfDay(date: Date, skip = 0): Photo {
  return photos[(dayOfYear(date) + skip) % photos.length]!;
}
