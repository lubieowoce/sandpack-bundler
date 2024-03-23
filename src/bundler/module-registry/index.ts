import { ModuleNotFoundError } from '../../errors/ModuleNotFound';
import * as logger from '../../utils/logger';
import { sortObj } from '../../utils/object';
import { Bundler } from '../bundler';
import { Module } from '../module/Module';
import { NO_SUBGRAPH, SubgraphId } from '../subgraphs';
import { filterBuildDeps } from './build-dep';
import { CDNModuleFileType, ICDNModuleFile, IResolvedDependency, fetchManifest, fetchModule } from './module-cdn';
import { NodeModule } from './NodeModule';

// dependency => version range
export type DepMap = { [depName: string]: string };

export class ModuleRegistry {
  modules: Map<string, NodeModule> = new Map();
  moduleDownloadPromises: Map<string, Promise<NodeModule>> = new Map();

  manifest: IResolvedDependency[] = [];

  bundler: Bundler;

  constructor(bundler: Bundler) {
    this.bundler = bundler;
  }

  async fetchManifest(deps: DepMap, shouldFilterBuildDeps = true): Promise<void> {
    if (shouldFilterBuildDeps) {
      deps = filterBuildDeps(deps);
    }

    const sortedDeps = sortObj(deps);
    logger.debug('Fetching manifest', sortedDeps);
    this.manifest = await fetchManifest(sortedDeps);
    logger.debug('fetched manifest', this.manifest);
  }

  async preloadModules(): Promise<void> {
    await Promise.all(
      this.manifest.map((dep) => {
        return this.fetchNodeModule(dep.n, dep.v);
      })
    );
  }

  private async _fetchModule(name: string, version: string): Promise<NodeModule> {
    const module = await fetchModule(name, version);
    const processedNodeModule = new NodeModule(name, version, module.f, module.m);
    this.modules.set(name, processedNodeModule);
    logger.debug('fetched module', name, version, module);
    return processedNodeModule;
  }

  async fetchNodeModule(name: string, version: string): Promise<NodeModule> {
    // Module already found, skip fetching
    // This could also check version, but for now this is fine
    // as we don't allow multiple versions of the same module right now
    const foundModule = this.modules.get(name);
    if (foundModule) {
      return foundModule;
    }

    const cacheKey = `${name}::${version}`;
    let promise = this.moduleDownloadPromises.get(cacheKey);
    if (!promise) {
      promise = this._fetchModule(name, version).finally(() => this.moduleDownloadPromises.delete(cacheKey));
      this.moduleDownloadPromises.set(cacheKey, promise);
    }
    return promise;
  }

  getPath(
    path: string
  ): null | { nodeModule: NodeModule; file: { path: string; cdn: CDNModuleFileType; contents: string | null } | null } {
    if (!path.startsWith('/node_modules/')) return null;
    const parsed = parseNodeModulePath(path);
    if (!parsed) return null;
    const [name, relativePath] = parsed;
    const nodeModule = this.modules.get(name);
    if (!nodeModule) return null;
    const maybeFile = nodeModule.files[relativePath] ?? null;
    return {
      nodeModule: nodeModule,
      file:
        maybeFile === null
          ? null
          : {
              cdn: maybeFile,
              path: relativePath,
              contents: typeof maybeFile === 'object' ? maybeFile.c : null,
            },
    };
  }

  private _addPrecompiledNodeModuleToModuleGraph(path: string, file: ICDNModuleFile): Array<() => Promise<void>> {
    if (this.bundler.modules.has(path)) {
      return [];
    }

    const { c: content, d: dependencySpecifiers, t: isTranspiled } = file;
    const moduleId = path;
    const module = new Module(moduleId, path, content, isTranspiled, this.bundler, NO_SUBGRAPH);
    this.bundler.modules.set(path, module);
    this.bundler.markAsSharedModule(path);

    return dependencySpecifiers.map((dep) => {
      return async () => {
        const depModuleId = await module.addDependency(dep);
        void this.bundler.transformModule(depModuleId);
      };
    });
  }

  async addNodeModulesToModuleGraph(only?: string[]) {
    function catchNotFound<T>(promise: Promise<T>): Promise<T | null> {
      return promise.catch((err) => {
        // `loadModuleDependencies` tries to eagerly transform every file in every dependency.
        // if a package has multiple entrypoints (e.g. 'foo/client' & 'foo/server'),
        // the `server` one might contain imports of e.g `node:` builtins, which we don't have here.
        // However, we can just swallow the error here, and if the user *actually* tries to import the package,
        // we'll throw a proper error then.
        if (err instanceof ModuleNotFoundError) {
          logger.debug(`Error while loading dependency: ${err.message}`);
        }
        return null;
      });
    }

    const depPromises = [];
    const modulesToLoad = only
      ? only
          .filter((moduleName) => {
            if (this.modules.has(moduleName)) {
              return true;
            }
            // this may be a /node_modules/ path too.
            const parsed = parseNodeModulePath(moduleName);
            return !!(parsed && this.modules.has(parsed[0]));
          })
          .map((moduleName) => [moduleName, this.modules.get(moduleName)!] as const)
      : this.modules.entries();

    for (let [moduleName, nodeModule] of modulesToLoad) {
      for (let [fileName, file] of Object.entries(nodeModule.files)) {
        if (typeof file === 'object') {
          const promises = this._addPrecompiledNodeModuleToModuleGraph(
            `/node_modules/${moduleName}/${fileName}`,
            file
          ).map((cb) => () => catchNotFound(cb()));
          depPromises.push(...promises);
        }
      }
    }
    await Promise.all(depPromises.map((fn) => fn()));
  }
}

const MODULE_PATH_RE = /^\/node_modules\/(@[^/]+\/[^/]+|[^@/]+)(.*)$/;

const parsedNodeModulePathCache = new Map<string, ParsedNodeModulePath>();

type ParsedNodeModulePath = [string, string] | null;

/** Turns a path into [moduleName, relativePath] */
export function parseNodeModulePath(path: string): [string, string] | null {
  const cached = parsedNodeModulePathCache.get(path);
  if (cached) return cached;

  let result: ParsedNodeModulePath;
  const parts = path.match(MODULE_PATH_RE);
  if (!parts) {
    result = null;
  } else {
    const moduleName = parts[1];
    const modulePath: string = parts[2] ?? '';
    return [moduleName, modulePath.substring(1)];
  }
  parsedNodeModulePathCache.set(path, result);
  return result;
}

export function isPackageName(specifier: string): boolean {
  return parseNodeModulePath('/node_modules/' + specifier) !== null;
}
