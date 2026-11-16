import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captionAndLink,
  mergeOwnedShares,
  normalizeOwnedShare,
  SITE,
  socialLinks,
} from '../src/share/core.ts';
import { handOffNativeShare, nativeShareMode, shareWasCancelled } from '../src/share/native.ts';

const file = new File(['portable-native-api-fixture'], 'jotclipart-test.png', {
  type: 'image/png',
});
const input = {
  file,
  title: 'My own title',
  text: 'My own caption\nSecond line',
  url: `${SITE}/art/fixture/`,
};
const key = (id = 'a'.repeat(32)) => ({
  id,
  title: 'An unchanged title',
  url: `${SITE}/share/${id}/`,
  deleteToken: 'A'.repeat(43),
});

test('a native file handoff happens synchronously in the original user gesture', async () => {
  const calls = [];
  let finish;
  const api = {
    canShare: ({ files }) => files[0] === file,
    share: (data) => {
      calls.push(data);
      return new Promise((resolve) => (finish = resolve));
    },
  };
  const result = handOffNativeShare(api, input);
  assert.equal(result.mode, 'file');
  assert.equal(calls.length, 1, 'the OS API runs before yielding or awaiting');
  assert.deepEqual(calls[0], {
    files: [file],
    title: input.title,
    text: captionAndLink(input.text, input.url),
  });
  finish();
  await result.completion;
});

for (const probe of ['false', 'missing', 'throws'])
  test(`native ${probe} file capability retains a real link handoff`, async () => {
    const calls = [];
    const api = {
      share: (data) => {
        calls.push(data);
        return Promise.resolve();
      },
    };
    if (probe === 'false') api.canShare = () => false;
    if (probe === 'throws')
      api.canShare = () => {
        throw new TypeError('Capability refused');
      };
    assert.equal(nativeShareMode(api, file), 'link');
    const result = handOffNativeShare(api, input);
    assert.equal(result.mode, 'link');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { title: input.title, text: input.text, url: input.url });
    await result.completion;
    assert.equal(file.name, 'jotclipart-test.png');
    assert.equal(file.size, 27, 'capability failure never destroys the prepared PNG');
  });

test('absent native API stays unavailable and does not invoke capability probes', async () => {
  const api = {
    canShare() {
      throw Error('must not be called');
    },
  };
  assert.equal(nativeShareMode(api, file), 'none');
  assert.equal(handOffNativeShare(api, input).mode, 'none');
});

for (const synchronous of [true, false])
  test(`native cancellation (${synchronous ? 'sync throw' : 'async rejection'}) has no automatic second handoff`, async () => {
    let calls = 0;
    const cancel = new DOMException('Owner cancelled', 'AbortError');
    const api = {
      share() {
        calls++;
        if (synchronous) throw cancel;
        return Promise.reject(cancel);
      },
    };
    const result = handOffNativeShare(api, input);
    assert.equal(calls, 1);
    await assert.rejects(result.completion, (error) => shareWasCancelled(error));
    assert.equal(calls, 1);
    assert(!shareWasCancelled(new Error('Permission denied')));
    assert(!shareWasCancelled(undefined));
    assert(!shareWasCancelled('AbortError'));
  });

test('a legacy removal key gets only a matching new UI URL, without modifying the input', () => {
  const record = key();
  record.url = `https://ultraclipart.com/share/${record.id}/`;
  const original = JSON.stringify(record);
  const normalized = normalizeOwnedShare(record);
  assert.deepEqual(normalized, { ...record, url: `${SITE}/share/${record.id}/` });
  assert.notEqual(normalized, record);
  assert.equal(JSON.stringify(record), original);
  assert.deepEqual(normalizeOwnedShare(key()), key());
});

test('owned links reject lookalikes, query/private fragments, credentials, mismatched identities and malformed capabilities', () => {
  const record = key();
  const invalid = [
    null,
    [],
    {},
    { ...record, id: 'A'.repeat(32) },
    { ...record, deleteToken: 'a'.repeat(42) },
    { ...record, deleteToken: 'a'.repeat(42) + '=' },
    { ...record, title: '  ' },
    { ...record, title: 'a\nsecret' },
    { ...record, title: 'a'.repeat(101) },
    ...[
      `https://ultraclipart.com.evil.example/share/${record.id}/`,
      `https://assets.ultraclipart.com/share/${record.id}/`,
      `http://ultraclipart.com/share/${record.id}/`,
      `https://user@jotclipart.com/share/${record.id}/`,
      `${record.url}?token=private`,
      `${record.url}#private`,
      `${SITE}/share/${'b'.repeat(32)}/`,
      `${SITE}/share/%61${record.id.slice(1)}/`,
    ].map((url) => ({ ...record, url })),
  ];
  for (const value of invalid) assert.equal(normalizeOwnedShare(value), undefined);
});

test('restoring validates the complete input without mutation, deduplicates capabilities and preserves titles', () => {
  const existing = [key()],
    original = JSON.stringify(existing);
  const older = {
    ...key(),
    title: 'Older title',
    url: `https://ultraclipart.com/share/${key().id}/`,
  };
  const next = key('b'.repeat(32));
  assert.deepEqual(mergeOwnedShares(existing, [older, next, next]), [key(), next]);
  for (const incoming of [
    [],
    [{ ...key(), deleteToken: 'B'.repeat(43) }],
    [next, { ...next, deleteToken: 'C'.repeat(43) }],
    [next, {}],
    Array(1001).fill(next),
  ])
    assert.throws(() => mergeOwnedShares(existing, incoming));
  assert.equal(JSON.stringify(existing), original);
});

test('manual caption copy retains the entire caption and canonical link as separate text', () => {
  const text = 'My own message\nI keep this exactly. 🖍️';
  assert.equal(captionAndLink(text, input.url), `${text}\n${input.url}`);
  assert.equal(text, 'My own message\nI keep this exactly. 🖍️');
});

test('social links are bounded compose URLs with new public artwork/media only', () => {
  const links = socialLinks(
    input.url,
    input.text,
    'https://assets.jotclipart.com/fruit/original.webp',
  );
  assert.equal(links.length, 9);
  assert.equal(new Set(links.map((link) => link.name)).size, 9);
  const hosts = new Set([
    'www.pinterest.com',
    'www.facebook.com',
    'wa.me',
    'x.com',
    't.me',
    'www.linkedin.com',
    'www.reddit.com',
    'bsky.app',
    'www.threads.net',
  ]);
  for (const link of links) {
    const url = new URL(link.href);
    assert.equal(url.protocol, 'https:');
    assert(hosts.has(url.hostname));
    assert(!decodeURIComponent(url.href).includes('ultraclipart.com'));
    assert(!decodeURIComponent(url.href).includes(key().deleteToken));
  }
  assert.throws(() => socialLinks('https://evil.example/art/fixture/', input.text));
});
