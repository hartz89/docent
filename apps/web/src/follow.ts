type Stop = { readonly kind: string; readonly title: string };

/**
 * Which stop to show when a new list of stops replaces the one the reviewer was reading: the
 * finished tour replacing the streamed stops, or an update's kept ones.
 *
 * A repair rewrites stops in place and adds new ones after the stops of their kind, and it may
 * retitle any of them. So a stop keeps its place among the stops of its kind (the second edge
 * stop stays the second edge stop), while its title and its number may both change. An update
 * shows only the stops it kept, so there the unchanged title is what finds the stop again. The
 * reader follows a stop of the same kind and title, the nearest one if there are several; else
 * the stop in the same place among its kind; else stays as close as the new route allows.
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
