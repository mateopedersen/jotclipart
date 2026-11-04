"""Restore one exact archive-backed source to a new protected work path. No upload."""
import argparse
import hashlib
import json
import pathlib
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest_file(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('journal')
parser.add_argument('removed_path')
parser.add_argument('output')
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
work = (root / 'work').resolve()
journal = pathlib.Path(args.journal).resolve()
target = pathlib.Path(args.output).resolve()
require(journal.is_relative_to(work), 'Protected cleanup journal required')
require(target.is_relative_to(work) and not target.exists(), 'New protected target required')
rows = [json.loads(line) for line in journal.read_text().splitlines()]
row = next(item for item in rows if item['removedExpandedCopy'] == args.removed_path)
archive = pathlib.Path(row['preservedNativeZIP']).resolve()
require(archive.is_relative_to(work) and archive.is_file(), 'Protected native ZIP required')
require(digest_file(archive) == row['ZIP_SHA256'], 'Native archive changed')
with zipfile.ZipFile(archive) as container:
    source = container.read(row['member'])  # CRC is checked by zipfile.read.
require(len(source) == row['bytes'], 'Native source size changed')
require(hashlib.sha256(source).hexdigest() == row['memberSHA256'], 'Native source changed')
target.parent.mkdir(parents=True, exist_ok=True)
require(target.parent.resolve().is_relative_to(work), 'Target parent escaped protected work')
with target.open('xb') as stream:
    stream.write(source)
require(digest_file(target) == row['memberSHA256'], 'Restored source changed')
print(json.dumps({
    'status': 'ONE_EXACT_NATIVE_SOURCE_RESTORED_NO_PUBLICATION',
    'output': str(target), 'bytes': len(source), 'sha256': row['memberSHA256'],
}))
