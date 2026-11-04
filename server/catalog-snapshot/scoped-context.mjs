import { AsyncLocalStorage } from 'node:async_hooks';

/** One isolated state store per compiled renderer, including enumerable object views. */
export function createScopedContext() {
  const requestState = new AsyncLocalStorage();
  function current() {
    const value = requestState.getStore();
    if (!value) throw Error('Collection SSR requires an isolated request snapshot');
    return value;
  }
  function scoped(key, target = {}) {
    if (typeof key !== 'string' || !key || !target || typeof target !== 'object' ||
        !Reflect.isExtensible(target) || Reflect.ownKeys(target).some(property => {
          const d=Reflect.getOwnPropertyDescriptor(target,property);
          return !d.configurable && !(Array.isArray(target) && property==='length' && d.writable);
        })) throw Error('An extensible scoped view target is required');
    const object = () => {
      const value = current()[key];
      if (!value || typeof value !== 'object' || Array.isArray(value) !== Array.isArray(target))
        throw Error('Invalid request-scoped object: ' + key);
      return value;
    };
    return new Proxy(target, {
      get(_, property) {
        const value = object();
        const result = Reflect.get(value, property);
        return typeof result === 'function' ? result.bind(value) : result;
      },
      has(_, property) { return Reflect.has(object(), property); },
      ownKeys() { return Reflect.ownKeys(object()); },
      getOwnPropertyDescriptor(_, property) {
        const value = object(), fixed = Reflect.getOwnPropertyDescriptor(target, property);
        // Array length is non-configurable on the proxy target. Preserve its
        // invariant while forwarding the current array's readable length.
        if (fixed && !fixed.configurable) {
          return 'value' in fixed && fixed.writable
            ? { ...fixed, value: Reflect.get(value, property) }
            : fixed;
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
      getPrototypeOf() { return Reflect.getPrototypeOf(object()); },
      // View reflection must not mutate or freeze the empty proxy target.
      set() { return false; },
      defineProperty() { return false; },
      deleteProperty() { return false; },
      setPrototypeOf() { return false; },
      preventExtensions() { return false; },
    });
  }
  return { requestState, current, scoped };
}
