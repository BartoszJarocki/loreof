declare module 'd3-force-3d' {
  export type Node = {
    id: number;
    x: number;
    y: number;
    z: number;
    vx?: number;
    vy?: number;
    vz?: number;
    index?: number;
  };
  export type Link = { source: number | Node; target: number | Node; weight: number };
  export type Force = ((alpha: number) => void) & {
    initialize?: (nodes: Node[], random: () => number, dimensions: number) => void;
  };
  export function forceSimulation(
    nodes: Node[],
    dimensions: number,
  ): {
    stop(): ReturnType<typeof forceSimulation>;
    randomSource(random: () => number): ReturnType<typeof forceSimulation>;
    force(name: string, force: Force): ReturnType<typeof forceSimulation>;
    tick(iterations: number): ReturnType<typeof forceSimulation>;
  };
  export function forceManyBody(): Force & {
    strength(value: number): ReturnType<typeof forceManyBody>;
    theta(value: number): ReturnType<typeof forceManyBody>;
  };
  export function forceLink(links: Link[]): Force & {
    id(get: (node: Node) => number): ReturnType<typeof forceLink>;
    distance(value: number): ReturnType<typeof forceLink>;
    strength(get: (link: Link) => number): ReturnType<typeof forceLink>;
  };
  export function forceX(
    target?: (node: Node) => number,
  ): Force & { strength(value: number): ReturnType<typeof forceX> };
  export function forceY(
    target?: (node: Node) => number,
  ): Force & { strength(value: number): ReturnType<typeof forceY> };
  export function forceZ(
    target?: (node: Node) => number,
  ): Force & { strength(value: number): ReturnType<typeof forceZ> };
}
