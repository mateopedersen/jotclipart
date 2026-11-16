import {createRequire} from 'node:module';
import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

/** Small interface illustrations only. Catalog originals are never regenerated. */
export async function compileUIImages(root, out, revision) {
  const sharp=createRequire(import.meta.resolve('astro/package.json'))('sharp');
  const sources=new Map(), previews={}, assets=[];
  const output=join(out,'client','home-ui'); mkdirSync(output,{recursive:true});
  for(const name of readdirSync(join(root,'public/home-art')).filter(n=>n.endsWith('.webp')).sort()) {
    const file=join(root,'public/home-art',name), source=readFileSync(file);
    const info=await sharp(source).metadata(), sourceSHA256=createHash('sha256').update(source).digest('hex');
    if(!info.width||!info.height)throw Error('Invalid interface image');
    const widths=[...new Set([160,320,640,960].filter(w=>w<info.width).concat(Math.min(info.width,960)))], variants=[];
    for(const width of widths) {
      const bytes=await sharp(source).resize({width,withoutEnlargement:true}).webp({quality:80}).toBuffer();
      const sha256=createHash('sha256').update(bytes).digest('hex'), path=join(output,sha256+'.webp');
      writeFileSync(path,bytes);const src=`/__ssr-client/${revision}/home-ui/${sha256}.webp`;
      variants.push({width,src});assets.push({path,sha256,bytes:bytes.length,width,sourceSHA256});
    }
    sources.set(file,sourceSHA256);
    previews[sourceSHA256]={src:variants.at(-1).src,srcset:variants.map(v=>`${v.src} ${v.width}w`).join(', ')};
  }
  return {sources,assets,alias:`const items=${JSON.stringify(previews)};export async function uiPreview(source){if(!items[source.assetKey])throw Error('Missing interface source');return items[source.assetKey]}`};
}
