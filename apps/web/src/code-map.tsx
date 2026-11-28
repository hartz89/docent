// The code map: what the PR changed, and what uses it, as two columns of files joined by links.
// Laid out by hand: every row has a fixed height, so the links' ends are worked out from the data
// alone, with no measuring. On a narrow screen the links give way to a "used by" list per row.
import type { MapEdge, MapGroup, MapNode } from '@docent/server';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { api } from './api.ts';

/** Heights in px, matched by the CSS (`.map-group-head`, `.map-node`, `.map-groups` gap). */
const HEAD = 30;
const ROW = 30;
const PAD = 4;
const GAP = 12;
/**
 * Widths in px of the gutter the links cross, and of the one the changed side's own links bend
 * into, matched by `.map-grid`'s columns.
 */
const LINKS = 72;
const ARCS = 24;

const KIND_LABELS: Record<MapNode['kind'], string> = {
  function: 'fn',
  method: 'fn',
  class: 'class',
  interface: 'iface',
  type: 'type',
  enum: 'enum',
  module: 'mod',
  constant: 'const',
  file: '',
};

async function fetchMap() {
  const res = await api.map.$get();
  if (res.status !== 200) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? `The server answered ${res.status}`);
  }
  return res.json();
}
type MapData = Awaited<ReturnType<typeof fetchMap>>;

/** One map per review: it's drawn from the head commit, which a review never leaves. */
const mapQuery = {
  queryKey: ['map'],
  queryFn: fetchMap,
  staleTime: Number.POSITIVE_INFINITY,
};

/** Opens a node at its line, the way a jump to its definition would. */
export type OpenNode = (node: MapNode) => void;

