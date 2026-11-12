import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceZ } from 'd3-force-3d';
import { UMAP } from 'umap-js';
import type { Directory, FileTrack } from '../lib/schema';
import type { Track } from './git';
import { hash, randomSource, type Edge } from './graph';
import { UnsupportedRepositoryError } from './errors';

export type Layout = 'tree' | 'force' | 'spectral';
const maximumDirectoryDepth = 512;
const directoryOf = (path: string) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : '.');
const colors = [
  '#72a7e8',
  '#d79b63',
  '#84b99b',
  '#b69bda',
  '#d48595',
  '#82bcc8',
  '#b9bc79',
  '#c99aaf',
];

function normalize(points: number[][]): [number, number, number][] {
  const means = [0, 1, 2].map(
    (axis) => points.reduce((sum, point) => sum + point[axis], 0) / Math.max(1, points.length),
  );
  let radius = 1;
  for (const point of points)
    radius = Math.max(radius, Math.hypot(...point.map((value, axis) => value - means[axis])));
  return points
    .map((point) =>
      [0, 1, 2].map((axis) => Math.round(((point[axis] - means[axis]) / radius) * 100000) / 1000),
    )
    .map(([x, y, z]) => [x, y, z]);
}

type Point = [number, number, number];
type DirectoryNode = { children: Map<string, DirectoryNode>; files: number[]; center: Point };

function treePositions(tracks: Track[]): { positions: Point[]; anchors: Point[] } {
  const root: DirectoryNode = { children: new Map(), files: [], center: [0, 0, 0] };
  const positions: Point[] = tracks.map(() => [0, 0, 0]);
  const anchors: Point[] = tracks.map(() => [0, 0, 0]);
  tracks.forEach((track, index) => {
    let node = root;
    for (const part of track.path.split('/').slice(0, -1)) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), files: [], center: [0, 0, 0] };
        node.children.set(part, child);
      }
      node = child;
    }
    node.files.push(index);
  });
  const pending: [DirectoryNode, number][] = [[root, 0]];
  while (pending.length) {
    const [node, depth] = pending.pop()!;
    if (depth > maximumDirectoryDepth)
      throw new UnsupportedRepositoryError(
        `Unsupported repository: directory nesting exceeds ${maximumDirectoryDepth} levels`,
      );
    for (const child of node.children.values()) pending.push([child, depth + 1]);
  }
  const place = (node: DirectoryNode, radius: number, path: string) => {
    const children = [...node.children].sort(([a], [b]) => a.localeCompare(b, 'en'));
    const rotation = (hash(path) / 4294967296) * Math.PI * 2;
    children.forEach(([name, child], index) => {
      const z = 1 - (2 * (index + 0.5)) / children.length;
      const angle = rotation + index * Math.PI * (3 - Math.sqrt(5));
      const ring = Math.sqrt(1 - z * z);
      child.center = [
        node.center[0] + radius * ring * Math.cos(angle),
        node.center[1] + radius * z,
        node.center[2] + radius * ring * Math.sin(angle),
      ];
      place(child, radius * 0.32, `${path}/${name}`);
    });
    node.files.sort(
      (a, b) => tracks[a].path.localeCompare(tracks[b].path, 'en') || tracks[a].id - tracks[b].id,
    );
    node.files.forEach((index, order) => {
      const z = 1 - (2 * (order + 0.5)) / node.files.length;
      const angle = rotation + order * Math.PI * (3 - Math.sqrt(5));
      const ring = Math.sqrt(1 - z * z);
      const spread = radius * 0.28;
      anchors[index] = node.center;
      positions[index] = [
        node.center[0] + spread * ring * Math.cos(angle),
        node.center[1] + spread * z,
        node.center[2] + spread * ring * Math.sin(angle),
      ];
    });
  };
  place(root, 60, '');
  return { positions, anchors };
}

