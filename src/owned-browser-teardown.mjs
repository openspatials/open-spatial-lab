import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUTS = Object.freeze({ graceful_ms: 4000, term_ms: 2000, kill_ms: 2000 });
const PROFILE_ARGUMENT_PREFIX = "--user-data-dir=";

function errorText(error) {
  return String(error && error.message ? error.message : error || "unknown error").slice(0, 240);
}

function childExited(child) {
  return child && (child.exitCode !== null || child.signalCode !== null);
}

function settleWithin(action, timeoutMs, timers) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      resolve(value);
    };
    const timer = timers.setTimeout(() => finish({ status: "timeout" }), timeoutMs);
    Promise.resolve()
      .then(action)
      .then(() => finish({ status: "resolved" }), (error) => finish({ status: "rejected", error: errorText(error) }));
  });
}

function waitForChildExit(child, timeoutMs, timers) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = timers.setTimeout(() => finish(childExited(child)), timeoutMs);
    child.once("exit", onExit);
  });
}

function systemProfileProcessTable(profileArgument) {
  const searchPattern = escapePattern(profileArgument).replace(/^--/, "[-][-]");
  const scan = spawnSync("/usr/bin/pgrep", ["-lf", searchPattern], { encoding: "utf8" });
  if (scan.status === 1 && !scan.error) return "";
  if (scan.error || scan.status !== 0) {
    throw new Error(`process table unavailable: ${errorText(scan.error || scan.stderr || `status ${scan.status}`)}`);
  }
  return scan.stdout;
}

function parseProcessTable(raw) {
  return String(raw || "").split("\n").flatMap((line) => {
    const processTableMatch = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (processTableMatch) {
      return [{ pid: Number(processTableMatch[1]), ppid: Number(processTableMatch[2]), command: processTableMatch[3] }];
    }
    const profileSearchMatch = line.match(/^\s*(\d+)\s+(.*)$/);
    if (profileSearchMatch) {
      return [{ pid: Number(profileSearchMatch[1]), ppid: null, command: profileSearchMatch[2] }];
    }
    return [];
  });
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactProfileArgument(command, profileArgument) {
  return new RegExp(`(?:^|\\s)${escapePattern(profileArgument)}(?:\\s|$)`).test(command);
}

export function listExactProfileProcesses(profilePath, options = {}) {
  const resolvedProfilePath = path.resolve(profilePath);
  const profileArgument = `${PROFILE_ARGUMENT_PREFIX}${resolvedProfilePath}`;
  const processTable = options.processTableFn
    ? options.processTableFn()
    : systemProfileProcessTable(profileArgument);
  return parseProcessTable(processTable).filter((entry) => (
    entry.pid > 1 && entry.pid !== process.pid && hasExactProfileArgument(entry.command, profileArgument)
  ));
}

function profileOwnership(child, requestedProfilePath) {
  if (typeof requestedProfilePath !== "string" || requestedProfilePath.length === 0) {
    return { error: "profile-path-missing" };
  }
  if (requestedProfilePath.trim() !== requestedProfilePath || /[\0\r\n]/.test(requestedProfilePath)) {
    return { error: "profile-path-unsafe" };
  }
  if (!path.isAbsolute(requestedProfilePath)) return { error: "profile-path-not-absolute" };
  const resolvedProfilePath = path.resolve(requestedProfilePath);
  const temporaryRoot = path.resolve(os.tmpdir());
  if (resolvedProfilePath === temporaryRoot || !resolvedProfilePath.startsWith(`${temporaryRoot}${path.sep}`)) {
    return { error: "profile-path-outside-temporary-root", path: resolvedProfilePath, temporary_root: temporaryRoot };
  }
  const profileArgument = `${PROFILE_ARGUMENT_PREFIX}${resolvedProfilePath}`;
  const spawnArguments = Array.isArray(child?.spawnargs) ? child.spawnargs : [];
  if (!spawnArguments.includes(profileArgument)) {
    return { error: "profile-not-owned-by-captured-child", path: resolvedProfilePath, argument: profileArgument };
  }
  return {
    error: null,
    path: resolvedProfilePath,
    argument: profileArgument,
    temporary_root: temporaryRoot,
    captured_pid: child.pid,
  };
}

function waitWithTimers(milliseconds, timers) {
  return new Promise((resolve) => timers.setTimeout(resolve, milliseconds));
}

async function waitForProfileExit(listProcesses, timeoutMs, timers, pollMs) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const processes = listProcesses();
    if (processes.length === 0) return processes;
    await waitWithTimers(pollMs, timers);
  }
  return listProcesses();
}

