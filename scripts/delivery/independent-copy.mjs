/** Independent, scoped file copies for the local publisher.
 * On macOS arm64, fclonefileat shares blocks without sharing a mutable inode.
 * The caller's existing source SHA/HMAC gate remains responsible for content
 * approval. A physical fallback is explicit, bounded and never hides errors. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadPinnedNative } from './native-clone/attested-native-loader.mjs';

const FIVE_GIB = 5n * 1024n ** 3n;
const unsupported = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);
const identity = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
let native;

function bytes(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = BigInt(value);
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error(`${label} must be a nonnegative safe byte count`);
  return value;
}

function root(input) {
  const logical = path.resolve(input), st = fs.lstatSync(logical);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('Copy root must be a real directory');
  return { logical, actual: fs.realpathSync(logical) };
}

function scoped(base, file) {
  const relative = path.relative(base.logical, path.resolve(file));
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
    throw Error('Copy path is outside its approved root');
  return path.join(base.actual, relative);
}

function backend() {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    native ??= loadPinnedNative();
    return { ...native, cloneMethod: 'darwin-fclonefileat' };
  }
  if (process.platform === 'linux' && fs.existsSync('/proc/self/fd')) {
    // The source and parent are pinned descriptors. Try the filesystem's COW
    // clone first; physical fallback is allowed only when that attempt actually
    // reports an unsupported operation and has not left a destination behind.
    const fdPath = (fd, name = '') => `/proc/self/fd/${fd}${name ? `/${name}` : ''}`;
    return {
      cloneMethod: 'linux-ficlone',
      freeBytesFd(fd) {
        const s = fs.statfsSync(fdPath(fd), { bigint: true });
        return s.bavail * s.bsize;
      },
      cloneFd(sourceFd, directoryFd, name) {
        if (!Number.isInteger(fs.constants.COPYFILE_FICLONE_FORCE) ||
            !Number.isInteger(fs.constants.COPYFILE_EXCL))
          throw Error('Exclusive Linux clone flags are unavailable');
        const target = fdPath(directoryFd, name);
        try {
          fs.copyFileSync(fdPath(sourceFd), target,
            fs.constants.COPYFILE_FICLONE_FORCE | fs.constants.COPYFILE_EXCL);
        } catch (error) {
          if (unsupported.has(error.code)) {
            try { fs.lstatSync(target); }
            catch (check) {
              if (check.code !== 'ENOENT') throw check;
              error.created = false;
              error.cloneOperation = 'linux-ficlone';
            }
          }
          throw error;
        }
        return fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      },
      createTargetFd(fd, name) {
        return fs.openSync(fdPath(fd, name), fs.constants.O_RDWR | fs.constants.O_CREAT |
          fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      },
      replaceFd(fd, temporary, target, tempDev, tempIno, oldDev, oldIno) {
        const a = fs.lstatSync(fdPath(fd, temporary), { bigint: true });
        const b = fs.lstatSync(fdPath(fd, target), { bigint: true });
        if (!a.isFile() || !b.isFile() || a.dev !== tempDev || a.ino !== tempIno ||
            b.dev !== oldDev || b.ino !== oldIno)
          throw Error('Replacement identity changed');
        fs.renameSync(fdPath(fd, temporary), fdPath(fd, target));
      },
    };
  }
  throw Error('No safe descriptor-anchored copy backend for this platform');
}

function physicalCopy(sourceFd, targetFd, length) {
  const buffer = Buffer.alloc(128 * 1024);
  let offset = 0;
  while (offset < length) {
    const n = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, length - offset), offset);
    if (!n) throw Error('Source shortened during bounded fallback');
    let written = 0;
    while (written < n) {
      const count = fs.writeSync(targetFd, buffer, written, n - written, offset + written);
      if (!count) throw Error('Bounded fallback write made no progress');
      written += count;
    }
    offset += n;
  }
  if (fs.readSync(sourceFd, buffer, 0, 1, length)) throw Error('Source grew during bounded fallback');
}

export function createIndependentCopier({
  sourceRoot,
  destinationRoot,
  minFreeBytes = FIVE_GIB,
  maxFallbackBytes,
}) {
  const srcRoot = root(sourceRoot), dstRoot = root(destinationRoot);
  const floor = bytes(minFreeBytes, 'Minimum free space');
  // Linux can use physical copies when its filesystem genuinely cannot clone;
  // bound the entire copier lifetime by space measured here, and recheck the
  // destination's actual descriptor before each physical write. macOS uses
  // native APFS clones and defaults to no physical fallback at all.
  const volume = fs.statfsSync(dstRoot.actual, { bigint: true });
  const available = volume.bavail * volume.bsize;
  const room = available > floor ? available - floor : 0n;
  const requested = maxFallbackBytes === undefined
    ? (process.platform === 'linux' ? room : 0n)
    : bytes(maxFallbackBytes, 'Fallback budget');
  const maxFallback = [requested, room, BigInt(Number.MAX_SAFE_INTEGER)].reduce((a, b) => a < b ? a : b);
  if (!Number.isInteger(fs.constants.O_NOFOLLOW) || !Number.isInteger(fs.constants.O_DIRECTORY))
    throw Error('Safe no-follow file descriptor flags are unavailable');
  let fallbackBytes = 0n, clones = 0, physicalCopies = 0;
  return {
    copy(source, destination, { expectedSourceIdentity, ownerWritable = false, replaceExisting = false } = {}) {
      if (typeof ownerWritable !== 'boolean' || typeof replaceExisting !== 'boolean')
        throw Error('Copy options must be boolean');
      const from = scoped(srcRoot, source), to = scoped(dstRoot, destination), parent = path.dirname(to);
      if (fs.realpathSync(from) !== from || fs.realpathSync(parent) !== parent)
        throw Error('Copy source or destination parent traverses a symlink');
      const nativeApi = backend();
      const sourceFd = fs.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let directoryFd, targetFd, method, replacing = false, previous;
      try {
        directoryFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        const sourceStat = fs.fstatSync(sourceFd, { bigint: true });
        const sourcePath = fs.lstatSync(from, { bigint: true });
        const dirStat = fs.fstatSync(directoryFd, { bigint: true });
        const dirPath = fs.lstatSync(parent, { bigint: true });
        if (!sourceStat.isFile() || !sourcePath.isFile() || !sameInode(sourceStat, sourcePath) ||
            !dirStat.isDirectory() || !sameInode(dirStat, dirPath))
          throw Error('Copy source or destination directory changed');
        const sourceId = identity(sourceStat);
        if (expectedSourceIdentity !== undefined && expectedSourceIdentity !== sourceId)
          throw Error('Copy source differs from verified source identity');
        if (sourceStat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Copy source is too large');
        const length = Number(sourceStat.size), free = nativeApi.freeBytesFd(directoryFd);
        if (typeof free !== 'bigint' || free < floor) throw Error('Copy would breach free-space reserve');
        if (replaceExisting) {
          try {
            previous = fs.lstatSync(to, { bigint: true });
            if (!previous.isFile() || previous.isSymbolicLink() || sameInode(previous, sourceStat))
              throw Error('Existing copy target is not an independent regular file');
            replacing = true;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        const name = replacing ? `.uc-copy-${randomBytes(16).toString('hex')}` : path.basename(to);
        try {
          targetFd = nativeApi.cloneFd(sourceFd, directoryFd, name);
          method = nativeApi.cloneMethod;
        } catch (error) {
          const unsupportedClone = error.syscall === 'fclonefileat' || error.cloneOperation === 'linux-ficlone';
          if (error.created !== false || !unsupportedClone || !unsupported.has(error.code))
            throw error;
          if (sourceStat.size > maxFallback - fallbackBytes)
            throw new Error('Physical fallback exceeds its cumulative byte budget', { cause: error });
          const currentFree = nativeApi.freeBytesFd(directoryFd);
          if (typeof currentFree !== 'bigint' || currentFree < floor + sourceStat.size)
            throw Error('Physical fallback would breach free-space reserve');
          // Reserve before creating the file: even an interrupted copy consumes
          // its full conservative budget and can never trigger a silent retry.
          fallbackBytes += sourceStat.size;
          targetFd = nativeApi.createTargetFd(directoryFd, name);
          physicalCopy(sourceFd, targetFd, length);
          method = 'bounded-physical-copy';
        }
        const targetStat = fs.fstatSync(targetFd, { bigint: true });
        if (!targetStat.isFile() || sameInode(targetStat, sourceStat) || targetStat.size !== sourceStat.size)
          throw Error('Copy target is not an independent exact-size regular file');
        if (identity(fs.fstatSync(sourceFd, { bigint: true })) !== sourceId ||
            identity(fs.lstatSync(from, { bigint: true })) !== sourceId ||
            fs.realpathSync(from) !== from || fs.realpathSync(parent) !== parent ||
            !sameInode(dirStat, fs.lstatSync(parent, { bigint: true })))
          throw Error('Copy source or directory changed during operation');
        if (method === 'bounded-physical-copy' || ownerWritable) {
          const mode = Number(sourceStat.mode & 0o7777n) | (ownerWritable ? 0o200 : 0);
          fs.fchmodSync(targetFd, mode);
        }
        if (replacing)
          nativeApi.replaceFd(directoryFd, name, path.basename(to), targetStat.dev, targetStat.ino,
            previous.dev, previous.ino);
        const destinationStat = fs.lstatSync(to, { bigint: true });
        if (!destinationStat.isFile() || !sameInode(destinationStat, targetStat) || fs.realpathSync(to) !== to)
          throw Error('Copy destination changed during verification');
        if (method !== 'bounded-physical-copy') clones++;
        else physicalCopies++;
        return { method, bytes: length, independentInode: true };
      } finally {
        if (targetFd !== undefined) fs.closeSync(targetFd);
        if (directoryFd !== undefined) fs.closeSync(directoryFd);
        fs.closeSync(sourceFd);
      }
    },
    stats() { return { clones, physicalCopies, fallbackBytes: Number(fallbackBytes), maxFallbackBytes: Number(maxFallback) }; },
  };
}
