// Immutable intake before extraction. APFS clones avoid duplicate physical data.
import {
  copyFileSync,
  constants,
  mkdirSync,
  lstatSync,
  writeFileSync,
  createReadStream,
} from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
export async function intakeArchive(source, directory) {
  source = resolve(source);
  directory = resolve(directory);
  if (
    !directory.startsWith(resolve('work') + '/') ||
    !source.toLowerCase().endsWith('.zip') ||
    lstatSync(source).isSymbolicLink() ||
    !lstatSync(source).isFile()
  )
    throw Error('Regular ZIP and private task intake directory required');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, basename(source));
  if (target === source) throw Error('Separate immutable archive copy required');
  const digest = async (file) => {
    const h = createHash('sha256');
    let bytes = 0;
    for await (const b of createReadStream(file)) {
      h.update(b);
      bytes += b.length;
    }
    return { bytes, sha256: h.digest('hex') };
  };
  const original = await digest(source);
  copyFileSync(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const stored = await digest(target);
  if (original.bytes !== stored.bytes || original.sha256 !== stored.sha256)
    throw Error('Immutable intake copy differs');
  const inventory = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        "import zipfile,json,sys,posixpath; z=zipfile.ZipFile(sys.argv[1]); rows=z.infolist(); assert all(not r.filename.startswith('/') and '..' not in r.filename.replace('\\\\','/').split('/') and not ((r.external_attr>>16)&0o170000)==0o120000 for r in rows); bad=z.testzip(); assert bad is None, str(bad); print(json.dumps({'entries':len(rows),'files':sum(not r.is_dir() for r in rows),'uncompressedBytes':sum(r.file_size for r in rows),'pdfs':sum(r.filename.lower().endswith('.pdf') for r in rows),'webps':sum(r.filename.lower().endswith('.webp') for r in rows),'crc':'ALL_MEMBERS_READ_AND_CRC_VERIFIED'}))",
        target,
      ],
      { maxBuffer: 100000, timeout: 600000 },
    ),
  );
  const receipt = {
    status: 'PRIVATE_IMMUTABLE_ZIP_COPY_AND_CRC_VERIFIED',
    source,
    archive: target,
    ...stored,
    inventory,
    at: new Date().toISOString(),
    extractedCopies: 0,
  };
  writeFileSync(join(directory, 'intake-receipt.json'), JSON.stringify(receipt, null, 2), {
    flag: 'wx',
  });
  return receipt;
}
