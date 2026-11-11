// Builds the one npm package users install: `npx <scope>/docent review <url>`.
// Run: pnpm pack:cli (it builds first). It never publishes; see docs/release/checklist.md.
//
// The package mirrors the repo's layout, so the CLI's own relative paths (the web app at
// ../../web/dist, its version at ../package.json) hold without any packaging special cases:
//
//   package.json          name, version, bin, exact dependencies, `files`
//   npm-shrinkwrap.json   pins the whole dependency tree for everyone who installs it
//   server/dist/cli.js    the CLI and server, bundled with @docent/core
//   server/package.json   just "type" and "version", read by the server at startup
//   web/dist/             the built web app
//   README.md, LICENSE, NOTICE, SECURITY.md, THIRD_PARTY_LICENSES.md

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { build } from 'rolldown';
import { licenseProblems } from './check-deps.ts';

/**
 * The npm scope the package ships under. The unscoped `docent` name is taken, and the real scope
 * is the maintainer's call (backlog/decisions.md, "npm scope for publishing"). This is the only
 * place it lives in code.
 */
export const NPM_SCOPE = '@docent';

/** Don't resolve dependency versions published less than a day ago, like pnpm's minimumReleaseAge. */
const MIN_RELEASE_AGE_MS = 24 * 60 * 60 * 1000;

const root = join(import.meta.dirname, '..');
const out = join(root, 'dist', 'npm');
// pnpm passes its own settings to child processes as npm_config_* variables. npm doesn't know
// most of them and warns, and none of them should steer how npm resolves or packs.
const npmEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_')),
);
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const server = read('apps/server/package.json') as {
  version: string;
  dependencies: Record<string, string>;
};
const rootPackage = read('package.json') as { engines: { node: string }; license: string };

const webDist = join(root, 'apps/web/dist');
if (!existsSync(webDist)) {
  console.error('pack: the web app is not built. Run: pnpm pack:cli (it builds first)');
  process.exit(1);
}

// Everything the server imports from npm stays a real dependency, with its exact version.
// Workspace packages (@docent/core) are bundled in instead, since they're never published.
const dependencies = Object.fromEntries(
  Object.entries(server.dependencies).filter(([, version]) => !version.startsWith('workspace:')),
);
const isExternal = (id: string) =>
  id.startsWith('node:') ||
  Object.keys(dependencies).some((name) => id === name || id.startsWith(`${name}/`));

rmSync(out, { recursive: true, force: true });

await build({
  input: join(root, 'apps/server/src/cli.ts'),
  platform: 'node',
  external: isExternal,
  write: true,
  output: {
    file: join(out, 'server/dist/cli.js'),
    format: 'esm',
    banner: '#!/usr/bin/env node',
  },
});

cpSync(webDist, join(out, 'web/dist'), { recursive: true });

const write = (path: string, data: unknown) =>
  writeFileSync(join(out, path), `${JSON.stringify(data, null, 2)}\n`);

write('server/package.json', { type: 'module', version: server.version });
write('package.json', {
  name: `${NPM_SCOPE}/docent`,
  version: server.version,
  description: 'A guided tour for reviewing AI-written pull requests.',
  license: rootPackage.license,
  repository: { type: 'git', url: 'git+https://github.com/hartz89/docent.git' },
  homepage: 'https://github.com/hartz89/docent#readme',
  type: 'module',
  bin: { docent: 'server/dist/cli.js' },
  engines: rootPackage.engines,
  // An allowlist: anything not named here stays out of the tarball, whatever lands in this folder.
  files: [
    'server/',
    'web/dist/',
    'npm-shrinkwrap.json',
    'NOTICE',
    'SECURITY.md',
    'THIRD_PARTY_LICENSES.md',
  ],
  dependencies,
});

for (const file of ['README.md', 'LICENSE', 'NOTICE', 'SECURITY.md']) {
  cpSync(join(root, file), join(out, file));
}
writeFileSync(join(out, 'THIRD_PARTY_LICENSES.md'), thirdPartyLicenses());

// A shrinkwrap is the one lockfile npm honors inside an installed package, so every user gets
// exactly the tree resolved here, not whatever is newest on the day they run npx.
const before = new Date(Date.now() - MIN_RELEASE_AGE_MS).toISOString();
execFileSync(
  'npm',
  [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--registry=https://registry.npmjs.org/',
    `--before=${before}`,
  ],
  { cwd: out, env: npmEnv, stdio: ['ignore', 'ignore', 'inherit'] },
);
renameSync(join(out, 'package-lock.json'), join(out, 'npm-shrinkwrap.json'));

// pnpm verify checks licenses on the repo's tree; this checks the tree users actually get.
const shrinkwrap = JSON.parse(readFileSync(join(out, 'npm-shrinkwrap.json'), 'utf8')) as {
  packages: Record<string, { name?: string; version?: string; license?: string }>;
};
const unlicensed = licenseProblems(
  Object.entries(shrinkwrap.packages)
    .filter(([path]) => path !== '')
    .map(([path, entry]) => ({
      name: entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: entry.version ?? '?',
      license: entry.license ?? 'Unknown',
    })),
);
if (unlicensed.length > 0) {
  console.error(`pack: ${unlicensed.length} license problem(s) in the shrinkwrap`);
  for (const problem of unlicensed) console.error(`  - ${problem}`);
  process.exit(1);
}

const [packed] = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--pack-destination', join(root, 'dist')], {
    cwd: out,
    env: npmEnv,
    encoding: 'utf8',
  }),
) as { filename: string; size: number; unpackedSize: number; entryCount: number }[];
if (!packed) throw new Error('npm pack printed nothing');
const tarball = join(root, 'dist', packed.filename);
const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} kB`;
console.log(
  `Packed ${tarball}\n  ${kb(packed.size)} compressed, ${kb(packed.unpackedSize)} unpacked, ${packed.entryCount} files`,
);

/**
 * The web app bundles its dependencies' code, so their license texts ship with it. The server's
 * npm dependencies install as packages and carry their own.
 */
function thirdPartyLicenses(): string {
  type Entry = { name: string; versions: string[]; license: string; paths: string[] };
  const byLicense = JSON.parse(
    execFileSync(
      'pnpm',
      ['licenses', 'list', '--prod', '--json', '--long', '--filter', '@docent/web'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    ),
  ) as Record<string, Entry[]>;
  const entries = Object.values(byLicense)
    .flat()
    .filter((entry) => !entry.name.startsWith('@docent/'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sections = entries.map((entry) => {
    const dir = entry.paths[0] ?? '';
    const file = existsSync(dir)
      ? readdirSync(dir).find(
          (name) => /^(licen[cs]e|copying)/i.test(name) && statSync(join(dir, name)).isFile(),
        )
      : undefined;
    const text = file ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${entry.license}`;
    return `## ${entry.name}@${entry.versions.join(', ')} (${entry.license})\n\n\`\`\`\n${text}\n\`\`\``;
  });
  return `# Third-party licenses\n\nThe web app in \`web/dist\` includes code and fonts from these packages.\n\n${sections.join('\n\n')}\n`;
}
