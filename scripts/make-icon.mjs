// Generates build/icon.ico (multi-size) and build/icon.png from a simple
// vector-ish design drawn with pngjs. Run: npm run icon
import { PNG } from 'pngjs';
import pngToIco from 'png-to-ico';
import { writeFileSync, mkdirSync } from 'node:fs';

const ACCENT = [47, 129, 247, 255]; // #2f81f7
const WHITE = [255, 255, 255, 255];

// Reference design is 256px: rounded square + three white "bar chart" bars.
function render(size) {
  const png = new PNG({ width: size, height: size });
  const s = size / 256;
  const radius = 56 * s;
  const baseline = 196 * s;
  const bars = [
    [70, 28, 64],
    [114, 28, 104],
    [158, 28, 84],
  ].map(([x, w, h]) => [x * s, w * s, h * s]);

  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let c = [0, 0, 0, 0];
      if (inRounded(px, py)) {
        c = ACCENT;
        for (const [bx, bw, bh] of bars) {
          if (px >= bx && px < bx + bw && py <= baseline && py >= baseline - bh) {
            c = WHITE;
            break;
          }
        }
      }
      const i = (y * size + x) * 4;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = c[3];
    }
  }
  return PNG.sync.write(png);
}

mkdirSync('build', { recursive: true });
const sizes = [256, 128, 64, 48, 32, 16];
const buffers = sizes.map(render);
writeFileSync('build/icon.png', buffers[0]);
const ico = await pngToIco(buffers);
writeFileSync('build/icon.ico', ico);
console.log(`wrote build/icon.png (256) and build/icon.ico (${sizes.join(', ')})`);
