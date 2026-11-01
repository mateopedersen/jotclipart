// A local exclusive writer lock must remain held until its private writer has
// actually exited. A signal request or ChildProcess.kill() result is not proof.
function lockRetained(message, cause) {
  return new Error(`Private session ${message}; R2 writer lock must be retained`, { cause });
}

function exited(child) {
  if (child == null || child.pid == null) return true; // No process was spawned.
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0)
    throw lockRetained('has an invalid process identity');
  if (Number.isSafeInteger(child.exitCode) && child.exitCode >= 0 && child.signalCode === null)
    return true;
  if (
    child.exitCode === null &&
    typeof child.signalCode === 'string' &&
    child.signalCode.length > 0
  )
    return true;
  if (child.exitCode === null && child.signalCode === null) return false;
  throw lockRetained('has an unknown process state');
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const check = () => {
      try {
        if (exited(child)) finish(true);
      } catch (error) {
        finish(false, error);
      }
    };
    const onExit = () => check(); // An event without an exit state proves nothing.
    const onError = (error) => {
      try {
        if (exited(child)) finish(true);
        else finish(false, lockRetained('reported a process error', error));
      } catch (failure) {
        finish(false, failure);
      }
    };
    const timer = setTimeout(() => {
      try {
        finish(exited(child));
      } catch (error) {
        finish(false, error);
      }
    }, timeoutMs);
    child.on('exit', onExit);
    child.on('error', onError);
    check(); // Catch exit between the signal and listener installation.
  });
}

function requestSignal(child, signal) {
  if (exited(child)) return;
  try {
    child.kill(signal);
  } catch (error) {
    if (!exited(child)) throw lockRetained(`could not be sent ${signal}`, error);
  }
}

/** Stop a native child or throw; callers must not release the writer lock on error. */
export async function stopPrivateSession(child, { graceMs = 5_000, killMs = 5_000 } = {}) {
  for (const duration of [graceMs, killMs])
    if (!Number.isSafeInteger(duration) || duration < 0 || duration > 60_000)
      throw lockRetained('has invalid shutdown timeouts');
  if (exited(child)) return;
  if (
    typeof child.kill !== 'function' ||
    typeof child.on !== 'function' ||
    typeof child.removeListener !== 'function'
  )
    throw lockRetained('does not support process shutdown monitoring');
  requestSignal(child, 'SIGTERM');
  if (exited(child) || (await waitForExit(child, graceMs))) return;
  requestSignal(child, 'SIGKILL');
  if (exited(child) || (await waitForExit(child, killMs))) return;
  throw lockRetained('did not exit after SIGTERM and SIGKILL');
}
