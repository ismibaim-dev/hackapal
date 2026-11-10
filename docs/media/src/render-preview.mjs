// Renders docs/media/src/preview-video.html to docs/media/preview.mp4 (1920x1080, 30 fps).
//
//   node docs/media/src/render-preview.mjs            full video
//   node docs/media/src/render-preview.mjs 3 12 50    only stills at those seconds (for checking)
//
// Needs Playwright with Chromium and ffmpeg on the PATH. They are not project dependencies:
// this is a one-off media tool, not part of the app.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const page_url = `file://${join(here, 'preview-video.html')}`;
const out = join(here, '..', 'preview.mp4');
const frames = process.env.FRAMES_DIR ?? join(here, '..', '.frames');
const FPS = 30;
const WORKERS = 4;

const browser = await chromium.launch();
const open = async () => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(page_url);
  await page.evaluate(() => document.fonts.ready);
  return page;
};

const stills = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
if (stills.length > 0) {
  const page = await open();
  mkdirSync(frames, { recursive: true });
  for (const t of stills) {
    await page.evaluate((s) => window.seek(s), t);
    await page.screenshot({ path: join(frames, `still-${String(t).padStart(5, '0')}.png`) });
  }
  await browser.close();
  console.log(`stills written to ${frames}`);
  process.exit(0);
}

rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
const first = await open();
const total = Math.round((await first.evaluate(() => window.DURATION)) * FPS);
await first.close();

// Each worker renders its own slice of frames; every frame is independent of the others.
await Promise.all(
  Array.from({ length: WORKERS }, async (_, w) => {
    const page = await open();
    for (let i = w; i < total; i += WORKERS) {
      await page.evaluate((s) => window.seek(s), i / FPS);
      await page.screenshot({ path: join(frames, `${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 93 });
    }
    await page.close();
  }),
);
await browser.close();

const ff = spawnSync(
  'ffmpeg',
  ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%05d.jpg'),
   '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
  { stdio: 'inherit' },
);
if (ff.status !== 0) process.exit(ff.status ?? 1);
rmSync(frames, { recursive: true, force: true });
console.log(`wrote ${out} (${total} frames)`);
