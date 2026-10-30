import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** Publication is already complete. Retry notification, never redeploy the site. */
export function runIndexNowNotification({root,revision,env=process.env,spawn=spawnSync,save}) {
  let report;
  try {
    if (env.UC_INDEXNOW_NOTIFY === '0') {
      report={status:'PUBLISHED_NOTIFICATION_HELD',revision,checkedAt:new Date().toISOString(),reason:'Notification disabled explicitly for this publication; no sender was started.'};
    } else {
    const result=spawn(process.execPath,['scripts/seo/indexnow-release.mjs','--send','--wait'],{cwd:root,env,encoding:'utf8',maxBuffer:1_000_000});
    if (result.error || result.status!==0) {
      report={status:'PUBLISHED_NOTIFICATION_PENDING',revision,checkedAt:new Date().toISOString(),reason:result.error?'Notification process unavailable':String(result.stderr??'').trim().slice(0,500),retry:'node scripts/seo/indexnow-release.mjs --send --wait'};
    } else {
      const last=String(result.stdout).trim().split('\n').at(-1);
      report={status:'PUBLISHED_NOTIFICATION_COMPLETE',revision,result:JSON.parse(last)};
    }
    }
  } catch {
    report={status:'PUBLISHED_NOTIFICATION_PENDING',revision,reason:'Notification result could not be verified; retry notification only.'};
  }
  try {
    if (save) save(report);
    else {
      const dir=join(root,'work/delivery',revision);mkdirSync(dir,{recursive:true});
      const file=join(dir,'indexnow-notification.json');writeFileSync(file+'.next',JSON.stringify(report,null,2)+'\n');renameSync(file+'.next',file);
    }
  } catch {console.warn('Site published; notification checkpoint could not be saved. Do not redeploy.');}
  console.log(JSON.stringify(report));
  return report;
}