function spectralFeatures(tracks: Track[], edges: Edge[]): number[][] {
  const index = new Map(tracks.map((track, i) => [track.id, i]));
  const adjacent: { node: number; weight: number }[][] = tracks.map(() => []);
  const degree = new Float64Array(tracks.length);
  for (const edge of edges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a === undefined || b === undefined) continue;
    adjacent[a].push({ node: b, weight: edge.weight });
    adjacent[b].push({ node: a, weight: edge.weight });
    degree[a] += edge.weight;
    degree[b] += edge.weight;
  }
  const constant = Float64Array.from(degree, (value) => Math.sqrt(value));
  const norm = Math.hypot(...constant) || 1;
  for (let i = 0; i < constant.length; i++) constant[i] /= norm;
  const basis: Float64Array[] = [constant];
  const random = randomSource(42);
  for (let dimension = 0; dimension < 8; dimension++) {
    let vector = Float64Array.from(tracks, () => random() - 0.5);
    for (let iteration = 0; iteration < 60; iteration++) {
      const next = Float64Array.from(vector, (value) => value * 0.5);
      for (let i = 0; i < tracks.length; i++)
        for (const neighbor of adjacent[i])
          next[i] +=
            (0.5 * neighbor.weight * vector[neighbor.node]) /
            Math.sqrt(degree[i] * degree[neighbor.node]);
      for (const previous of basis) {
        let dot = 0;
        for (let i = 0; i < next.length; i++) dot += next[i] * previous[i];
        for (let i = 0; i < next.length; i++) next[i] -= dot * previous[i];
      }
      let magnitude = 0;
      for (const value of next) magnitude += value * value;
      magnitude = Math.sqrt(magnitude) || 1;
      for (let i = 0; i < next.length; i++) next[i] /= magnitude;
      vector = next;
    }
    basis.push(vector);
  }
  return tracks.map((_, index) => basis.slice(1).map((vector) => vector[index]));
}

const spectralLandmarkLimit = 2048;

async function spectralPositions(
  tracks: Track[],
  edges: Edge[],
  prior: Point[],
  iterations: number,
): Promise<Point[]> {
  const index = new Map(tracks.map((track, i) => [track.id, i]));
  const degree = new Float64Array(tracks.length);
  const adjacency: { node: number; weight: number }[][] = tracks.map(() => []);
  for (const edge of edges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a === undefined || b === undefined) continue;
    degree[a] += edge.weight;
    degree[b] += edge.weight;
    adjacency[a].push({ node: b, weight: edge.weight });
    adjacency[b].push({ node: a, weight: edge.weight });
  }
  const ranked = tracks
    .map((_, i) => i)
    .sort((a, b) => degree[b] - degree[a] || tracks[a].id - tracks[b].id);
  const chosen = new Set(ranked.slice(0, Math.min(tracks.length, spectralLandmarkLimit / 2)));
  const rest = ranked
    .filter((index) => !chosen.has(index))
    .sort(
      (a, b) =>
        hash(`${tracks[a].id}:${tracks[a].path}`) - hash(`${tracks[b].id}:${tracks[b].path}`) ||
        tracks[a].id - tracks[b].id,
    );
  for (const index of rest.slice(0, spectralLandmarkLimit - chosen.size)) chosen.add(index);
  const landmarks = [...chosen].sort((a, b) => a - b);
  const membership = new Map(landmarks.map((node, index) => [node, index]));
  const directoryLandmarks = new Map<string, number>();
  for (const node of landmarks) {
    const parts = tracks[node].path.split('/').slice(0, -1);
    for (let length = parts.length; length >= 0; length--) {
      const key = parts.slice(0, length).join('/');
      if (!directoryLandmarks.has(key)) directoryLandmarks.set(key, node);
    }
  }
  const assignment = tracks.map((track, node) => {
    if (chosen.has(node)) return node;
    let best: { node: number; weight: number } | undefined;
    for (const neighbor of adjacency[node])
      if (chosen.has(neighbor.node) && (!best || neighbor.weight > best.weight)) best = neighbor;
    if (best) return best.node;
    const parts = track.path.split('/').slice(0, -1);
    for (let length = parts.length; length >= 0; length--) {
      const landmark = directoryLandmarks.get(parts.slice(0, length).join('/'));
      if (landmark !== undefined) return landmark;
    }
    return landmarks[0];
  });
  const coarse = new Map<string, Edge>();
  for (const edge of edges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a === undefined || b === undefined) continue;
    const source = Math.min(assignment[a], assignment[b]);
    const target = Math.max(assignment[a], assignment[b]);
    if (source === target) continue;
    const key = `${source}:${target}`;
    const existing = coarse.get(key);
    if (existing) existing.weight += edge.weight;
    else
      coarse.set(key, {
        source: tracks[source].id,
        target: tracks[target].id,
        weight: edge.weight,
      });
  }
  const features = spectralFeatures(
    landmarks.map((node) => tracks[node]),
    [...coarse.values()],
  );
  const umap = new UMAP({
    nComponents: 3,
    nNeighbors: Math.min(15, landmarks.length - 1),
    nEpochs: Math.max(50, iterations),
    random: randomSource(42),
  });
  const embedding = normalize(await umap.fitAsync(features));
  const landmarkPosition = (node: number) => embedding[membership.get(assignment[node]) ?? 0];
  const initial: Point[] = tracks.map((_, node) => {
    const anchor = landmarkPosition(node);
    return [
      anchor[0] + (prior[node][0] - prior[assignment[node]][0]) * 0.12,
      anchor[1] + (prior[node][1] - prior[assignment[node]][1]) * 0.12,
      anchor[2] + (prior[node][2] - prior[assignment[node]][2]) * 0.12,
    ];
  });
  let positions = initial;
  for (let iteration = 0; iteration < 12; iteration++) {
    positions = positions.map((point, node): Point => {
      if (chosen.has(node) || !degree[node]) return point;
      const result: Point = [
        initial[node][0] * 0.15,
        initial[node][1] * 0.15,
        initial[node][2] * 0.15,
      ];
      for (const neighbor of adjacency[node])
        for (let axis = 0; axis < 3; axis++)
          result[axis] += (0.85 * positions[neighbor.node][axis] * neighbor.weight) / degree[node];
      return result;
    });
  }
  return normalize(positions);
}

