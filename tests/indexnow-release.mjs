import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonicalUrl,sitemapUrls,contentFingerprint,changes,notificationRevisions,assertProduction,sendChanges} from '../scripts/seo/indexnow-release.mjs';
const revision='a'.repeat(40),root='b'.repeat(64),url='https://ultraclipart.com/clipart/macbook/';
test('only canonical public sitemap URLs can be submitted',()=>{
  for(const bad of ['https://other.example/','https://ultraclipart.com/edit/x/','https://ultraclipart.com/clipart/macbook/?q=x','https://ultraclipart.com/clipart/macbook/#x','http://ultraclipart.com/'])assert.throws(()=>canonicalUrl(bad));
  assert.deepEqual(sitemapUrls(`<urlset><url><loc>${url}</loc></url></urlset>`),[url]);
  assert.throws(()=>sitemapUrls(`<urlset><url><loc>${url}</loc></url><url><loc>${url}</loc></url></urlset>`));
});
test('revision-only changes do not resubmit content; real text changes do',()=>{
  const html=r=>`<meta name="build-revision" content="${r}"><main><h1>MacBook</h1></main>`;
  assert.equal(contentFingerprint(html(revision)),contentFingerprint(html('c'.repeat(40))));
  assert.notEqual(contentFingerprint(html(revision)),contentFingerprint(html(revision).replace('MacBook','Caroling')));
  assert.throws(()=>contentFingerprint('<meta name="robots" content="noindex, follow">'));
  assert.deepEqual(changes({[url]:'same'},{[url]:'same'}),{updated:[],removed:[]});
});
test('runtime bundle, stats, global catalog counts and CSS stamps are ignored',()=>{
  const html=(revision,stamp,count)=>`<meta name="build-revision" content="${revision}"><script src="/_astro/runtime.${stamp}.js"></script><style>.${stamp}{color:blue}</style><header>${count} artwork</header><main><script type="application/json">{"statsVersion":"${stamp}"}</script><h1>MacBook</h1><img src="https://assets.ultraclipart.com/macbook/original.hash.webp" alt="Laptop"></main><footer>${count} artwork</footer>`;
  assert.equal(contentFingerprint(html(revision,'old',15084)),contentFingerprint(html('c'.repeat(40),'new',17559)));
});
test('image identity, links and structured metadata are meaningful content changes',()=>{
  const html='<main><h1>MacBook</h1><img src="/original.webp" alt="Open laptop"><a href="/art/laptop/">Details</a></main><script type="application/ld+json">{"name":"Laptop"}</script>';
  for(const changed of [html.replace('original.webp','replacement.webp'),html.replace('Open laptop','Closed laptop'),html.replace('/art/laptop/','/art/other/'),html.replace('"Laptop"','"Other"')])assert.notEqual(contentFingerprint(html),contentFingerprint(changed));
});
test('wrong canonical deployment, rendered revision and delivery root block notification',()=>{
  const project={canonical_deployment:{id:'deployment',environment:'production',latest_stage:{status:'success'},deployment_trigger:{metadata:{commit_hash:revision}}}};
  const release={renderedRevision:revision,controlRevision:revision,verifiedRoot:root},manifest={status:'remote-byte-verified',revision,root},html=`name="build-revision" content="${revision}"`;
  assert.equal(assertProduction(project,release,manifest,revision,html),'deployment');
  for(const changed of [{...release,controlRevision:'c'.repeat(40)},{...release,verifiedRoot:'d'.repeat(64)}])assert.throws(()=>assertProduction(project,changed,manifest,revision,html));
  assert.throws(()=>assertProduction({...project,canonical_deployment:{...project.canonical_deployment,environment:'preview'}},release,manifest,revision,html));
});
test('notification accepts only the explicitly verified separate renderer and control revisions',()=>{
  const control='c'.repeat(40);
  const project={canonical_deployment:{id:'control-deployment',environment:'production',latest_stage:{status:'success'},deployment_trigger:{metadata:{commit_hash:control}}}};
  const release={renderedRevision:revision,controlRevision:control,verifiedRoot:root},manifest={status:'remote-byte-verified',revision,root},html=`name="build-revision" content="${revision}"`;
  assert.equal(assertProduction(project,release,manifest,revision,html,control),'control-deployment');
  assert.throws(()=>assertProduction(project,release,manifest,revision,html));
  assert.throws(()=>assertProduction(project,{...release,controlRevision:revision},manifest,revision,html,control));
  assert.throws(()=>assertProduction(project,release,manifest,revision,html,'invalid'));
});
test('notification retry can pin exact live revisions from a descendant tooling checkout',()=>{
  const head='c'.repeat(40), control='d'.repeat(40), rendered='e'.repeat(40);
  const isAncestor=(a,b)=>a===control&&b===head || a===rendered&&b===control;
  assert.deepEqual(notificationRevisions({head,isAncestor}),{revision:head,controlRevision:head});
  assert.deepEqual(notificationRevisions({head,controlRevision:control,renderedRevision:rendered,isAncestor}),{revision:rendered,controlRevision:control});
  assert.throws(()=>notificationRevisions({head,controlRevision:'f'.repeat(40),isAncestor}),/not an ancestor/);
  assert.throws(()=>notificationRevisions({head,controlRevision:control,renderedRevision:'f'.repeat(40),isAncestor}),/not an ancestor/);
  assert.throws(()=>notificationRevisions({head,controlRevision:'bad',isAncestor}),/Invalid/);
});
test('accepted batches survive later failure and cannot be replayed on retry',async()=>{
  const current=Object.fromEntries(Array.from({length:10001},(_,i)=>[`https://ultraclipart.com/art/item-${i}/`,'hash']));let calls=0,saved={};
  await assert.rejects(sendChanges({previous:{},current,config:{host:'ultraclipart.com',key:'a'.repeat(32)},request:async()=>({status:++calls===1?200:429}),save:async s=>{saved=s},wait:async()=>{}}),/429/);
  assert.equal(Object.keys(saved).length,10000);
  const result=await sendChanges({previous:saved,current,config:{host:'ultraclipart.com',key:'a'.repeat(32)},request:async(_,options)=>{assert.equal(JSON.parse(options.body).urlList.length,1);return{status:202}},save:async()=>{}});
  assert.equal(result.updated,1);assert.equal(result.receipts[0].keyValidationPending,true);
});
test('deleted URLs require real 404 or 410 before notifying',async()=>{
  let posts=0;await assert.rejects(sendChanges({previous:{[url]:'old'},current:{},config:{},request:async(_,o)=>{if(o.method==='POST')posts++;return{status:200}},save:async()=>{}}),/still live/);assert.equal(posts,0);
});

