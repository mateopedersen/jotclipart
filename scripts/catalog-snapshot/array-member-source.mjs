// Select one member from an already checksum-verified array without creating
// an in-memory object graph for every unrelated source topic.
export function verifiedArrayMember(bytes, key, value) {
  const needle = Buffer.from(JSON.stringify(key) + ':' + JSON.stringify(value));
  const spaced = Buffer.from(JSON.stringify(key) + ': ' + JSON.stringify(value));
  let depth = 0,
    start = -1,
    string = false,
    escaped = false;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (string) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true;
      else if (c === 34) string = false;
      continue;
    }
    if (c === 34) {
      string = true;
      continue;
    }
    if (c === 123) {
      if (depth === 0) start = i;
      depth++;
    } else if (c === 125) {
      if (--depth < 0) throw Error('Malformed verified source array');
      if (depth === 0) {
        const row = bytes.subarray(start, i + 1);
        if (row.includes(needle) || row.includes(spaced)) {
          const object = JSON.parse(row);
          if (object[key] === value) return object;
        }
      }
    }
  }
  throw Error('Requested member is absent from the verified source array');
}
