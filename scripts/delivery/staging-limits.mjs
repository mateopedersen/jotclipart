export const IN_FLIGHT_ALLOWANCE_BYTES = 128_000_000;
export const MAX_SINGLE_SOURCE_BYTES = 8_000_000;
export function inventoryPageCount(env = process.env) {
  const value = env.UC_DELIVERY_INVENTORY_PAGES ?? '1';
  if (!/^[1-4]$/.test(value)) throw Error('Inventory page count must be from 1 to 4');
  return Number(value);
}
export function deliveryActorCount(env = process.env) {
  const value = env.UC_DELIVERY_ACTORS ?? '8';
  if (!/^(?:[1-9]|1[0-6])$/.test(value))
    throw Error('Delivery concurrency must be an integer from 1 to 16');
  const actors = Number(value);
  if (actors * MAX_SINGLE_SOURCE_BYTES > IN_FLIGHT_ALLOWANCE_BYTES)
    throw Error('In-flight sources exceed the account reservation allowance');
  return actors;
}
