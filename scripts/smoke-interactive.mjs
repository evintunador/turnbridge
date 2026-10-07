#!/usr/bin/env node
/** Compatibility entrypoint. All native session stores now live in disposable profiles. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [selection = 'all', ...options] = process.argv.slice(2);
if (options.includes('--manual')) {
  throw Error('Manual review now uses the retained round-*-screen.svg and terminal logs from npm run verify:installed. Supply --cledger PATH; no sessions are written into your normal profile.');
}
const args = [...(selection === 'all' ? [] : ['--only', selection]), ...options];
const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/verification/campaign.js', import.meta.url)), ...args], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
