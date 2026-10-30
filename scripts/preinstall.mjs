import { rmSync } from 'node:fs';

if (!(process.env.npm_config_user_agent ?? '').startsWith('pnpm/')) {
  console.error('Use pnpm instead');
  process.exit(1);
}

for (const lockfile of ['package-lock.json', 'yarn.lock']) {
  rmSync(lockfile, { force: true });
}