test('permanent same-site redirect to exact verified canonical content is safely notified',async()=>{
  const target='https://ultraclipart.com/clipart/laptop/';
  const html=`<link rel="canonical" href="${target}"><main><h1>Laptop</h1></main>`;
  for(const status of [301,308]){
    const sent=[],saves=[];
    const result=await sendChanges({previous:{[url]:'old'},current:{[target]:contentFingerprint(html)},config:{host:'ultraclipart.com',key:'a'.repeat(32)},
      request:async(u,o)=>{if(o.method==='HEAD'){assert.equal(u,url);return {status,headers:new Headers({location:'/clipart/laptop/'})};}
        if(o.method==='GET'){assert.equal(u,target);assert.equal(o.redirect,'manual');return {status:200,text:async()=>html};}
        sent.push(...JSON.parse(o.body).urlList);return {status:200};},save:async state=>saves.push(state)});
    assert.deepEqual(new Set(sent),new Set([url,target]));assert.equal(result.redirected,1);assert.equal(result.removed,1);
    assert.equal(saves.at(-1)[url],undefined);assert.equal(saves.at(-1)[target],contentFingerprint(html));
  }
});

test('redirect notification fails closed for unsafe destinations, stale content and temporary moves',async()=>{
  const target='https://ultraclipart.com/clipart/laptop/';
  const html=`<link rel="canonical" href="${target}"><main><h1>Laptop</h1></main>`;
  const current={[target]:contentFingerprint(html)};
  const cases=[
    {status:302,location:target}, {status:301,location:'https://elsewhere.example/'},
    {status:301,location:url}, {status:301,location:target+'?q=x'},
    {status:301,location:'https://ultraclipart.com/clipart/unknown/'},
    {status:301,location:target,targetStatus:301},
    {status:301,location:target,targetHtml:html.replace('Laptop','Changed')},
    {status:301,location:target,targetHtml:html.replace(target,url)},
    {status:301,location:target,targetHtml:'<meta name="robots" content="noindex">'+html},
    {status:301,location:target,targetRobots:'noindex'},
    {status:301},
  ];
  for(const row of cases){let posts=0;
    await assert.rejects(sendChanges({previous:{[url]:'old'},current,config:{},save:async()=>{},request:async(u,o)=>{
      if(o.method==='HEAD')return {status:row.status,headers:new Headers(row.location?{location:row.location}:{})};
      if(o.method==='GET')return {status:row.targetStatus??200,headers:new Headers(row.targetRobots?{'x-robots-tag':row.targetRobots}:{}),text:async()=>row.targetHtml??html};
      posts++;return {status:200};
    }}));assert.equal(posts,0);
  }
});

