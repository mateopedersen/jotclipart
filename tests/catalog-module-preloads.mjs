import test from'node:test';import assert from'node:assert/strict';import{preloadDocumentModules}from'../server/catalog-snapshot/module-preloads.mjs';const rev='a'.repeat(40),url='/__ssr-client/'+rev+'/script-0-HASH.js';
test('document module preloads are early, deduplicated and never execute extra scripts',()=>{const html='<head></head><body><script type="module" src="'+url+'"></script><script type="module" src="'+url+'"></script></body>',result=preloadDocumentModules(html,rev);assert.equal((result.match(/rel="modulepreload"/g)||[]).length,1);assert(result.indexOf('rel="modulepreload"')<result.indexOf('</head>'));assert.equal((result.match(/<script/g)||[]).length,2);assert.equal(preloadDocumentModules(result,rev),result)});
test('other revisions, remote scripts, inert JSON and unapproved module names are not preloaded',()=>{const html='<head></head><script type="application/ld+json">{}</script><script src="https://external.invalid/script.js"></script><script type="module" src="/__ssr-client/'+ 'b'.repeat(40)+'/other.js"></script><script type="module" src="'+url+'?query=1"></script>';assert.equal(preloadDocumentModules(html,rev),html);assert.throws(()=>preloadDocumentModules(html,'invalid'))});

test('an optional page module stays inert and its private dependencies are not preloaded', () => {
  const optional = url.replace('script-0', 'script-1');
  const dependency = url.replace('script-0', 'chunk-optional');
  const source = '<head></head><body><script type="module" src="' + url + '"></script><script type="module" src="' + optional + '"></script></body>';
  const graph = { [optional]: [dependency] };
  const rendered = preloadDocumentModules(source, rev, graph, [optional]);
  assert.ok(rendered.includes('<script type="application/json" data-uc-later-module="' + optional + '"></script>'));
  assert.ok(!rendered.includes('src="' + optional + '"'));
  assert.ok(rendered.includes('<link rel="modulepreload" href="' + url + '">'));
  assert.ok(!rendered.includes('<link rel="modulepreload" href="' + optional + '">'));
  assert.ok(!rendered.includes(dependency));
  assert.equal(preloadDocumentModules(rendered, rev, graph, [optional]), rendered);
});
