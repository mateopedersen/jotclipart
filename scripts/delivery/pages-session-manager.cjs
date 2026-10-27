'use strict';
const fs = require('node:fs');
exports.recordAccepted = (hashes) => {
  if (!process.env.UC_PAGES_ACCEPTED_JOURNAL) return;
  if (
    !Array.isArray(hashes) ||
    !hashes.length ||
    hashes.some((h) => typeof h !== 'string' || !/^[a-f0-9]{20,128}$/.test(h))
  )
    throw Error('Invalid accepted asset checkpoint');
  fs.appendFileSync(
    process.env.UC_PAGES_ACCEPTED_JOURNAL,
    JSON.stringify({ kind: 'accepted-upload', at: new Date().toISOString(), hashes }) + '\n',
  );
};
exports.expiredSession = (error) =>
  error?.code === 8000013 ||
  (Array.isArray(error?.notes) &&
    error.notes.some((note) => /\bexpired jwt\b/i.test(note?.text ?? '')));
exports.createSessionManager = (fetchToken, applyToken, now = Date.now) => {
  let refreshedAt = now(),
    pending;
  return async (force = false) => {
    if (!force && now() - refreshedAt < 25 * 60 * 1000) return;
    if (!pending) {
      pending = Promise.resolve()
        .then(fetchToken)
        .then((token) => {
          if (typeof token !== 'string' || !token)
            throw Error('Upload session renewal returned no token');
          applyToken(token);
          refreshedAt = now();
        })
        .finally(() => {
          pending = undefined;
        });
    }
    await pending;
  };
};