export async function layoutTracks(
  tracks: Track[],
  edges: Edge[],
  layout: Layout,
  iterations: number,
): Promise<{ files: FileTrack[]; directories: Directory[] }> {
  const tree = treePositions(tracks);
  let positions = tree.positions;
  const anchors = new Map(tracks.map((track, index) => [track.id, tree.anchors[index]]));
  if (layout === 'force' && tracks.length > 1) {
    const nodes = tracks.map((track, i) => ({
      id: track.id,
      x: positions[i][0],
      y: positions[i][1],
      z: positions[i][2],
    }));
    const simulation = forceSimulation(nodes, 3)
      .stop()
      .randomSource(randomSource(42))
      .force('charge', forceManyBody().strength(-12).theta(0.9))
      .force(
        'links',
        forceLink(edges.map((edge) => ({ ...edge })))
          .id((node) => node.id)
          .distance(9)
          .strength((edge) => Math.min(0.6, edge.weight * 0.15)),
      )
      .force('x', forceX((node) => anchors.get(node.id)?.[0] ?? 0).strength(0.008))
      .force('y', forceY((node) => anchors.get(node.id)?.[1] ?? 0).strength(0.008))
      .force('z', forceZ((node) => anchors.get(node.id)?.[2] ?? 0).strength(0.008));
    for (let tick = 0; tick < iterations; tick += 8) {
      simulation.tick(Math.min(8, iterations - tick));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    positions = normalize(nodes.map((node) => [node.x, node.y, node.z]));
  } else if (layout === 'spectral' && tracks.length > 4 && edges.length) {
    positions = await spectralPositions(tracks, edges, positions, iterations);
  } else positions = normalize(positions);
  const files = tracks.map((track, index) => ({
    ...track,
    directory: directoryOf(track.path),
    position: positions[index],
  }));
  const groups = new Map<string, FileTrack[]>();
  for (const file of files) {
    const group = groups.get(file.directory);
    if (group) group.push(file);
    else groups.set(file.directory, [file]);
  }
  const directories = [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, members], index): Directory => ({
      path,
      files: members.length,
      centroid: centroid(members.map((file) => file.position)),
      color: colors[index % colors.length],
    }));
  return { files, directories };
}

export function centroid(points: [number, number, number][]): [number, number, number] {
  const sum: [number, number, number] = [0, 0, 0];
  for (const point of points)
    for (let axis = 0; axis < 3; axis++) sum[axis] += point[axis] / Math.max(1, points.length);
  return sum;
}
