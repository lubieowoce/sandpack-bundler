import { Bundler } from '../../bundler';
import { DepMap } from '../../module-registry';
import { Module } from '../../module/Module';
import { SUBGRAPHS } from '../../subgraphs';
import { BabelTransformer } from '../../transforms/babel';
import { CSSTransformer } from '../../transforms/css';
import { MockFSTransformer } from '../../transforms/mock-fs';
import { ReactRefreshTransformer } from '../../transforms/react-refresh';
import { StyleTransformer } from '../../transforms/style';
import { Preset } from '../Preset';

type ReactPresetOpts = { type: 'server' | 'client'; fs?: boolean };
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
      bundler.hasSubgraphs = true;
      bundler.subgraphImportConditions = {
        [SUBGRAPHS.client]: ['...'],
        [SUBGRAPHS.server]: ['react-server', '...'], // TODO(graph): make this customizable by presets, a la `setResolveOptions`
      };
    }

    await Promise.all([
      this.registerTransformer(new BabelTransformer()),
      this.registerTransformer(new ReactRefreshTransformer()),
      this.registerTransformer(new CSSTransformer()),
      this.registerTransformer(new StyleTransformer()),
      this.opts.fs && this.registerTransformer(new MockFSTransformer({ addServerOnly: false })),
    ]);
  }

  getCustomGlobals(module: Module) {
    const subgraphId = module.subgraphId;
    if (!subgraphId) return undefined;
    const prefix = {
      [SUBGRAPHS.client]: 'REACT_CLIENT$',
      [SUBGRAPHS.server]: 'REACT_SERVER$',
    }[subgraphId];
    return {
      __webpack_chunk_load__: (globalThis as any)[prefix + '__webpack_chunk_load__'],
      __webpack_require__: (globalThis as any)[prefix + '__webpack_require__'],
    };
  }

  mapTransformers(module: Module): Array<[string, any]> {
    const isServer = module.subgraphId === 'server';

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
            plugins: isServer ? [['react-server-use-client', {}] as ConfigEntry, reactRefresh] : [reactRefresh],
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
