#!/usr/bin/env node

// The legacy S3/REST transport used a whole-account census both for a storage
// cap and to decide whether an object already existed. Removing the cap alone
// would leave its resume/ambiguous-write behavior without that evidence. Keep
// it disabled until an independently tested replacement exists; reviewed
// imports use the bounded binding transport instead.
const guidance =
  'The legacy S3/REST uploader is disabled. Use the reviewed binding uploader: ' +
  'node scripts/r2/binding-ingest.mjs <reviewed-input.json> [--check|--pilot].';

if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log(guidance);
} else {
  console.error(guidance);
  process.exitCode = 1;
}
