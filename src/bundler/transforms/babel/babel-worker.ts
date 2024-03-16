import type { PluginItem } from '@babel/core';
import * as babel from '@babel/standalone';

import * as logger from '../../../utils/logger';
import { once } from '../../../utils/once';
import { WorkerMessageBus } from '../../../utils/WorkerMessageBus';
import { SUBGRAPHS, SubgraphId } from '../../subgraphs';
import { ITranspilationResult } from '../Transformer';
import { loadPlugin, loadPreset } from './babel-plugin-registry';
import { collectDependencies } from './dep-collector';
import { getDynamicBabelTarget } from './dynamic-babel-target';

export interface ITransformData {
  code: string;
  filepath: string;
  subgraphId: SubgraphId | undefined;
  config: any;
}

function getNameFromConfigEntry(entry: any): string | null {
  if (typeof entry === 'string') {
    return entry;
  } else if (Array.isArray(entry) && typeof entry[0] === 'string') {
    return entry[0];
  } else {
    return null;
  }
}

// TODO: Normalize preset names
async function getPresets(presets: any): Promise<PluginItem[]> {
  const result: PluginItem[] = [
    [
      'env',
      {
        // targets: /* defined globally */,
        // https://github.com/rollup/rollup-plugin-babel/issues/254, and we can't exlude core-js because it breaks collectDependencies
        useBuiltIns: 'usage',
        // useBuiltIns: false,
        corejs: '3.22',
        exclude: ['@babel/plugin-transform-regenerator'],
      },
    ],
    'typescript',
  ];
  if (!Array.isArray(presets)) {
    return result;
  }
  for (const preset of presets) {
    const presetName = getNameFromConfigEntry(preset);
    if (presetName !== null) {
      if (!babel.availablePresets[presetName]) {
        babel.availablePresets[presetName] = await loadPreset(presetName);
      }

      const foundIndex = result.findIndex((v) => getNameFromConfigEntry(v) === presetName);
      if (foundIndex > -1) {
        result[foundIndex] = preset;
        continue;
      }
    }
    result.push(preset);
  }
  return result;
}

// TODO: Normalize plugin names
async function getPlugins(plugins: any): Promise<PluginItem[]> {
  const result: PluginItem[] = [];
  if (!Array.isArray(plugins)) {
    return result;
  }
  for (const plugin of plugins) {
    const pluginName = getNameFromConfigEntry(plugin);
    if (pluginName !== null) {
      if (!babel.availablePlugins[pluginName]) {
        babel.availablePlugins[pluginName] = await loadPlugin(pluginName);
      }

      const foundIndex = result.findIndex((v) => getNameFromConfigEntry(v) === pluginName);
      if (foundIndex > -1) {
        result[foundIndex] = plugin;
        continue;
      }
    }
    result.push(plugin);
  }
  return result;
}

async function transform({ code, filepath, subgraphId, config }: ITransformData): Promise<ITranspilationResult> {
  const targets = (await getDynamicBabelTargetCached()) ?? BABEL_TARGET_DEFAULT;
  const requires: Set<string> = new Set();
  const presets = await getPresets(config?.presets ?? []);
  const plugins = await getPlugins(config?.plugins ?? []);

  // TODO(graphs): check for "use client" / "use server" here, and notify the bundler that this is a subgraph fork
  // so that it can process the module in the other subgraph too?
  plugins.push(collectDependencies(requires));
  const transformed = babel.transform(code, {
    filename: filepath,
    presets,
    plugins,
    // no ast needed for now
    ast: false,
    sourceMaps: 'inline',
    compact: /node_modules/.test(filepath),
    targets,
  });

  // no-op module
  if (!transformed.code) {
    transformed.code = 'module.exports = {};';
  }

  return {
    code: transformed.code,
    dependencies: requires,
  };
}

const BABEL_TARGET_DEFAULT = '> 2.5%, not ie 11, not dead, not op_mini all';

const getDefaultBabelConfig = once(async () => {
  const presets = await getPresets([]).catch((err) => {
    logger.error('Unable to get default presets, defaulting to empty', err);
    return [];
  });
  const plugins = await getPlugins([]).catch((err) => {
    logger.error('Unable to get default plugins, defaulting to empty', err);
    return [];
  });
  return { presets, plugins };
});

const getDynamicBabelTargetCached = once(async () => {
  // TODO: we could probably try caching this in the main window's LocalStorage
  // (can't access that in a Worker though, so it's not straightforward)
  const startTime = performance.now();
  const config = await getDefaultBabelConfig();
  const result = getDynamicBabelTarget(config);
  const endTime = performance.now();
  logger.debug(`Getting dynamic babel target took ${endTime - startTime}ms`);
  return result;
});

new WorkerMessageBus({
  channel: 'sandpack-babel',
  endpoint: self,
  handleNotification: () => Promise.resolve(),
  handleRequest: (method, data) => {
    switch (method) {
      case 'transform':
        return transform(data);
      default:
        return Promise.reject(new Error('Unknown method'));
    }
  },
  handleError: (err) => {
    logger.error(err);
    return Promise.resolve();
  },
  timeoutMs: 30000,
});
