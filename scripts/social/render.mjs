import {brand} from '../../src/lib/brand.mjs';
import {socialSources} from './sources.mjs';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const sha = (data) => createHash('sha256').update(data).digest('hex');
const xml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );

// Only repository-owned interface symbols, never catalog art or editor palettes.
function interfacePalette(svg) {
  return svg.replace(/#[0-9a-fA-F]{6}\b/g,color=>{
    const [r,g,b]=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min,light=(max+min)/2;
    if(!d)return color;
    const saturation=d/(1-Math.abs(2*light-1));
    let hue=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;hue=(hue*60+360)%360;
    if(hue<190||hue>255||saturation<.12)return color;
    return light<.27?brand.ink:light<.62?brand.action:light<.88?'#B7DCC5':light<.96?brand.soft:brand.background;
  });
}

export async function createRenderer(root) {
  const work = join(root, '.astro/social-images');
  const fonts = join(work, 'fonts');
  await mkdir(fonts, { recursive: true });
  await mkdir(join(work, 'cache'), { recursive: true });
  const fontFiles = {};
  for (const weight of [400, 600, 700]) {
    const source = join(
      root,
      `node_modules/@fontsource/inter/files/inter-latin-${weight}-normal.woff`,
    );
    fontFiles[weight] = join(fonts, `Inter-${weight}.woff`);
    await copyFile(source, fontFiles[weight]);
  }
  const config = join(work, 'fonts.conf');
  await writeFile(
    config,
    `<?xml version="1.0"?><fontconfig><dir>${xml(fonts)}</dir><cachedir>${xml(join(work, 'cache'))}</cachedir></fontconfig>`,
  );
  process.env.FONTCONFIG_FILE = config;
  process.env.FONTCONFIG_PATH = work;
  const { default: sharp } = await import('sharp');
  const sourceReader=await socialSources(root);
  const textCache = new Map();
  const imageCache = new Map();
  const sourceHashes = new Map();
  async function source(path) {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(root + '/'))
      throw new Error('Social image source is outside the project');
    const bytes = await sourceReader.read(path);
    sourceHashes.set(path, sha(bytes));
    return bytes;
  }
  async function textLayer(value, options) {
    const { size, weight, color } = options;
    const key = JSON.stringify([value, size, weight, color]);
    if (!textCache.has(key))
      textCache.set(
        key,
        (async () => {
          const data = await sharp({
            text: {
              text: `<span foreground="${color}" weight="${weight}">${xml(value)}</span>`,
              font: `Inter ${size}`,
              fontfile: fontFiles[weight],
              rgba: true,
              dpi: 144,
            },
          })
            .png()
            .toBuffer();
          const m = await sharp(data).metadata();
          return { data, width: m.width / 2, height: m.height / 2 };
        })(),
      );
    return textCache.get(key);
  }
  class Canvas {
    constructor(background = brand.background) {
      this.parts = [`<rect width="1200" height="630" fill="${background}"/>`];
      this.sources = new Set();
      this.textBounds = [];
    }
    svg(markup) {
      this.parts.push(markup);
      return this;
    }
    rect(x, y, width, height, fill = '#fff', radius = 16, stroke = '') {
      return this.svg(
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1.5"` : ''}/>`,
      );
    }
    line(x1, y1, x2, y2, color = '#B7DCC5', width = 2) {
      return this.svg(
        `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`,
      );
    }
    async text(
      value,
      x,
      y,
      { size = 28, weight = 400, color = brand.ink, maxWidth = 1080, center = false } = {},
    ) {
      let layer = await textLayer(value, { size, weight, color });
      while (layer.width > maxWidth && size > 12) {
        size -= 1;
        layer = await textLayer(value, { size, weight, color });
      }
      if (layer.width > maxWidth) throw new Error(`Text cannot fit: ${value}`);
      const left = center ? x - layer.width / 2 : x;
      if (left < 0 || y < 0 || left + layer.width > 1200 || y + layer.height > 630)
        throw new Error(`Text is outside the image: ${value}`);
      this.textBounds.push({
        text: value,
        x: left,
        y,
        width: layer.width,
        height: layer.height,
        size,
      });
      this.parts.push(
        `<image href="data:image/png;base64,${layer.data.toString('base64')}" x="${left}" y="${y}" width="${layer.width}" height="${layer.height}"/>`,
      );
      return this;
    }
    async lines(values, x, y, options = {}) {
      const lineHeight = options.lineHeight || (options.size || 28) * 1.2;
      for (let i = 0; i < values.length; i++)
        await this.text(values[i], x, y + i * lineHeight, options);
      return this;
    }
    async image(path, x, y, width, height, { angle = 0, cover = false, transformSource } = {}) {
      if(path.startsWith('public/illustrations/actions/')&&path.endsWith('.svg')&&!transformSource)transformSource=interfacePalette;
      this.sources.add(path);
      const key = JSON.stringify([path, width, height, cover, transformSource?.name]);
      if (!imageCache.has(key))
        imageCache.set(
          key,
          (async () => {
            let bytes = await source(path);
            if (transformSource) bytes = Buffer.from(transformSource(bytes.toString('utf8')));
            return sharp(bytes, { density: 144 })
              .resize(Math.round(width * 2), Math.round(height * 2), {
                fit: cover ? 'cover' : 'contain',
                background: '#ffffff00',
              })
              .png()
              .toBuffer();
          })(),
        );
      const data = await imageCache.get(key);
      this.parts.push(
        `<image href="data:image/png;base64,${data.toString('base64')}" x="${x}" y="${y}" width="${width}" height="${height}"${angle ? ` transform="rotate(${angle} ${x + width / 2} ${y + height / 2})"` : ''}/>`,
      );
      return this;
    }
    async brand({ dark = false } = {}) {
      await this.image('public/logo.svg', 56, 45, 32, 36);
      await this.text('JotClipart', 101, 47, {
        size: 29,
        weight: 700,
        color: dark ? '#fff' : brand.ink,
      });
      await this.text('jotclipart.com', 58, 565, {
        size: 21,
        weight: 400,
        color: dark ? brand.soft : brand.action,
      });
    }
    async title(lines, subtitle, { dark = false, size = 59 } = {}) {
      await this.lines(lines, 56, 170, {
        size,
        lineHeight: size * 1.16,
        weight: 700,
        color: dark ? '#fff' : brand.ink,
        maxWidth: 490,
      });
      await this.lines(subtitle, 58, 354 + Math.max(0, lines.length - 2) * 30, {
        size: 25,
        lineHeight: 38,
        color: dark ? brand.soft : brand.action,
        maxWidth: 490,
      });
    }
    async png() {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">${this.parts.join('')}</svg>`;
      return sharp(Buffer.from(svg), { density: 144 })
        .resize(1200, 630)
        .flatten({ background: '#fff' })
        .png({ compressionLevel: 9, effort: 10 })
        .toBuffer();
    }
    provenance() {
      return [...this.sources].sort().map((path) => ({ path, sha256: sourceHashes.get(path) }));
    }
  }
  return {
    downloadReceipts:sourceReader.receipts,
    Canvas,
    sharp,
    source,
    sha,
    work,
    fonts: await Promise.all(
      Object.entries(fontFiles).map(async ([weight, path]) => ({
        weight: Number(weight),
        sha256: sha(await readFile(path)),
        family: 'Inter',
      })),
    ),
  };
}
