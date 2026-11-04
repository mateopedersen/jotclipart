// Request-local work only. Never caches visitor queries or expands the shared
// R2 body-consumption budget enforced by the caller.
export async function mapFour(values, work) {
  const result = Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await work(values[index], index);
    }
  }));
  return result;
}
