import { Bundler } from '../../bundler';
import { DepMap } from '../../module-registry';
import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';

const DEPS = {
  'server-only': '^0.0.1',
};

const MOCK_FS_GLOBAL_NAME = 'mock-fs.global-instance';

const HELPER_PATH = '/node_modules/__csb_bust/mock-fs.js';
const HELPER_CODE = `
if (module.subgraphId && module.subgraphId !== 'server') {
  throw new Error('Cannot import "fs" outside of server')
}
const fs = globalThis["${MOCK_FS_GLOBAL_NAME}"];
if (!fs) {
  throw new Error('[mock-fs] Internal error: global was not installed');
}
module.exports = fs;
`.trim();

const IMPORT_SPECIFIERS = ['fs', 'node:fs'];

type Opts = { addServerOnly: boolean };

const createMockFs = (bundler: Bundler) => {
  const bundlerFs = bundler.fs;
  const assertEncodingUtf8 = (encoding: unknown) => {
    if (encoding === undefined) {
      throw new Error('Encoding is required');
    }
    if (encoding !== 'utf-8') {
      throw new Error(`Encoding not implemented: ${encoding}`);
    }
  };
  return new Proxy(
    {
      __esModule: true,
      __fs: bundlerFs,
      readFileSync: (path: string, encoding: string): string => {
        assertEncodingUtf8(encoding);
        return bundlerFs.readFileSync(path);
      },
      writeFileSync: (path: string, content: string, encoding: string) => {
        assertEncodingUtf8(encoding);
        return bundlerFs.writeFile(path, content);
      },
      existsSync: (path: string) => {
        return bundlerFs.isFile(path);
      },
    },
    {
      get(target, key) {
        if (key in target) {
          return target[key as keyof typeof target];
        }
        throw new Error(`Not implemented: fs.${typeof key === 'string' ? key : key.toString()}`);
      },
    }
  );
};

export class MockFSTransformer extends Transformer {
  opts: Opts;
  constructor(opts: Partial<Opts> = {}) {
    super('mock-fs-transformer');
    this.opts = { addServerOnly: false, ...opts };
  }

  async init(bundler: Bundler): Promise<void> {
    // Write helper to memory-fs
    if (!bundler.fs.isFileSync(HELPER_PATH)) {
      // first time initializing here.
      // @ts-expect-error
      globalThis[MOCK_FS_GLOBAL_NAME] = createMockFs(bundler);

      bundler.fs.writeFile(HELPER_PATH, HELPER_CODE);

      for (const specifier of IMPORT_SPECIFIERS) {
        // trick the resolver into resolving imports of "fs" and "node:fs" to our mock
        const dir = '/node_modules/' + specifier;
        bundler.fs.writeFile(
          dir + '/' + 'package.json',
          JSON.stringify({ type: 'commonjs', name: specifier, main: 'index.js' })
        );
        bundler.fs.writeFile(
          dir + '/' + 'index.js',
          (this.opts.addServerOnly ? 'require("server-only");' : '') + `module.exports = require("${HELPER_PATH}");`
        );
      }
    }
  }

  async transform(ctx: ITranspilationContext, config: any): Promise<ITranspilationResult> {
    return {
      code: ctx.code,
      dependencies: new Set(),
    };
  }

  augmentDependencies(dependencies: DepMap): DepMap {
    for (const [depName, depVersion] of Object.entries(DEPS)) {
      if (!this.opts.addServerOnly && depName === 'server-only') {
        continue;
      }
      if (!dependencies[depName]) {
        dependencies[depName] = depVersion;
      }
    }
    return dependencies;
  }
}
