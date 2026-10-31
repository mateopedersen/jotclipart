import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { configuredToken, refreshConfiguredLogin } from '../r2/cloudflare-api.mjs';

export function verifyProductionConfig(project) {
  if (project?.source?.config?.production_deployments_enabled !== false)
    throw Error('Automatic production deployments must remain paused for staged R2 delivery');
  const production = project?.deployment_configs?.production;
  if (production?.fail_open !== false) throw Error('Production Pages Functions must fail closed');
  if (production?.r2_buckets?.CATALOG_PAGES?.name !== 'ultraclipart-pages')
    throw Error('Production catalog R2 binding is missing');
  return {
    productionFailClosed: true,
    automaticProductionPaused: true,
    catalogBindingVerified: true,
  };
}

export function verifyLiveBaseline(live, expected, expectedControl = expected) {
  if (!/^[a-f0-9]{40}$/.test(expected ?? '') || !/^[a-f0-9]{40}$/.test(expectedControl ?? ''))
    throw Error('Invalid expected live revision');
  if (live?.renderedRevision !== expected || live?.controlRevision !== expectedControl)
    throw Error(
      'Production changed during preparation; reconcile the newer release before activation',
    );
  return { liveBaselineVerified: expected, liveControlBaselineVerified: expectedControl };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const account = '48c779c8eaa80234e0bb9d57f96e588b';
  let token;
  try {
    token = configuredToken();
  } catch (error) {
    if (!process.env.WRANGLER_AUTH_FILE) throw error;
    token = await refreshConfiguredLogin({
      refresh: async () =>
        execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'whoami'], {
          stdio: 'ignore',
          timeout: 60000,
        }),
      expiry: () =>
        Date.parse(
          readFileSync(process.env.WRANGLER_AUTH_FILE, 'utf8').match(
            /^expiration_time\s*=\s*"([^\"]+)"/m,
          )?.[1] ?? '',
        ),
    });
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/ultraclipart`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    },
  );
  const data = await response.json();
  if (!response.ok || data.success !== true)
    throw Error(`Cloudflare project configuration HTTP ${response.status}`);
  console.log(JSON.stringify(verifyProductionConfig(data.result)));
  if (process.env.UC_DELIVERY_EXPECTED_LIVE_REVISION) {
    const live = await fetch('https://ultraclipart.com/delivery-release.json', {
      cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0', Origin: 'https://ultraclipart.com' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!live.ok) throw Error(`Live release verification HTTP ${live.status}`);
    console.log(
      JSON.stringify(
        verifyLiveBaseline(await live.json(), process.env.UC_DELIVERY_EXPECTED_LIVE_REVISION,
          process.env.UC_DELIVERY_EXPECTED_LIVE_CONTROL_REVISION ?? process.env.UC_DELIVERY_EXPECTED_LIVE_REVISION),
      ),
    );
  }
}
