// A complete inventory can be split by prefixes without relying on the service's
// object order or startAfter comparison. Every discovered child prefix is read,
// and discovery is repeated before returning so changed directory shapes fail
// closed. This is a read-only measurement, never a storage reservation.
export function createPrefixInventoryReader({ fetchPage, concurrency = 16, splitThreshold = 100 }) {
  if (
    typeof fetchPage !== 'function' ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32 ||
    !Number.isInteger(splitThreshold) ||
    splitThreshold < 0
  )
    throw Error('Invalid prefix inventory reader');
  return async function read(command) {
    if (command.cursor !== undefined || command.startAfter !== undefined)
      throw Error('A complete bucket inventory must begin at its root');
    const objects = new Map(),
      discoveries = new Map();
    function add(item, prefix) {
      if (
        typeof item.Key !== 'string' ||
        !item.Key ||
        !item.Key.startsWith(prefix) ||
        !Number.isSafeInteger(item.Size) ||
        item.Size < 0 ||
        objects.has(item.Key)
      )
        throw Error('Invalid, out-of-prefix or duplicate inventory object');
      objects.set(item.Key, item);
    }
    async function pages(prefix, grouped) {
      const rows = [],
        children = [],
        keys = new Set(),
        prefixes = new Set(),
        tokens = new Set();
      let cursor;
      do {
        const page = await fetchPage({
          ...command,
          treeRead: true,
          prefix,
          grouped,
          ...(cursor ? { cursor } : {}),
        });
        if (
          typeof page.IsTruncated !== 'boolean' ||
          !Array.isArray(page.Contents) ||
          !Array.isArray(page.CommonPrefixes) ||
          (!grouped && page.CommonPrefixes.length)
        )
          throw Error('Incomplete prefix inventory page');
        for (const item of page.Contents) {
          if (
            typeof item.Key !== 'string' ||
            !item.Key ||
            !item.Key.startsWith(prefix) ||
            !Number.isSafeInteger(item.Size) ||
            item.Size < 0 ||
            keys.has(item.Key) ||
            (grouped && item.Key.slice(prefix.length).includes('/'))
          )
            throw Error('Invalid grouped inventory object');
          keys.add(item.Key);
          rows.push(item);
        }
        for (const child of page.CommonPrefixes) {
          if (
            typeof child !== 'string' ||
            !child.startsWith(prefix) ||
            child.length <= prefix.length ||
            !child.endsWith('/') ||
            child.slice(prefix.length, -1).includes('/') ||
            prefixes.has(child)
          )
            throw Error('Invalid grouped inventory prefix');
          prefixes.add(child);
          children.push(child);
        }
        cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && (typeof cursor !== 'string' || !cursor || tokens.has(cursor)))
          throw Error('Missing or repeated prefix inventory cursor');
        if (cursor) tokens.add(cursor);
      } while (cursor);
      return { objects: rows, children };
    }
    function signature(group) {
      return JSON.stringify({
        objects: group.objects
          .map(({ Key, Size }) => [Key, Size])
          .sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))),
        children: [...group.children].sort(),
      });
    }
    async function discover(prefix) {
      if (discoveries.has(prefix)) throw Error('Repeated prefix inventory discovery');
      const group = await pages(prefix, true);
      discoveries.set(prefix, signature(group));
      return group;
    }
    async function mapLimit(list, fn) {
      let next = 0;
      const result = new Array(list.length);
      const workers = await Promise.allSettled(
        Array.from({ length: Math.min(concurrency, list.length) }, async () => {
          while (next < list.length) {
            const index = next++;
            result[index] = await fn(list[index]);
          }
        }),
      );
      const failed = workers.find((worker) => worker.status === 'rejected');
      if (failed) throw failed.reason;
      return result;
    }
    const root = await discover('');
    for (const object of root.objects) add(object, '');
    const branches = await mapLimit(root.children, async (initial) => {
      let prefix = initial,
        group = await discover(prefix),
        depth = 0;
      // A sole child and no direct object cover the entire parent. Following it
      // makes deep directory trees faster without making assumptions about names.
      while (group.objects.length === 0 && group.children.length === 1 && depth < 16) {
        prefix = group.children[0];
        group = await discover(prefix);
        depth++;
      }
      return { prefix, ...group };
    });
    const partitions = [];
    for (const branch of branches) {
      if (branch.objects.length + branch.children.length <= splitThreshold) {
        partitions.push(branch.prefix);
        continue;
      }
      const items = [
        ...branch.objects.map((object) => ({
          suffix: object.Key.slice(branch.prefix.length),
          object,
        })),
        ...branch.children.map((child) => ({ suffix: child.slice(branch.prefix.length), child })),
      ];
      const exact = items.filter((item) => !item.suffix);
      for (const item of exact) {
        if (!item.object) throw Error('Invalid empty inventory prefix');
        add(item.object, branch.prefix);
      }
      let nodes =
        items.length === exact.length
          ? []
          : [{ prefix: '', items: items.filter((item) => item.suffix) }];
      while (nodes.length < 16) {
        const index = nodes.reduce(
          (best, node, i) =>
            node.items.length > 1 && (best < 0 || node.items.length > nodes[best].items.length)
              ? i
              : best,
          -1,
        );
        if (index < 0) break;
        const node = nodes[index],
          arrays = node.items.map((item) => Array.from(item.suffix));
        let count = 0;
        while (arrays.every((value) => value.length > count && value[count] === arrays[0][count]))
          count++;
        const common = arrays[0].slice(0, count).join(''),
          groups = new Map();
        for (const item of node.items) {
          const chars = Array.from(item.suffix);
          if (chars.length === count) {
            if (!item.object) throw Error('Unexpected inventory child prefix collision');
            add(item.object, branch.prefix);
            continue;
          }
          const key = common + chars[count];
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(item);
        }
        if (!groups.size) throw Error('Empty adaptive inventory partition');
        nodes.splice(
          index,
          1,
          ...[...groups].map(([prefix, values]) => ({ prefix, items: values })),
        );
      }
      for (const node of nodes)
        partitions.push(branch.prefix + (node.prefix || node.items[0].suffix));
    }
    await mapLimit(partitions, async (prefix) => {
      const all = await pages(prefix, false);
      for (const object of all.objects) add(object, prefix);
    });
    await mapLimit([...discoveries], async ([prefix, expected]) => {
      if (signature(await pages(prefix, true)) !== expected)
        throw Error('Inventory prefix discovery changed during measurement');
    });
    return { IsTruncated: false, Contents: [...objects.values()] };
  };
}
