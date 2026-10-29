import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
const SITE = 'https://ultraclipart.com';
const sha = text => createHash('sha256').update(text).digest('hex');
const decode = text => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[name]);

export function canonicalUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.origin !== SITE || url.search || url.hash || !url.pathname.endsWith('/') || /\/(edit|search|api)\//.test(url.pathname)) throw Error('IndexNow accepts only clean public sitemap page URLs');
  return url.href;
}

export function sitemapUrls(xml) {
  if (!/<urlset\b/.test(xml)) throw Error('Expected a page sitemap');
  const urls = [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/g)].map(m => canonicalUrl(decode(m[1])));
  if (!urls.length || new Set(urls).size !== urls.length) throw Error('Empty or duplicate sitemap URLs');
  return urls;
}

const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m=>[m[1].toLowerCase(),decode(m[3])]));
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value==='object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])) : value;
/** Use main content, metadata and media/link identities. Runtime bundles, CSS,
 * global chrome and serialized stats/build stamps are not content changes. */
export function contentFingerprint(html) {
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map(m=>attributes(m[0]));
  if (meta.some(m=>m.name?.toLowerCase()==='robots' && /\b(noindex|none)\b/i.test(m.content??''))) throw Error('A sitemap page is noindex');
  const main = [...html.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main>/gi)];
  if (main.length!==1) throw Error('Expected exactly one rendered main content region');
  const clean = main[0][1].replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
  const identities = [...clean.matchAll(/<(a|img|source|video|object)\b[^>]*>/gi)].map(m=>{
    const a=attributes(m[0]),names=m[1].toLowerCase()==='a'?['href']:['src','srcset','alt','poster','data'];
    return [m[1].toLowerCase(),...names.map(name=>a[name]??'')];
  });
  const graphs = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m=>attributes(m[1]).type==='application/ld+json').map(m=>ordered(JSON.parse(m[2])));
  return sha(JSON.stringify({title:html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]??'',description:meta.find(m=>m.name==='description')?.content??'',text:decode(clean.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim(),identities,graphs}));
}

export function changes(previous, current) {
  return { updated: Object.keys(current).filter(url => previous[url] !== current[url]), removed: Object.keys(previous).filter(url => !(url in current)) };
}

export function assertProduction(project, release, manifest, revision, html) {
  const deployment = project?.canonical_deployment;
  if (!deployment || deployment.environment !== 'production' || deployment.latest_stage?.status !== 'success' || deployment.deployment_trigger?.metadata?.commit_hash !== revision) throw Error('Cloudflare has not confirmed this exact canonical production deployment');
  if (manifest.status !== 'remote-byte-verified' || manifest.revision !== revision || !/^[a-f0-9]{64}$/.test(manifest.root) || release.renderedRevision !== revision || release.controlRevision !== revision || release.verifiedRoot !== manifest.root) throw Error('Production rendered/control revision or verified delivery root differs');
  if (!html.includes(`name="build-revision" content="${revision}"`)) throw Error('Live homepage does not serve this rendered revision');
  return deployment.id;
}

/** Commit each accepted batch; a later failure cannot replay an accepted batch. */
export async function sendChanges({ previous, current, config, request = fetch, save, wait = delay }) {
  const delta = changes(previous, current);
  for (const url of [...delta.updated, ...delta.removed]) canonicalUrl(url);
  for (const url of delta.removed) {
    const response = await request(url, {method:'HEAD', redirect:'manual', signal:AbortSignal.timeout(30000)});
    if (![404,410].includes(response.status)) throw Error('Removed URL is still live; no deletion notice sent');
  }
  const pending = [...delta.updated, ...delta.removed], state = {...previous}, receipts = [];
  for (let offset = 0; offset < pending.length; offset += 10000) {
    const urls = pending.slice(offset, offset + 10000);
    const response = await request(INDEXNOW_ENDPOINT, {method:'POST', redirect:'error', headers:{'Content-Type':'application/json; charset=utf-8'}, body:JSON.stringify({host:config.host,key:config.key,keyLocation:`${SITE}/${config.key}.txt`,urlList:urls}), signal:AbortSignal.timeout(30000)});
    if (![200,202].includes(response.status)) throw Error(`IndexNow did not accept this batch (HTTP ${response.status}); accepted batches remain recorded`);
    await response.body?.cancel();
    for (const url of urls) { if (url in current) state[url] = current[url]; else delete state[url]; }
    receipts.push({count:urls.length,status:response.status,keyValidationPending:response.status===202,acceptedAt:new Date().toISOString(),urlListSha256:sha(JSON.stringify(urls))});
    await save({...state}, [...receipts]);
    if (offset + 10000 < pending.length) await wait(1100);
  }
  return {updated:delta.updated.length,removed:delta.removed.length,receipts};
}