export function CodeMapView({ onOpen }: { onOpen: OpenNode }) {
  const map = useQuery(mapQuery);
  return (
    <div className="code-map fade-in">
      <div className="code-header">
        <span className="map-title">Code map</span>
        <span className="code-range">what this change touches, and what uses it</span>
      </div>
      <div className="map-scroll">
        {map.isPending ? (
          <p className="map-message">Reading the code…</p>
        ) : map.isError ? (
          <p className="map-message">Docent couldn't draw the map: {map.error.message}</p>
        ) : (
          <MapBody map={map.data} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}

function MapBody({ map, onOpen }: { map: MapData; onOpen: OpenNode }) {
  const [active, setActive] = useState<string | null>(null);
  const changedY = useMemo(() => rowCenters(map.changed), [map.changed]);
  // The server ranks callers by how connected they are. On screen, each file sits level with
  // what it uses, so the links cross as little as they can.
  const callers = useMemo(
    () => levelWith(map.callers, map.edges, changedY),
    [map.callers, map.edges, changedY],
  );
  const callerY = useMemo(() => rowCenters(callers), [callers]);
  const nodes = useMemo(
    () =>
      new Map(
        [...map.changed, ...map.callers].flatMap((g) => g.nodes.map((n) => [n.id, n] as const)),
      ),
    [map],
  );
  // The nodes linked to the active one, so the rest can fade back.
  const near = useMemo(() => {
    if (active === null) return null;
    const ids = new Set([active]);
    for (const e of map.edges) {
      if (e.from === active) ids.add(e.to);
      if (e.to === active) ids.add(e.from);
    }
    return ids;
  }, [active, map.edges]);
  const height = Math.max(columnHeight(map.changed), columnHeight(callers));
  const across = map.edges.filter((e) => callerY.has(e.from) && changedY.has(e.to));
  const within = map.edges.filter((e) => changedY.has(e.from) && changedY.has(e.to));
  const lit = (e: MapEdge) => active !== null && (e.from === active || e.to === active);
  const nodeProps = (node: MapNode) => ({
    node,
    dim: near !== null && !near.has(node.id),
    onOpen,
    onActive: setActive,
  });

  if (map.changed.length === 0 && map.otherFiles.length === 0) {
    return <p className="map-message">Nothing to map: this PR changes no lines at head.</p>;
  }
  return (
    <>
      <div className="map-grid">
        <h3 className="map-heading map-changed-heading">Changed in this PR</h3>
        <h3 className="map-heading map-callers-heading">Used by</h3>
        <svg
          className="map-arcs"
          width={ARCS}
          height={height}
          viewBox={`0 0 ${ARCS} ${height}`}
          aria-hidden="true"
        >
          {within.map((e) => {
            const y1 = changedY.get(e.from) ?? 0;
            const y2 = changedY.get(e.to) ?? 0;
            const bend = ARCS - Math.min(ARCS - 4, 6 + Math.abs(y2 - y1) / 6);
            return (
              <path
                key={`${e.from}>${e.to}`}
                className={lit(e) ? 'map-link lit' : 'map-link'}
                d={`M${ARCS} ${y1} C${bend} ${y1}, ${bend} ${y2}, ${ARCS} ${y2}`}
              />
            );
          })}
        </svg>
        <Column groups={map.changed} side="changed" users={usersOf(map.edges, nodes)}>
          {(node) => <Node {...nodeProps(node)} />}
        </Column>
        <svg
          className="map-links"
          width={LINKS}
          height={height}
          viewBox={`0 0 ${LINKS} ${height}`}
          aria-hidden="true"
        >
          {across.map((e) => {
            const y1 = changedY.get(e.to) ?? 0;
            const y2 = callerY.get(e.from) ?? 0;
            const mid = LINKS / 2;
            return (
              <path
                key={`${e.from}>${e.to}`}
                className={lit(e) ? 'map-link lit' : 'map-link'}
                d={`M0 ${y1} C${mid} ${y1}, ${mid} ${y2}, ${LINKS} ${y2}`}
              />
            );
          })}
          {[
            ...[...new Set(across.map((e) => e.to))].map((id) => ({ id, x: 0, y: changedY })),
            ...[...new Set(across.map((e) => e.from))].map((id) => ({ id, x: LINKS, y: callerY })),
          ].map(({ id, x, y }) => (
            <circle
              key={id}
              className={near?.has(id) ? 'map-port lit' : 'map-port'}
              cx={x}
              cy={y.get(id) ?? 0}
              r={2.5}
            />
          ))}
        </svg>
        {callers.length > 0 ? (
          <Column groups={callers} side="callers" users={null}>
            {(node) => <Node {...nodeProps(node)} />}
          </Column>
        ) : (
          <p className="map-none">
            {map.changed.some((g) => g.nodes.some((n) => n.kind !== 'file'))
              ? 'Nothing else in the repo uses these.'
              : 'No definitions changed, so nothing to follow.'}
          </p>
        )}
      </div>
      <MapFooter map={map} onOpen={onOpen} />
    </>
  );
}

function Column({
  groups,
  side,
  users,
  children,
}: {
  groups: readonly MapGroup[];
  side: 'changed' | 'callers';
  /** On the changed side: who uses each node, for the narrow layout's list. */
  users: ReadonlyMap<string, MapNode[]> | null;
  children: (node: MapNode) => ReactNode;
}) {
  return (
    <ul
      className={`map-groups map-${side}`}
      aria-label={side === 'changed' ? 'Changed' : 'Used by'}
    >
      {groups.map((group) => (
        <li key={group.path} className="map-group">
          <div className="map-group-head" title={group.path}>
            <FileName path={group.path} />
          </div>
          <ul className="map-nodes">
            {group.nodes.map((node) => (
              <li key={node.id}>
                {children(node)}
                {users && <UsedBy users={users.get(node.id) ?? []} />}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function Node({
  node,
  dim,
  onOpen,
  onActive,
}: {
  node: MapNode;
  dim: boolean;
  onOpen: OpenNode;
  onActive: (id: string | null) => void;
}) {
  return (
    <button
      type="button"
      className={dim ? 'map-node dim' : 'map-node'}
      data-node={node.id}
      onClick={() => onOpen(node)}
      onPointerEnter={() => onActive(node.id)}
      onPointerLeave={() => onActive(null)}
      onFocus={() => onActive(node.id)}
      onBlur={() => onActive(null)}
      title={`${node.path}, line ${node.line}`}
    >
      <span className="map-kind" aria-hidden="true">
        {KIND_LABELS[node.kind]}
      </span>
      {node.kind === 'file' ? (
        <span className="map-name file">top-level code</span>
      ) : (
        <span className="map-name">{node.name}</span>
      )}
      <span className="map-line">{node.line}</span>
    </button>
  );
}

/** The narrow layout's stand-in for links: who uses this node, as a quiet list. */
function UsedBy({ users }: { users: readonly MapNode[] }) {
  if (users.length === 0) return null;
  return (
    <p className="map-used-by">
      used by{' '}
      {users.map((u, i) => (
        <span key={u.id}>
          {i > 0 && ', '}
          <span className="map-used-name">{u.kind === 'file' ? baseName(u.path) : u.name}</span>
        </span>
      ))}
    </p>
  );
}

function MapFooter({ map, onOpen }: { map: MapData; onOpen: OpenNode }) {
  const left: string[] = [];
  if (map.hidden.changed > 0) left.push(`${map.hidden.changed} more changed`);
  if (map.hidden.callers > 0) left.push(`${map.hidden.callers} more callers`);
  const partial = map.index.state === 'partial' || map.truncated;
  if (left.length === 0 && map.otherFiles.length === 0 && !partial) return null;
  return (
    <div className="map-footer">
      {left.length > 0 && <p>Not shown, to keep the map readable: {left.join(' and ')}.</p>}
      {map.otherFiles.length > 0 && (
        <p>
          Also changed:{' '}
          {map.otherFiles.map((path, i) => (
            <span key={path}>
              {i > 0 && ', '}
              <button
                type="button"
                className="map-other"
                onClick={() => onOpen({ id: path, path, line: 1, kind: 'file' })}
              >
                {path}
              </button>
            </span>
          ))}
          {map.hidden.otherFiles > 0 && ` and ${map.hidden.otherFiles} more`}
        </p>
      )}
      {partial && <p>Some callers may be missing: Docent read only part of the repo.</p>}
    </div>
  );
}

function FileName({ path }: { path: string }) {
  const slash = path.lastIndexOf('/');
  return (
    <span className="map-file">
      {slash >= 0 && <span className="map-dir">{path.slice(0, slash + 1)}</span>}
      <span className="map-base">{path.slice(slash + 1)}</span>
    </span>
  );
}

/** The vertical middle of each row, from the top of its column. */
function rowCenters(groups: readonly MapGroup[]): Map<string, number> {
  const centers = new Map<string, number>();
  let top = 0;
  for (const group of groups) {
    for (const [i, node] of group.nodes.entries()) {
      centers.set(node.id, top + HEAD + i * ROW + ROW / 2);
    }
    top += groupHeight(group) + GAP;
  }
  return centers;
}

/**
 * Caller files ordered by the average height of the changed rows they use, so each sits level
 * with what it uses. Ties, and files that use nothing on the map, keep their order.
 */
function levelWith(
  groups: readonly MapGroup[],
  edges: readonly MapEdge[],
  changedY: ReadonlyMap<string, number>,
): MapGroup[] {
  const level = (group: MapGroup) => {
    const ids = new Set(group.nodes.map((n) => n.id));
    const ys = edges.flatMap((e) => (ids.has(e.from) ? (changedY.get(e.to) ?? []) : []));
    return ys.length > 0 ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY;
  };
  return groups
    .map((group, i) => ({ group, i, y: level(group) }))
    .sort((a, b) => a.y - b.y || a.i - b.i)
    .map(({ group }) => group);
}

const groupHeight = (group: MapGroup) => HEAD + group.nodes.length * ROW + PAD;

const columnHeight = (groups: readonly MapGroup[]) =>
  groups.reduce((sum, g) => sum + groupHeight(g), 0) + Math.max(0, groups.length - 1) * GAP;

/** Each node's users, from the links into it, in the order the map lists them. */
function usersOf(
  edges: readonly MapEdge[],
  nodes: ReadonlyMap<string, MapNode>,
): Map<string, MapNode[]> {
  const users = new Map<string, MapNode[]>();
  for (const e of edges) {
    const from = nodes.get(e.from);
    if (!from) continue;
    users.set(e.to, [...(users.get(e.to) ?? []), from]);
  }
  return users;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
