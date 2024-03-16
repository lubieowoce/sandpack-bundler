export const SUBGRAPHS = {
  client: 'client' as const,
  server: 'server' as const,
};

export const NO_SUBGRAPH = undefined;

const SUBGRAPH_VALUES: SubgraphId[] = [SUBGRAPHS.client, SUBGRAPHS.server];

export type SubgraphId = 'client' | 'server';

// TODO: maybe, if subgraphs are not specified, we just put everything into '(client)'?

export function toSubGraphPath(path: string, subgraphId?: SubgraphId) {
  if (!subgraphId) {
    return path;
  }
  if (path.startsWith('(')) {
    throw new Error(`Path "${path}" is already a subgraph path`);
  }
  return `(${subgraphId})${path}`;
}

export function unSubGraphPath(path: string, strict = true) {
  if (!path.startsWith('(')) {
    if (strict) {
      throw new Error(`Path "${path}" is not a subgraph path`);
    }
    return path;
  }
  const end = path.indexOf(')');
  if (end === -1) {
    throw new Error(`Path "${path}" is not a valid subgraph path`);
  }
  return path.slice(end);
}

type ParsedSubgraphPathStrict = { resourcePath: string; subgraphId: SubgraphId };
type ParsedSubgraphPathLoose = { resourcePath: string; subgraphId: SubgraphId | undefined };

export function parseSubgraphPath(path: string): ParsedSubgraphPathStrict;
export function parseSubgraphPath(path: string, strict: true): ParsedSubgraphPathStrict;
export function parseSubgraphPath(path: string, strict: false): ParsedSubgraphPathLoose;
export function parseSubgraphPath(path: string, strict: boolean): ParsedSubgraphPathLoose;
export function parseSubgraphPath(path: string, strict = true) {
  if (!path.startsWith('(')) {
    if (strict) {
      throw new Error(`Path "${path}" is not a subgraph path`);
    }
    return { resourcePath: path, subgraphId: NO_SUBGRAPH };
  }
  const end = path.indexOf(')');
  if (end === -1) {
    throw new Error(`Path "${path}" is not a valid subgraph path`);
  }
  const resourcePath = path.slice(end + 1);
  const parsedSubgraphId = path.slice(1, end);

  // re-use the same string -- we don't need to allocate a bajillion copies of these strings.
  const i = (SUBGRAPH_VALUES as string[]).indexOf(parsedSubgraphId);
  if (i === -1) {
    throw new Error(`Invalid subgraph ID "${parsedSubgraphId}" from path "${path}"`);
  }
  const subgraphId = SUBGRAPH_VALUES[i];

  return { resourcePath, subgraphId };
}

export function getSubgraphFileUrl(id: string) {
  return '/' + id;
}

export function getResourcePathFromSubgraphFileUrl(url: string): string {
  if (!url.startsWith('/')) {
    return url;
  }
  return parseSubgraphPath(url.slice(1), false).resourcePath;
}
