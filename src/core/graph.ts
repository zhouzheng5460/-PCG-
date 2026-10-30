// 移植自 Source/com/watabou/geom/Graph.hx
// 原版 A* 其实没有启发式（就是 Dijkstra），并且用数组做 open 集。
// 保持行为一致，只在链接上增加了"被禁建区阻断"的标记。

export class Node {
  links: Map<Node, number> = new Map();
  blocked = false;

  link(node: Node, price = 1, symmetrical = true): void {
    this.links.set(node, price);
    if (symmetrical) node.links.set(this, price);
  }

  unlink(node: Node, symmetrical = true): void {
    this.links.delete(node);
    if (symmetrical) node.links.delete(this);
  }

  unlinkAll(): void {
    for (const node of Array.from(this.links.keys())) this.unlink(node);
  }
}

export class Graph {
  nodes: Node[] = [];

  add(node?: Node): Node {
    const n = node ?? new Node();
    this.nodes.push(n);
    return n;
  }

  remove(node: Node): void {
    node.unlinkAll();
    const i = this.nodes.indexOf(node);
    if (i !== -1) this.nodes.splice(i, 1);
  }

  aStar(start: Node, goal: Node, exclude?: Node[]): Node[] | null {
    const closedSet: Node[] = exclude ? exclude.slice() : [];
    const openSet: Node[] = [start];
    const cameFrom = new Map<Node, Node>();
    const gScore = new Map<Node, number>([[start, 0]]);

    while (openSet.length > 0) {
      const current = openSet.shift() as Node;
      if (current === goal) return this.buildPath(cameFrom, current);

      const ci = openSet.indexOf(current);
      if (ci !== -1) openSet.splice(ci, 1);
      closedSet.push(current);

      const curScore = gScore.get(current) as number;
      for (const [neighbour, price] of current.links) {
        if (closedSet.indexOf(neighbour) !== -1) continue;

        const score = curScore + price;
        const existing = gScore.get(neighbour);
        if (openSet.indexOf(neighbour) === -1) openSet.push(neighbour);
        else if (existing !== undefined && score >= existing) continue;

        cameFrom.set(neighbour, current);
        gScore.set(neighbour, score);
      }
    }

    return null;
  }

  private buildPath(cameFrom: Map<Node, Node>, current: Node): Node[] {
    const path = [current];
    while (cameFrom.has(current)) {
      current = cameFrom.get(current) as Node;
      path.push(current);
    }
    return path;
  }

  calculatePrice(path: Node[]): number {
    if (path.length < 2) return 0;
    let price = 0;
    let current = path[0];
    let next = path[1];
    for (let i = 0; i < path.length - 1; i++) {
      const p = current.links.get(next);
      if (p === undefined) return NaN;
      price += p;
      current = next;
      next = path[i + 1];
    }
    return price;
  }
}
