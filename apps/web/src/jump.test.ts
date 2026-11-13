import { describe, expect, test } from 'vitest';
import { back, current, emptyTrail, forward, type Trail, targetAt, visit } from './jump.ts';

describe('what a click in a line points at', () => {
  const line = "import { cors } from '../../middleware/cors'";

  test('a name, from anywhere inside it or just past its end', () => {
    const at = line.indexOf('cors');
    for (const column of [at, at + 2, at + 4]) {
      expect(targetAt(line, column)).toEqual({
        kind: 'symbol',
        name: 'cors',
        start: at,
        end: at + 4,
      });
    }
  });

  test('an import specifier, not the names inside it', () => {
    const at = line.indexOf('middleware');
    expect(targetAt(line, at)).toEqual({
      kind: 'import',
      spec: '../../middleware/cors',
      start: line.indexOf('../'),
      end: line.length - 1,
    });
    expect(targetAt("const x = require('./a')", 19)).toMatchObject({ spec: './a' });
    expect(targetAt("await import('./b.js')", 15)).toMatchObject({ spec: './b.js' });
  });

  test('nothing for spaces, punctuation and numbers', () => {
    expect(targetAt('a  =  b', 3)).toBeNull();
    expect(targetAt('f(1234)', 3)).toBeNull();
    expect(targetAt('', 0)).toBeNull();
  });

  test('names with $, _ and letters beyond ASCII', () => {
    expect(targetAt('x = $store_1.ünïcode', 6)).toMatchObject({ name: '$store_1' });
    expect(targetAt('x = $store_1.ünïcode', 15)).toMatchObject({ name: 'ünïcode' });
  });
});

describe('the trail of explored files', () => {
  const same = (a: string, b: string) => a === b;
  const walk = (...files: string[]) =>
    files.reduce<Trail<string>>((trail, file) => visit(trail, file, same), emptyTrail());

  test('back and forward move through it, and back from the first file is the stop', () => {
    let trail = walk('a', 'b', 'c');
    expect(current(trail)).toBe('c');
    trail = back(back(trail));
    expect(current(trail)).toBe('a');
    trail = back(trail);
    expect(current(trail)).toBeNull();
    expect(back(trail)).toBe(trail);
    trail = forward(forward(trail));
    expect(current(trail)).toBe('b');
  });

  test('opening a file drops what was ahead, and the same file twice is one entry', () => {
    const trail = visit(visit(back(walk('a', 'b', 'c')), 'd', same), 'd', same);
    expect(trail.entries).toEqual(['a', 'b', 'd']);
    expect(forward(trail)).toBe(trail);
  });
});
