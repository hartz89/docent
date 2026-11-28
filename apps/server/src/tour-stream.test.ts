import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { StopScanner } from './tour-stream.ts';

/** Feeds the text in pieces cut at `cuts`, and collects every stop the scanner hands back. */
function scan(json: string, cuts: number[]) {
  const scanner = new StopScanner();
  const found: unknown[] = [];
  for (const at of [...cuts.filter((c) => c < json.length).sort((a, b) => a - b), json.length]) {
    found.push(...(scanner.push(json.slice(0, at)) ?? []));
  }
  return found;
}

const stop = fc.record({
  kind: fc.constantFrom('intent', 'core_change'),
  title: fc.string(),
  body: fc.string({ unit: 'binary' }),
  citations: fc.array(fc.record({ path: fc.string(), startLine: fc.nat() }), { maxLength: 3 }),
});

describe('StopScanner', () => {
  test('finds exactly the stops, in order, however the text is cut', () => {
    fc.assert(
      fc.property(
        fc.array(stop, { maxLength: 6 }),
        fc.array(fc.record({ target: fc.string(), reason: fc.string() }), { maxLength: 3 }),
        fc.boolean(),
        fc.array(fc.nat({ max: 3000 }), { maxLength: 40 }),
        (stops, skips, skipsFirst, cuts) => {
          // Braces, brackets, quotes and a "stops" key inside strings or skips must not fool it.
          const tour = skipsFirst ? { skips, stops } : { stops, skips };
          expect(scan(JSON.stringify(tour, null, skipsFirst ? 2 : 0), cuts)).toEqual(stops);
        },
      ),
    );
  });

  test('collects the route ahead of the stops, however the text is cut', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { maxLength: 8 }),
        fc.array(stop, { maxLength: 4 }),
        fc.array(fc.nat({ max: 2000 }), { maxLength: 30 }),
        (route, stops, cuts) => {
          const scanner = new StopScanner();
          const json = JSON.stringify({ route, stops });
          const ends = [...cuts.filter((c) => c < json.length).sort((a, b) => a - b), json.length];
          const found = ends.flatMap((at) => scanner.push(json.slice(0, at)) ?? []);
          expect(scanner.route).toEqual(route);
          expect(found).toEqual(stops);
        },
      ),
    );
  });

  test('a route title counts once its string closes, before the route ends', () => {
    const scanner = new StopScanner();
    const route = JSON.stringify(['Why it changes', 'The "fix"']);
    scanner.push(`{"route": ${route.slice(0, 10)}`);
    expect(scanner.route).toEqual([]);
    scanner.push(`{"route": ${route.slice(0, -1)}`);
    expect(scanner.route).toEqual(['Why it changes', 'The "fix"']);
    // Strings in a stop, even under a "route" key, are not the route.
    scanner.push(`{"route": ${route}, "stops": [{"route": ["no"], "title": "x"}`);
    expect(scanner.route).toEqual(['Why it changes', 'The "fix"']);
  });

  test('a stop is handed back only once its object closes', () => {
    const scanner = new StopScanner();
    expect(scanner.push('{"stops": [{"kind": "intent", "title": "a }')).toEqual([]);
    expect(scanner.started).toBe(1);
    expect(scanner.push('{"stops": [{"kind": "intent", "title": "a }"}')).toEqual([
      { kind: 'intent', title: 'a }' },
    ]);
  });

  test('output that starts over is refused from then on', () => {
    const scanner = new StopScanner();
    scanner.push('{"stops": [{"a": 1}');
    expect(scanner.push('{"stops": [')).toBeNull();
    expect(scanner.push('{"stops": [{"a": 1}, {"b": 2}')).toBeNull();
  });
});
