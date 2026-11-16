import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readIndexNowPolicy, indexNowSubmissionEnabled } from './indexnow-policy.mjs';

/** Publication is already complete. Retry notification, never redeploy the site. */
export function runIndexNowNotification({
  root,
  revision,
  renderedRevision,
  env = process.env,
  spawn = spawnSync,
  save,
  readPolicy = () => readIndexNowPolicy(root),
}) {
  let report,
    policyRead = false;
  try {
    if (env.UC_INDEXNOW_NOTIFY === '0') {
      report = {
        status: 'PUBLISHED_NOTIFICATION_HELD',
        revision,
        checkedAt: new Date().toISOString(),
        reason: 'Notification disabled explicitly for this publication; no sender was started.',
      };
    } else if (
      !indexNowSubmissionEnabled(
        (() => {
          const policy = readPolicy();
          policyRead = true;
          return policy;
        })(),
      )
    ) {
      report = {
        status: 'PUBLISHED_NOTIFICATION_HELD',
        revision,
        checkedAt: new Date().toISOString(),
        reason:
          'OWNER_DEFERRED_2026_11_16: Search submissions disabled by owner; no sender started and no accepted ledger changed.',
      };
    } else {
      if (renderedRevision !== undefined && !/^[a-f0-9]{40}$/.test(renderedRevision))
        throw Error('Invalid rendered revision');
      const args = ['scripts/seo/indexnow-release.mjs', '--send', '--wait'];
      if (renderedRevision !== undefined) args.push('--rendered-revision', renderedRevision);
      const result = spawn(process.execPath, args, {
        cwd: root,
        env,
        encoding: 'utf8',
        maxBuffer: 1_000_000,
      });
      if (result.error || result.status !== 0) {
        report = {
          status: 'PUBLISHED_NOTIFICATION_PENDING',
          revision,
          checkedAt: new Date().toISOString(),
          reason: result.error
            ? 'Notification process unavailable'
            : String(result.stderr ?? '')
                .trim()
                .slice(0, 500),
          retry:
            'node scripts/seo/indexnow-release.mjs --send --wait' +
            (renderedRevision ? ' --rendered-revision ' + renderedRevision : ''),
        };
      } else {
        const last = String(result.stdout).trim().split('\n').at(-1);
        report = { status: 'PUBLISHED_NOTIFICATION_COMPLETE', revision, result: JSON.parse(last) };
      }
    }
  } catch {
    report = policyRead
      ? {
          status: 'PUBLISHED_NOTIFICATION_PENDING',
          revision,
          reason: 'Notification result could not be verified; retry notification only.',
        }
      : {
          status: 'PUBLISHED_NOTIFICATION_HELD',
          revision,
          reason: 'Search submission policy unavailable; no sender authorized.',
        };
  }
  try {
    if (save) save(report);
    else {
      const dir = join(root, 'work/delivery', revision);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'indexnow-notification.json');
      writeFileSync(file + '.next', JSON.stringify(report, null, 2) + '\n');
      renameSync(file + '.next', file);
    }
  } catch {
    console.warn('Site published; notification checkpoint could not be saved. Do not redeploy.');
  }
  console.log(JSON.stringify(report));
  return report;
}
