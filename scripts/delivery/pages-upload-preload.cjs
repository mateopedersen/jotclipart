'use strict';
const fs = require('node:fs'),
  Module = require('node:module'),
  crypto = require('node:crypto'),
  path = require('node:path');
const target = fs.realpathSync(
  path.resolve(__dirname, '../../node_modules/wrangler/wrangler-dist/cli.js'),
);
const manager = path.join(__dirname, 'pages-session-manager.cjs');
const originalSource = fs.readFileSync(target, 'utf8');
const fingerprint = crypto.createHash('sha256').update(originalSource).digest('hex');
if (fingerprint !== '85a0fd68160392c7b9233a2a3406a94d61ab2a84d6dc192ebcb758774a76ee61')
  throw Error('Pinned Pages uploader changed; review transport before publication');
const replaceOne = (source, before, after) => {
  if (source.split(before).length !== 2)
    throw Error('Pinned upload transport changed; stop before writes');
  return source.replace(before, after);
};
const sectionStart = originalSource.indexOf('upload = /* @__PURE__ */ __name(async (args) => {');
const sectionEnd = originalSource.indexOf(
  'maxFileCountAllowedFromClaims = /* @__PURE__ */',
  sectionStart,
);
if (sectionStart < 0 || sectionEnd <= sectionStart)
  throw Error('Missing pinned Pages upload section');
let patched = replaceOne(
  originalSource.slice(sectionStart, sectionEnd),
  'const files = [...args.fileMap.values()];\n      let jwt2 = await fetchJwt();\n      const start',
  'const files = [...args.fileMap.values()];\n      let jwt2 = await fetchJwt();\n      const __ucSessions = require(' +
    JSON.stringify(manager) +
    ');\n      const __ucRenew = __ucSessions.createSessionManager(fetchJwt, token => { jwt2 = token; });\n      const start',
);
patched = replaceOne(
  patched,
  'attempts = 0;\n        let gatewayErrors = 0;\n        const doUpload',
  'let attempts = 0;\n        let gatewayErrors = 0;\n        let __ucSessionRetries = 0;\n        const doUpload',
);
patched = replaceOne(
  patched,
  'const doUpload = /* @__PURE__ */ __name(async () => {\n          const payload',
  'const doUpload = /* @__PURE__ */ __name(async () => {\n          await __ucRenew();\n          try {\n          const __ucMissing = new Set(await fetchResult2(COMPLIANCE_REGION_CONFIG_PUBLIC, `/pages/assets/check-missing`, {method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${jwt2}`},body:JSON.stringify({hashes:bucket.files.map(file=>file.hash)})}));\n          const __ucPendingFiles = bucket.files.filter(file=>__ucMissing.has(file.hash));\n          if (!__ucPendingFiles.length) return;\n          const payload',
);
patched = replaceOne(
  patched,
  '          try {\n            logger2.debug("POST /pages/assets/upload");',
  '            logger2.debug("POST /pages/assets/upload");',
);
patched = replaceOne(
  patched,
  'bucket.files.map(async (file3) => ({',
  '__ucPendingFiles.map(async (file3) => ({',
);
patched = replaceOne(
  patched,
  'logger2.debug("result:", res);',
  'logger2.debug("result:", res);\n            const __ucAccepted = __ucPendingFiles.map(file=>file.hash);\n            __ucSessions.recordAccepted(__ucAccepted);\n            await fetchResult2(COMPLIANCE_REGION_CONFIG_PUBLIC, `/pages/assets/upsert-hashes`, {method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${jwt2}`},body:JSON.stringify({hashes:__ucAccepted})});',
);
patched = replaceOne(
  patched,
  '} catch (e11) {\n            if (attempts < MAX_UPLOAD_ATTEMPTS2)',
  '} catch (e11) {\n            if (__ucSessions.expiredSession(e11) && __ucSessionRetries < 2) {\n              __ucSessionRetries++;\n              await __ucRenew(true);\n              return doUpload();\n            }\n            if (attempts < MAX_UPLOAD_ATTEMPTS2)',
);
patched = originalSource.slice(0, sectionStart) + patched + originalSource.slice(sectionEnd);
patched = replaceOne(patched, 'BULK_UPLOAD_CONCURRENCY2 = 3;', 'BULK_UPLOAD_CONCURRENCY2 = 6;');
new (require('node:vm').Script)(patched, { filename: target });
if (process.env.UC_PAGES_PATCH_CHECK === '1') {
  console.log(
    JSON.stringify({
      status: 'PATCH_SYNTAX_VALID',
      version: '4.151.3',
      sourceSha256: fingerprint,
      refreshMinutes: 25,
      concurrency: 6,
      sourceFileModified: false,
    }),
  );
} else {
  const loader = Module._extensions['.js'];
  Module._extensions['.js'] = function (module, filename) {
    if (fs.realpathSync(filename) !== target) return loader(module, filename);
    if (crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') !== fingerprint)
      throw Error('Upload dependency changed after verification');
    module._compile(patched, filename);
  };
}
