#!/usr/bin/env node
//
// CI dependency-audit gate. `npm audit --audit-level=high` on its own is all-or-nothing:
// one advisory nobody can fix yet leaves the build permanently red, which trains everyone
// to ignore it — and then a real one lands unnoticed. This keeps the high/critical gate but
// lets specific advisories be waived, each with a reason and an expiry date, so a waiver is
// a decision on the record rather than a disabled check.
//
// Fails on: any un-waived high/critical advisory, or a waiver past its `until` date.
// Warns on: a waiver whose advisory is gone (upstream fixed it — delete the entry).
// Also reports the production-only tree separately: dev-tree hoisting can mask an advisory
// that still reaches the packaged app, and that difference should be visible, not silent.

import { execFileSync } from 'node:child_process';

/**
 * Advisories we have decided to accept for now. Key = GHSA id.
 * `until` is a hard review date: past it, this gate fails until someone re-decides.
 */
const WAIVERS = {};

// npm is a .cmd shim on Windows, and since Node 20 those can only be spawned through a
// shell. Every argument here is a fixed literal, so there is nothing for a shell to inject.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** `npm audit --json` exits non-zero whenever it finds anything, so capture and parse regardless. */
function audit(extraArgs) {
  try {
    return JSON.parse(
      execFileSync(NPM, ['audit', '--json', ...extraArgs], { encoding: 'utf8', shell: true }),
    );
  } catch (err) {
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

/** Flatten npm's nested `via` chains into one advisory per GHSA id. */
function advisories(report) {
  const found = new Map();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via === 'string') continue; // a transitive name, not an advisory
      if (via.severity !== 'high' && via.severity !== 'critical') continue;
      const id = String(via.url ?? '').split('/').pop();
      if (id) found.set(id, { id, name: via.name, severity: via.severity, title: via.title });
    }
  }
  return [...found.values()];
}

/** "1 critical, 3 high" — npm's own headline counts, for the summary line. */
function counts(report) {
  const v = report.metadata?.vulnerabilities ?? {};
  return ['critical', 'high', 'moderate', 'low']
    .filter((k) => v[k])
    .map((k) => `${v[k]} ${k}`)
    .join(', ') || 'none';
}

const today = new Date().toISOString().slice(0, 10);
const fullReport = audit([]);
const prodReport = audit(['--omit=dev']);
const full = advisories(fullReport);
const prodOnly = advisories(prodReport).filter((a) => !full.some((f) => f.id === a.id));

const blocking = [];
const waived = [];
for (const a of full) {
  const w = WAIVERS[a.id];
  if (!w) blocking.push(a);
  else if (w.until < today) blocking.push({ ...a, expired: w.until });
  else waived.push({ ...a, ...w });
}

for (const a of waived) {
  console.log(`WAIVED  ${a.severity.padEnd(8)} ${a.id}  ${a.name} — review by ${a.until}`);
  console.log(`        ${a.reason}`);
}

const stale = Object.keys(WAIVERS).filter((id) => !full.some((a) => a.id === id));
for (const id of stale) {
  console.log(`STALE   waiver ${id} (${WAIVERS[id].package}) no longer matches any advisory — remove it from scripts/audit-gate.mjs`);
}

if (prodOnly.length) {
  console.log('\nPresent in the production-only tree but hidden by dev-tree hoisting (not gated here):');
  for (const a of prodOnly) console.log(`        ${a.severity.padEnd(8)} ${a.id}  ${a.name} — ${a.title}`);
}

// npm counts every package along a dependency chain, so its headline number is usually
// larger than the advisory count above (one advisory in a deep dep inflates every parent).
// Print both so "npm says 5 high, the gate says 1" isn't read as the gate missing something.
console.log(`\nnpm audit headline — full tree: ${counts(fullReport)} · production only: ${counts(prodReport)}`);
console.log(`Distinct high/critical advisories: ${full.length} (full tree), ${prodOnly.length} additional in production only.`);

if (blocking.length) {
  console.error('\nBlocking advisories:');
  for (const a of blocking) {
    const why = a.expired ? `waiver EXPIRED ${a.expired}` : 'not waived';
    console.error(`  ${a.severity.padEnd(8)} ${a.id}  ${a.name} — ${a.title} (${why})`);
  }
  console.error('\nFix it, or add a dated waiver with a reason in scripts/audit-gate.mjs.');
  process.exit(1);
}

console.log(`\nOK — no un-waived high/critical advisories (${waived.length} waived, ${stale.length} stale).`);
