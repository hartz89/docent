type Stop = { readonly kind: string; readonly title: string };

/**
 * Which stop to show when a new list of stops replaces the one the reviewer was reading: the
 * finished tour replacing the streamed stops, or an update's kept ones.
 *
 * A repair rewrites stops in place and adds new ones after the stops of their kind, and it may
 * retitle any of them. So a stop keeps its place among the stops of its kind (the second edge
 * stop stays the second edge stop), while its title and its number may both change. The
 * reader follows a stop of the same kind and title, the nearest one if there are several; else
 * the stop in the same place among its kind; else stays as close as the new route allows.
 *
 * An update shows only the stops it kept, and the finished tour puts the rewritten ones back
 * among them, so there only an unchanged title finds the stop. If the update also retitles the
 * stop being read, the place among its kind can be off by the rewritten stops before it.
 */
export function follow(was: readonly Stop[], index: number, stops: readonly Stop[]): number {
  const closest = Math.min(index, Math.max(0, stops.length - 1));
  const reading = was[index];
  if (!reading) return closest;
  const place = was.slice(0, index).filter((s) => s.kind === reading.kind).length;
  const sameKind = stops.flatMap((s, i) => (s.kind === reading.kind ? [i] : []));
  let best: { at: number; distance: number } | null = null;
  for (const [nth, at] of sameKind.entries()) {
    const distance = Math.abs(nth - place);
    if (stops[at]?.title === reading.title && (!best || distance < best.distance)) {
      best = { at, distance };
    }
  }
  return best?.at ?? sameKind[place] ?? closest;
}
