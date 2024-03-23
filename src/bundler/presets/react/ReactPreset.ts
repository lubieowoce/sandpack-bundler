import { Bundler } from '../../bundler';
import { DepMap } from '../../module-registry';
import { Evaluation } from '../../module/Evaluation';
import { Module } from '../../module/Module';
import { SUBGRAPHS, toSubGraphPath } from '../../subgraphs';
import { BabelTransformer } from '../../transforms/babel';
import { CSSTransformer } from '../../transforms/css';
import { MockFSTransformer } from '../../transforms/mock-fs';
import { ReactRefreshTransformer } from '../../transforms/react-refresh';
import { StyleTransformer } from '../../transforms/style';
import { Preset } from '../Preset';
import type { PluginOptions as ReactApiUsagePluginOptions } from './react-api-usage';
import type { PluginOptions as ReactClientUseServerPluginOptions } from './react-client-use-server';

type ReactPresetOpts = {
  type: 'server' | 'client';
  fs?: boolean;
  serverActions?: { transformOptions: ServerActionsPluginOpts };
  apiUsage?: ReactApiUsagePluginOptions;
};

type ServerActionsPluginOpts = {
  encryption?: {
    importSource: string;
    encryptFn: string;
    decryptFn: string;
  } | null;
  runtime?: {
    callServer?: {
      importSource: string;
      name: string;
    };
    createServerReference?: {
      importSource: string;
      name: string;
    };
    registerServerReference?: {
      importSource: string;
      name: string;
    };
  };
};

const DEFAULT_OPTS: ReactPresetOpts = { type: 'client' };

export class ReactPreset extends Preset {
  defaultHtmlBody = '<div id="root"></div>';
  opts: ReactPresetOpts;
  isServer: boolean;

  constructor(opts: ReactPresetOpts = DEFAULT_OPTS) {
    super(opts.type === 'server' ? 'react-server' : 'react');
    this.isServer = opts.type === 'server';
    this.opts = { ...DEFAULT_OPTS, fs: this.isServer, ...opts };
  }

  async init(bundler: Bundler): Promise<void> {
    await super.init(bundler);
    if (this.isServer) {
      bundler.setSubgraphImportConditions({
        [SUBGRAPHS.client]: ['...'],
        [SUBGRAPHS.server]: ['react-server', '...'],
      });
    }

    await Promise.all([
      this.registerTransformer(new BabelTransformer()),
      this.registerTransformer(new ReactRefreshTransformer()),
      this.registerTransformer(new CSSTransformer()),
      this.registerTransformer(new StyleTransformer()),
      this.opts.fs && this.registerTransformer(new MockFSTransformer({ addServerOnly: false })),
    ]);
  }

  getCustomGlobals(evaluation: Evaluation) {
    if (!this.isServer) {
      return;
    }
    // we need to emulate __webpack_require__ and __webpack_chunk_load__ for 'react-server-dom-webpack'.
    const bundler = evaluation.module.bundler;
    const _require = evaluation.require.bind(evaluation);
    const importer = evaluation.module;

    const __webpack_chunk_load__ = async (chunkId: string) => {
      const rawId = chunkId; // chunks don't exist, we expect this to be a module id
      if (!bundler.fs.isFileSync(rawId)) {
        throw new Error(`__webpack_chunk_load__ :: File not found ${rawId}`);
      }
      const id = toSubGraphPath(rawId, importer.subgraphId);
      try {
        await bundler.transformModule(id);
        await bundler.moduleFinishedPromise(id);
      } catch (err) {
        throw new Error(
          `__webpack_chunk_load__: Failed to load ${rawId}`,
          // @ts-expect-error old lib.dom types
          { cause: err }
        );
      }
    };

    const __webpack_require__ = (rawId: string) => {
      const id = toSubGraphPath(rawId, importer.subgraphId);
      // try returning exports synchronously. this is what RSDW expects here.

      // add it to dependencies (but that happens asynchronously).
      // use the raw id, that's what the resolver will expect.
      void _require(rawId);
      const module = bundler.getModule(id);
      if (!module) {
        throw new Error(`__webpack_require__: Module not found ${id}`);
      }
      const evaluation = module.evaluate();
      return evaluation.getExports();
    };

    // get chunk name. in our case chunks don't exist, it's the same as the module name
    __webpack_require__.u = (id: string) => {
      return id;
    };

    return {
      __webpack_chunk_load__,
      __webpack_require__,
    };
  }

  mapTransformers(module: Module): Array<[string, any]> {
    const isRscServer = module.subgraphId === 'server';
    const isRscClient = module.subgraphId === 'client';

    if (/^(?!\/node_modules\/).*\.(((m|c)?jsx?)|tsx)$/.test(module.filepath)) {
      type ConfigEntry = [string, any];
      const reactRefresh = ['react-refresh/babel', { skipEnvCheck: true, emitFullSignatures: true }] as ConfigEntry;
      return [
        [
          'babel-transformer',
          {
            presets: [
              [
                'react',
                {
                  runtime: 'automatic',
                },
              ],
            ],
            plugins: isRscServer
              ? [
                  ['react-api-usage', this.opts.apiUsage ?? {}], // TODO(analyzer): disable if info not passed? add defaults?
                  ['react-server-use-client', { encryption: null }] as ConfigEntry,
                  [
                    '@owoce/babel-rsc/plugin-use-server',
                    {
                      moduleIds: 'file-url-absolute',
                      encryption: null,
                      ...this.opts.serverActions?.transformOptions,
                    },
                  ] as ConfigEntry,
                  reactRefresh,
                  ['react-server-refresh-actions', {}] as ConfigEntry,
                ]
              : isRscClient
              ? [
                  ['react-api-usage', this.opts.apiUsage ?? {}],
                  [
                    'react-client-use-server',
                    {
                      ...this.opts.serverActions?.transformOptions,
                    } as ReactClientUseServerPluginOptions,
                  ] as ConfigEntry,
                  reactRefresh,
                ]
              : [reactRefresh],
          },
        ],
        ['react-refresh-transformer', {}] as ConfigEntry,
      ];
    }

    if (/\.(m|c)?(t|j)sx?$/.test(module.filepath) && !module.filepath.endsWith('.d.ts')) {
      return [
        [
          'babel-transformer',
          {
            presets: [
              [
                'react',
                {
                  runtime: 'automatic',
                },
              ],
            ],
          },
        ],
      ];
    }

    if (/\.css$/.test(module.filepath)) {
      return [
        ['css-transformer', {}],
        ['style-transformer', {}],
      ];
    }

    throw new Error(`No transformer for ${module.filepath}`);
  }

  augmentDependencies(dependencies: DepMap): DepMap {
    if (this.opts.fs) {
      const transformer = this.getTransformer('mock-fs-transformer');
      dependencies = (transformer as MockFSTransformer).augmentDependencies(dependencies);
    }
    if (!dependencies['react-refresh']) {
      dependencies['react-refresh'] = this.isServer ? 'canary' : '^0.14.0';
    }
    dependencies['core-js'] = '3.22.7';
    return dependencies;
  }
}