export function createOwnedBrowserTeardown(browser, options = {}) {
  const child = browser && typeof browser.process === "function" ? browser.process() : null;
  const pid = child && Number.isInteger(child.pid) && child.pid > 1 ? child.pid : null;
  const label = options.label || "headed-browser";
  const timeouts = {
    graceful_ms: options.gracefulTimeoutMs ?? DEFAULT_TIMEOUTS.graceful_ms,
    term_ms: options.termTimeoutMs ?? DEFAULT_TIMEOUTS.term_ms,
    kill_ms: options.killTimeoutMs ?? DEFAULT_TIMEOUTS.kill_ms,
  };
  const timers = {
    setTimeout: options.setTimeoutFn || setTimeout,
    clearTimeout: options.clearTimeoutFn || clearTimeout,
  };
  const onLog = options.onLog || console.log;
  const requestedProfilePath = options.profilePath ?? null;
  const processTableFn = options.processTableFn || null;
  const sendSignal = options.sendSignalFn || process.kill.bind(process);
  const removeProfile = options.removeProfileFn || ((target) => rm(target, { recursive: true, force: true }));
  const profileExists = options.profileExistsFn || existsSync;
  const profilePollMs = Math.max(1, options.profilePollMs ?? 100);
  let shutdownPromise = null;

  const event = (events, name, detail = {}) => {
    const entry = { event: name, at: new Date().toISOString(), ...detail };
    events.push(entry);
    onLog(`[browser-teardown:${label}] ${name}${pid ? ` pid=${pid}` : ""}`);
  };

  const ownership = () => {
    if (!browser || !child || !pid || typeof child.kill !== "function") return "missing-owned-process";
    let current;
    try { current = browser.process(); } catch { return "browser-process-unavailable"; }
    if (current !== child || current.pid !== pid) return "ambiguous-owned-process";
    return null;
  };

  async function runShutdown() {
    const events = [];
    const result = { ok: false, label, pid, outcome: null, timeouts, events };
    try {
      if (childExited(child)) {
        event(events, "already-exited");
        result.ok = true;
        result.outcome = "already-exited";
        return result;
      }

      const initialOwnershipProblem = ownership();
      if (initialOwnershipProblem) {
        event(events, "ownership-failed-closed", { reason: initialOwnershipProblem });
        result.outcome = "ownership-failed-closed";
        result.ownership_error = initialOwnershipProblem;
        return result;
      }

      const graceful = await settleWithin(
        () => browser && typeof browser.close === "function" ? browser.close() : Promise.reject(new Error("browser.close unavailable")),
        timeouts.graceful_ms,
        timers,
      );
      result.graceful = graceful;
      event(events, graceful.status === "resolved" ? "graceful-resolved" : `graceful-${graceful.status}`,
        graceful.error ? { error: graceful.error } : {});
      if (childExited(child)) {
        result.ok = true;
        result.outcome = graceful.status === "resolved" ? "graceful-close" : "already-exited";
        return result;
      }

      if (graceful.status === "resolved") {
        const gracefulExited = await waitForChildExit(child, timeouts.term_ms, timers);
        result.graceful.exited = gracefulExited;
        if (gracefulExited) {
          event(events, "graceful-close");
          result.ok = true;
          result.outcome = "graceful-close";
          return result;
        }
        event(events, "graceful-returned-process-alive");
      }

      const ownershipProblem = ownership();
      if (ownershipProblem) {
        event(events, "ownership-failed-closed", { reason: ownershipProblem });
        result.outcome = "ownership-failed-closed";
        result.ownership_error = ownershipProblem;
        return result;
      }

      event(events, "term-sent");
      const termSent = child.kill("SIGTERM") === true;
      result.term = { sent: termSent, exited: termSent ? await waitForChildExit(child, timeouts.term_ms, timers) : false };
      if (result.term.exited) {
        event(events, "term-exited");
        result.ok = true;
        result.outcome = "term-exit";
        return result;
      }

      const ownershipAfterTerm = ownership();
      if (ownershipAfterTerm) {
        event(events, "ownership-failed-closed", { reason: ownershipAfterTerm });
        result.outcome = "ownership-failed-closed";
        result.ownership_error = ownershipAfterTerm;
        return result;
      }

      event(events, "kill-sent");
      const killSent = child.kill("SIGKILL") === true;
      result.kill = { sent: killSent, exited: killSent ? await waitForChildExit(child, timeouts.kill_ms, timers) : false };
      if (result.kill.exited) {
        event(events, "kill-exited");
        result.ok = true;
        result.outcome = "kill-exit";
        return result;
      }

      event(events, "cleanup-failed");
      result.outcome = "cleanup-failed";
      return result;
    } finally {
      if (requestedProfilePath !== null) {
        const ownership = profileOwnership(child, requestedProfilePath);
        const profile = {
          ok: false,
          requested_path: requestedProfilePath,
          path: ownership.path || null,
          argument: ownership.argument || null,
          temporary_root: ownership.temporary_root || path.resolve(os.tmpdir()),
          captured_pid: ownership.captured_pid || pid,
          ownership_confirmed: ownership.error === null,
          ownership_error: ownership.error,
          processes_before: [],
          term: [],
          kill: [],
          processes_after: [],
          removed: false,
          outcome: null,
        };
        result.profile = profile;
        if (ownership.error) {
          profile.outcome = "profile-ownership-failed-closed";
          event(events, profile.outcome, { reason: ownership.error });
        } else {
          const listProcesses = () => listExactProfileProcesses(ownership.path, { processTableFn });
          const signalProcesses = (candidates, signal, records) => {
            for (const candidate of candidates) {
              const current = listProcesses().find((entry) => (
                entry.pid === candidate.pid && entry.command === candidate.command
              ));
              if (!current) {
                records.push({ pid: candidate.pid, signal, sent: false, reason: "identity-changed-or-exited" });
                continue;
              }
              try {
                const sent = sendSignal(candidate.pid, signal) !== false;
                records.push({ pid: candidate.pid, signal, sent });
                event(events, `profile-${signal === "SIGTERM" ? "term" : "kill"}-sent`, { profile_pid: candidate.pid });
              } catch (error) {
                records.push({ pid: candidate.pid, signal, sent: false, error: errorText(error) });
              }
            }
          };
          try {
            profile.processes_before = listProcesses();
            signalProcesses(profile.processes_before, "SIGTERM", profile.term);
            let remaining = await waitForProfileExit(
              listProcesses,
              timeouts.term_ms,
              timers,
              profilePollMs,
            );
            if (remaining.length > 0) {
              signalProcesses(remaining, "SIGKILL", profile.kill);
              remaining = await waitForProfileExit(
                listProcesses,
                timeouts.kill_ms,
                timers,
                profilePollMs,
              );
            }
            profile.processes_after = remaining;
            if (remaining.length > 0) {
              profile.outcome = "profile-processes-remained";
              event(events, "profile-cleanup-failed", { remaining_pids: remaining.map((entry) => entry.pid) });
            } else {
              await removeProfile(ownership.path);
              profile.removed = !(await Promise.resolve(profileExists(ownership.path)));
              profile.ok = profile.removed;
              profile.outcome = profile.removed ? "profile-clean" : "profile-removal-failed";
              event(events, profile.outcome);
            }
          } catch (error) {
            profile.error = errorText(error);
            profile.outcome = "profile-cleanup-error";
            event(events, profile.outcome, { error: profile.error });
          }
        }
        if (!profile.ok) {
          result.profile_cleanup_failed = true;
          result.browser_outcome = result.outcome;
          result.ok = false;
          if (result.outcome === null || result.outcome === "already-exited" || result.outcome.endsWith("-exit") || result.outcome === "graceful-close") {
            result.outcome = profile.outcome;
          }
        }
      }
    }
  }

  return Object.freeze({
    pid,
    shutdown() {
      if (!shutdownPromise) shutdownPromise = runShutdown();
      return shutdownPromise;
    },
  });
}

export { DEFAULT_TIMEOUTS as OWNED_BROWSER_TEARDOWN_TIMEOUTS };
