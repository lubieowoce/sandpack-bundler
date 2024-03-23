import { ModuleRegistry } from '../../bundler/module-registry';
import { retryFetch } from '../../utils/fetch';
import { FSLayer } from '../FSLayer';

function getUnpkgSpecifier(moduleName: string, moduleVersion: string, path: string): string {
  return `${moduleName}@${moduleVersion}/${path}`;
}

export class NodeModuleFSLayer extends FSLayer {
  private unpkgPromises: Map<string, Promise<string>> = new Map();
  private unpkgCache: Map<string, string | false> = new Map();

  constructor(private registry: ModuleRegistry) {
    super('node-module-fs');
  }

  async _fetchUnpkgFile(specifier: string): Promise<string> {
    try {
      const response = await retryFetch(`https://unpkg.com/${specifier}`, { maxRetries: 5 });
      const content = await response.text();
      this.unpkgCache.set(specifier, content);
      return content;
    } catch (err) {
      this.unpkgCache.set(specifier, false);
      throw err;
    }
  }

  fetchUnpkgFile(moduleName: string, moduleVersion: string, path: string): Promise<string> {
    const specifier = getUnpkgSpecifier(moduleName, moduleVersion, path);
    const cachedContent = this.unpkgCache.get(specifier);
    if (typeof cachedContent === 'string') {
      return Promise.resolve(cachedContent);
    } else if (cachedContent === false) {
      return Promise.reject('unpkg file not found');
    }

    const promise = this.unpkgPromises.get(specifier) || this._fetchUnpkgFile(specifier);
    this.unpkgPromises.set(specifier, promise);
    return promise;
  }

  getUnpkgFile(moduleName: string, moduleVersion: string, path: string): string {
    const specifier = getUnpkgSpecifier(moduleName, moduleVersion, path);
    const cachedContent = this.unpkgCache.get(specifier);
    if (typeof cachedContent === 'string') {
      return cachedContent;
    }
    throw new Error(`File not found in unpkg cache: ${moduleName}@${moduleVersion} - ${path}`);
  }

  readFileSync(path: string): string {
    const found = this.registry.getPath(path);
    if (found) {
      const { nodeModule: module, file } = found;
      if (file) {
        if (file.contents !== null) {
          return file.contents;
        } else {
          return this.getUnpkgFile(module.name, module.version, file.path);
        }
      }
    }
    throw new Error(`Module ${path} not found`);
  }

  async readFileAsync(path: string): Promise<string> {
    const found = this.registry.getPath(path);
    if (found) {
      const { nodeModule: module, file } = found;
      if (file) {
        if (file.contents !== null) {
          return file.contents;
        } else {
          return this.fetchUnpkgFile(module.name, module.version, file.path);
        }
      }
    }
    throw new Error(`Module ${path} not found`);
  }

  isFileSync(path: string): boolean {
    try {
      const found = this.registry.getPath(path);
      if (found) {
        return found.file != null;
      }
    } catch (err) {
      // do nothing...
    }
    return false;
  }

  isFileAsync(path: string): Promise<boolean> {
    return Promise.resolve(this.isFileSync(path));
  }
}
