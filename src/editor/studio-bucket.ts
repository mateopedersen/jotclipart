/** Same stable partition in the build and browser; IDs are ASCII catalog keys. */
export function studioBucket(id: string) {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 33) ^ id.charCodeAt(i)) >>> 0;
  return (hash & 255).toString(16).padStart(2, '0');
}