/** Shared by linked worktrees; never store accepted state in disposable dist/work. */
export function indexNowStateDirectory(root) {
  const common = execFileSync('git',['rev-parse','--git-common-dir'],{cwd:root,encoding:'utf8'}).trim();
  return resolve(root,common,'../.indexnow');
}

/** Freeze meaningful content from this exact checked release before upload.
 * Offloaded HTML must match its readback-verified R2 digest; remaining pages
 * are read directly from the actual Pages package, not a mutable old dist. */
export function prepareIndexNowSnapshot({root,target,revision,manifest}) {
  if (manifest.status!=='remote-byte-verified' || manifest.revision!==revision) throw Error('Verified current delivery manifest required');
  const remote = new Map(manifest.files.map(file=>[file.path,file]));
  const index = readFileSync(join(target,'sitemap.xml'),'utf8');
  const children = [...index.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>\s*<\/sitemap>/g)].map(m=>new URL(decode(m[1]))).filter(url=>/^\/sitemap-pages(?:-\d+)?\.xml$/.test(url.pathname));
  if (!children.length || children.some(url=>url.origin!==SITE || url.search || url.hash)) throw Error('Invalid page sitemap index');
  const fingerprints={};
  for (const child of children) for (const url of sitemapUrls(readFileSync(join(target,child.pathname.slice(1)),'utf8'))) {
    if (url in fingerprints) throw Error('Duplicate URL across page sitemaps');
    const path=new URL(url).pathname+'index.html', verified=remote.get(path);
    const bytes=readFileSync(join(verified?join(root,'dist'):target,path.slice(1)));
    if (verified && (verified.sha256!==sha(bytes) || verified.bytes!==bytes.length)) throw Error('Local page differs from verified R2 original');
    const html=bytes.toString('utf8');
    if (!html.includes(`name="build-revision" content="${revision}"`)) throw Error('Release HTML belongs to another revision');
    const canonical=[...html.matchAll(/<link\b[^>]*>/gi)].map(m=>attributes(m[0])).filter(a=>a.rel==='canonical');
    if (canonical.length!==1 || canonical[0].href!==url) throw Error('Sitemap page canonical differs from its submitted URL');
    fingerprints[url]=contentFingerprint(html);
  }
  const snapshot={schema:1,revision,verifiedRoot:manifest.root,createdAt:new Date().toISOString(),fingerprints};
  writeFileSync(join(root,'work/delivery',revision,'indexnow-snapshot.json'),JSON.stringify(snapshot)+'\n');
  return {urls:Object.keys(fingerprints).length,revision};
}

