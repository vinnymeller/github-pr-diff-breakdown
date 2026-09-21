// Builds the Chrome Web Store screenshots from the README ones in docs/.
//
// The store validates dimensions at upload and accepts only 1280x800 or
// 640x400, so the source images are padded onto a 1280x800 canvas rather than
// scaled: everything composites 1:1, keeping the small text as crisp as the
// original. Stacking both into one slide would need a downscale, which costs
// exactly the legibility these screenshots exist to demonstrate.
//
// Unlike the other tools here this one needs ImageMagick on PATH, since it is
// only ever run by hand when the screenshots change.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CANVAS = '1280x800';
const BG = '#0d1117';        // GitHub dark --bgColor-default
const FG = '#f0f6fc';        // --fgColor-default
const MUTED = '#9198a1';     // --fgColor-muted

const SLIDES = [
  {
    out: 'store/01-inline.png',
    source: 'docs/inline-screenshot.png',
    // Only 114px tall, so it needs a caption or it floats in a sea of black.
    headline: "A pull request's line count, by file type",
    subtitle: '44% of this diff is generated — the overflow chip says so',
  },
  {
    out: 'store/02-expanded.png',
    source: 'docs/expanded-screenshot.png',
    // Nearly fills the canvas and explains itself; a caption would crowd it.
    headline: null,
  },
];

function build({ out, source, headline, subtitle }) {
  const args = headline
    ? ['-size', CANVAS, `xc:${BG}`,
       '-font', 'DejaVu-Sans-Bold', '-pointsize', '40', '-fill', FG,
       '-gravity', 'north', '-annotate', '+0+280', headline,
       '-font', 'DejaVu-Sans', '-pointsize', '23', '-fill', MUTED,
       '-gravity', 'north', '-annotate', '+0+345', subtitle,
       source, '-gravity', 'north', '-geometry', '+0+450', '-composite', out]
    : [source, '-background', BG, '-gravity', 'center', '-extent', CANVAS, out];

  execFileSync('magick', args, { cwd: ROOT });
  const size = execFileSync('magick', ['identify', '-format', '%wx%h', out], { cwd: ROOT }).toString();
  console.log(`${out} — ${size}`);
}

try {
  execFileSync('magick', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('ImageMagick is required: this script only runs when the screenshots change.');
  process.exit(1);
}

mkdirSync(new URL('../store/', import.meta.url), { recursive: true });
for (const slide of SLIDES) build(slide);
