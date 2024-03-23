import * as logger from '../../utils/logger';
import { Bundler } from '../bundler';
import { DepMap } from '../module-registry';
import type { Evaluation } from '../module/Evaluation';
import type { Module } from '../module/Module';
import type { Transformer } from '../transforms/Transformer';

export class Preset {
  private transformers = new Map<string, Transformer>();
  private bundler: Bundler | null = null;

  defaultEntryPoints: string[] = ['index', 'src/index'];
  defaultHtmlBody: string = '';

  constructor(public name: string) {}

  async registerTransformer(transformer: Transformer): Promise<void> {
    if (!this.bundler) {
      throw new Error('Call Preset#init before registering transformers');
    }

    await transformer.init(this.bundler);
    this.transformers.set(transformer.id, transformer);
  }

  getTransformer(id: string): Transformer | undefined {
    return this.transformers.get(id);
  }

  async init(bundler: Bundler): Promise<void> {
    logger.debug('Initializing preset', this.name);
    this.bundler = bundler;
  }

  mapTransformers(module: Module): Array<[string, any]> {
    throw new Error('Not implemented');
  }

  getCustomGlobals(evaluation: Evaluation): Record<string, any> | undefined {
    return undefined;
  }

  getTransformers(module: Module): Array<[Transformer, any]> {
    const transformersMap = this.mapTransformers(module);
    return transformersMap.map((val) => {
      const transformer = this.getTransformer(val[0]);
      if (!transformer) {
        throw new Error(`Transformer ${val[0]} not found`);
      }
      return [transformer, val[1]];
    });
  }

  augmentDependencies(dependencies: DepMap): DepMap {
    return dependencies;
  }
}
