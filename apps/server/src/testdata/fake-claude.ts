// A stand-in `claude` for tests that never start a session: it only answers `--version`.
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_CLAUDE_CODE_VERSION } from '../claude-code.ts';

/** Writes `<new temp folder>/claude`, printing `printed` for `--version`, and returns its folder. */
export async function fakeClaudeDir(printed = `${MIN_CLAUDE_CODE_VERSION} (Claude Code)`) {
  const dir = await mkdtemp(join(tmpdir(), 'docent-fake-claude-'));
  const path = join(dir, 'claude');
  await writeFile(path, `#!/bin/sh\necho '${printed}'\n`);
  await chmod(path, 0o755);
  return dir;
}
