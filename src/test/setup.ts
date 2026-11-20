import "@testing-library/jest-dom/vitest";

// jsdom has no matchMedia: every test runs in light mode.
// jsdom has no image decoding: every image is ready at once.
HTMLImageElement.prototype.decode ??= () => Promise.resolve();
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
