import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(readFileSync(resolve(root, 'reference-versions.json'), 'utf8'));
export const referenceRoot = resolve(root, '.reference');

export function verifyReferences(names) {
  for (const name of names) {
    const directory = resolve(referenceRoot, name);
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    }).trim();
    if (revision !== pins[name].commit)
      throw new Error(
        `${name}: expected ${pins[name].commit}, found ${revision}; run npm run conformance:setup in a clean checkout`,
      );
    const changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: directory,
      encoding: 'utf8',
    }).trim();
    if (changed)
      throw new Error(`${name}: upstream tracked files are modified; refusing an untrusted oracle`);
  }
}

export function prepareReferences(names, installNames = names) {
  mkdirSync(referenceRoot, { recursive: true });
  for (const name of names) {
    const directory = resolve(referenceRoot, name);
    if (!existsSync(directory)) {
      execFileSync('git', ['clone', '--no-checkout', pins[name].repository, directory], {
        stdio: 'inherit',
      });
      execFileSync('git', ['checkout', '--detach', pins[name].commit], {
        cwd: directory,
        stdio: 'inherit',
      });
    }
    verifyReferences([name]);
    if (installNames.includes(name)) {
      execSync('npm ci --ignore-scripts --no-audit --no-fund', {
        cwd: directory,
        stdio: 'inherit',
      });
      verifyReferences([name]);
    }
  }
}