export async function runIndexNow({root, send=false, initialize=false, attempts=1}) {
  const config = JSON.parse(readFileSync(join(root,'config/indexnow.json'),'utf8'));
  if (config.host !== 'ultraclipart.com' || !/^[a-f0-9]{32}$/.test(config.key) || config.project !== 'ultraclipart' || !/^[a-f0-9]{32}$/.test(config.accountId)) throw Error('Invalid site-scoped IndexNow configuration');
  const revision = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const manifest = JSON.parse(readFileSync(join(root,'work/delivery',revision,'verified-manifest.json'),'utf8'));
  const snapshot = JSON.parse(readFileSync(join(root,'work/delivery',revision,'indexnow-snapshot.json'),'utf8'));
  if (snapshot.schema!==1 || snapshot.revision!==revision || snapshot.verifiedRoot!==manifest.root || !snapshot.fingerprints || !Object.keys(snapshot.fingerprints).length) throw Error('Missing or stale checked IndexNow content snapshot');
  const current = snapshot.fingerprints;
  for (const [url,hash] of Object.entries(current)) {
    canonicalUrl(url);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid content fingerprint');
  }
  const dir = indexNowStateDirectory(root), ledger = join(dir,'accepted.json');
  const readPrior = () => {
    const prior = existsSync(ledger) ? JSON.parse(readFileSync(ledger,'utf8')) : null;
    if (prior && (prior.schema!==1 || prior.host!==config.host || prior.keySha256!==sha(config.key) || !prior.fingerprints || typeof prior.fingerprints!=='object' || Array.isArray(prior.fingerprints))) throw Error('IndexNow ledger belongs to another site/key or is invalid');
    if (prior) for (const [url, hash] of Object.entries(prior.fingerprints)) { canonicalUrl(url); if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid accepted fingerprint'); }
    return prior;
  };
  const prior = readPrior(), plan = changes(prior?.fingerprints ?? {},current);
  if (!send) return {status:'DRY_RUN_NO_SUBMISSION',revision,updated:plan.updated.length,removed:plan.removed.length};
  mkdirSync(dir,{recursive:true});
  const lock = join(dir,'send.lock'), fd = openSync(lock,'wx');
  try {
    // Re-read only after the exclusive lock: another sender may have finished
    // between this process's dry planning and lock acquisition.
    const lockedPrior = readPrior(), previous = lockedPrior?.fingerprints ?? {};
    if (lockedPrior && initialize) throw Error('IndexNow is already initialized; retry with --send only');
    if (!lockedPrior && !initialize) throw Error('IndexNow ledger missing: review and initialize once; never silently replay the whole catalog');
    const prepared=JSON.parse(readFileSync(join(root,'work/delivery',revision,'prepared-release.json'),'utf8'));
    const {configuredToken} = await import('../r2/cloudflare-api.mjs');
    const token = configuredToken();
    let deploymentId;
    for (let attempt=0; attempt<attempts; attempt++) {
      try {
        const api = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/pages/projects/${config.project}`,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(30000)});
        if (!api.ok) throw Error(`Production metadata unavailable (HTTP ${api.status})`);
        const data = await api.json();
        if (!data.success) throw Error('Cloudflare did not confirm production metadata');
        const receipt = await fetch(`${SITE}/delivery-release.json`,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});
        const home = await fetch(SITE+'/',{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});
        if (!receipt.ok || !home.ok) throw Error('Live production evidence is unavailable');
        if (/\b(noindex|none)\b/i.test(home.headers.get('x-robots-tag') ?? '')) throw Error('Live production has an indexing block');
        const release=await receipt.json();
        if (release.workerSha256!==prepared.workerSha256 || prepared.verifiedRoot!==manifest.root) throw Error('Live release wrapper differs from the checked package');
        deploymentId = assertProduction(data.result,release,manifest,revision,await home.text());
        break;
      } catch (error) {
        if (attempt+1===attempts) throw error;
        console.log(`IndexNow waiting for exact production evidence (${attempt+1}/${attempts})`);
        await delay(15000);
      }
    }
    const keyResponse = await fetch(`${SITE}/${config.key}.txt`,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});
    if (keyResponse.status!==200 || (await keyResponse.text()).trim()!==config.key) throw Error('Live IndexNow verification file is missing or incorrect');
    const save = (fingerprints,receipts) => {
      const data = {schema:1,host:config.host,keySha256:sha(config.key),revision,deploymentId,verifiedRoot:manifest.root,acceptedAt:new Date().toISOString(),fingerprints,receipts:[...(lockedPrior?.receipts??[]),...receipts]};
      const temp = ledger+'.'+randomUUID()+'.tmp';
      writeFileSync(temp,JSON.stringify(data)+'\n',{mode:0o600});renameSync(temp,ledger);
    };
    const result = await sendChanges({previous,current,config,save});
    const report = {status:'INDEXNOW_RECEIVED_NOT_INDEXING_GUARANTEE',revision,deploymentId,verifiedRoot:manifest.root,...result};
    writeFileSync(join(dir,'last-result.json'),JSON.stringify(report,null,2)+'\n');
    return report;
  } finally {closeSync(fd);unlinkSync(lock);}
}

if (process.argv[1] && resolve(process.argv[1])===resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  try {console.log(JSON.stringify(await runIndexNow({root:resolve(import.meta.dirname,'../..'),send:args.includes('--send'),initialize:args.includes('--initialize'),attempts:args.includes('--wait')?12:1})));}
  catch (error) {console.error(error.message);process.exitCode=1;}
}