test('real deletions still notify only after a confirmed 404 or 410',async()=>{
  for(const status of [404,410]){let posts=0,last;
    const result=await sendChanges({previous:{[url]:'old'},current:{},config:{host:'ultraclipart.com',key:'a'.repeat(32)},
      request:async(_,o)=>o.method==='HEAD'?{status}:(posts++,{status:200}),save:async value=>{last=value;}});
    assert.equal(posts,1);assert.equal(result.removed,1);assert.equal(result.redirected,0);assert.equal(last[url],undefined);
  }
});

test('userinfo and noncanonical schemes are never public submission URLs',()=>{
  assert.throws(()=>canonicalUrl('https://user:pass@ultraclipart.com/art/example/'));
});

test('content snapshot rejects altered offloaded bytes and mismatched canonical URLs',async()=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),crypto=await import('node:crypto');
  const {prepareIndexNowSnapshot}=await import('../scripts/seo/indexnow-release.mjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'uc-indexnow-test-')),target=path.join(root,'package');
  try {
    fs.mkdirSync(target,{recursive:true});fs.mkdirSync(path.join(root,'dist/art/example'),{recursive:true});fs.mkdirSync(path.join(root,'work/delivery',revision),{recursive:true});
    fs.writeFileSync(path.join(target,'sitemap.xml'),'<sitemapindex><sitemap><loc>https://ultraclipart.com/sitemap-pages.xml</loc></sitemap></sitemapindex>');
    const url='https://ultraclipart.com/art/example/';
    fs.writeFileSync(path.join(target,'sitemap-pages.xml'),`<urlset><url><loc>${url}</loc></url></urlset>`);
    const file=path.join(root,'dist/art/example/index.html');
    const html=`<meta name="build-revision" content="${revision}"><link rel="canonical" href="${url}"><main>Original</main>`;
    fs.writeFileSync(file,html);
    const manifest={status:'remote-byte-verified',revision,root:'b'.repeat(64),files:[{path:'/art/example/index.html',bytes:Buffer.byteLength(html),sha256:crypto.createHash('sha256').update(html).digest('hex')}]};
    assert.equal(prepareIndexNowSnapshot({root,target,revision,manifest}).urls,1);
    fs.writeFileSync(file,html.replace('Original','Modified'));
    assert.throws(()=>prepareIndexNowSnapshot({root,target,revision,manifest}),/differs from verified/);
    const wrong=html.replace(url,'https://ultraclipart.com/art/other/');fs.writeFileSync(file,wrong);manifest.files[0].bytes=Buffer.byteLength(wrong);manifest.files[0].sha256=crypto.createHash('sha256').update(wrong).digest('hex');
    assert.throws(()=>prepareIndexNowSnapshot({root,target,revision,manifest}),/canonical differs/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
