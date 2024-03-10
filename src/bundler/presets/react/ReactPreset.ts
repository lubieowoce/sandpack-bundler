import { Bundler } from '../../bundler';
import { DepMap } from '../../module-registry';
import { Module } from '../../module/Module';
import { BabelTransformer } from '../../transforms/babel';
import { CSSTransformer } from '../../transforms/css';
import { ReactRefreshTransformer } from '../../transforms/react-refresh';
import { StyleTransformer } from '../../transforms/style';
import { Preset } from '../Preset';

type ReactPresetOpts = { type: 'server' | 'client' };
const DEFAULT_OPTS: ReactPresetOpts = { type: 'client' };

export class ReactPreset extends Preset {
  defaultHtmlBody = '<div id="root"></div>';
  opts: ReactPresetOpts;

  constructor(opts: ReactPresetOpts = DEFAULT_OPTS) {
    super(opts.type === 'server' ? 'react-server' : 'react');
    this.opts = opts;
  }

  async init(bundler: Bundler): Promise<void> {
    await super.init(bundler);
    if (this.opts.type === 'server') {
      bundler.setResolveOptions({ conditionNames: ['react-server', '...'] });
    }

    await Promise.all([
      this.registerTransformer(new BabelTransformer()),
      this.registerTransformer(new ReactRefreshTransformer()),
      this.registerTransformer(new CSSTransformer()),
      this.registerTransformer(new StyleTransformer()),
    ]);
  }

  mapTransformers(module: Module): Array<[string, any]> {
    if (/^(?!\/node_modules\/).*\.(((m|c)?jsx?)|tsx)$/.test(module.filepath)) {
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
            plugins: [['react-refresh/babel', { skipEnvCheck: true }]],
          },
        ],
        ['react-refresh-transformer', {}],
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
    if (!dependencies['react-refresh']) {
      dependencies['react-refresh'] = '^0.11.0';
    }
    dependencies['core-js'] = '3.22.7';
    return dependencies;
  }
}
