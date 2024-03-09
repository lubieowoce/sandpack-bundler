import { BundlerError } from '../../errors/BundlerError';
import { debug } from '../../utils/logger';
import { Bundler } from '../bundler';
import { Evaluation } from './Evaluation';
import { HotContext } from './hot';

export interface IDependencyEvent {
  specifier: string;
}

export class Module {
  id: string;
  filepath: string;
  isEntry = false;
  source: string;
  compiled: string | null;
  bundler: Bundler;
  evaluation: Evaluation | null = null;
  hot: HotContext;

  compilationError: BundlerError | null = null;

  dependencies: Set<string>;
  // Keeping this seperate from dependencies as there might be duplicates otherwise
  dependencyMap: Map<string, string>;

  constructor(filepath: string, source: string, isCompiled: boolean = false, bundler: Bundler) {
    this.id = filepath;
    this.filepath = filepath;
    this.source = source;
    this.compiled = isCompiled ? source : null;
    this.dependencies = new Set();
    this.dependencyMap = new Map();
    this.bundler = bundler;
    this.hot = new HotContext(this);
    this.evaluation = null;
  }

  get initiators() {
    return this.bundler.getInitiators(this.id);
  }

  isHot(): boolean {
    return Boolean(this.hot.hmrConfig?.isHot());
  }

  /** Add dependency */
  async addDependency(depSpecifier: string): Promise<void> {
    const resolved = await this.bundler.resolveAsync(depSpecifier, this.filepath);
    this.dependencies.add(resolved);
    this.dependencyMap.set(depSpecifier, resolved);
    this.bundler.addInitiator(resolved, this.id);
  }

  async compile(): Promise<void> {
    if (this.compiled != null || this.compilationError != null) {
      return;
    }
    try {
      const preset = this.bundler.preset;
      if (!preset) {
        throw new Error('Preset has not been initialized');
      }

      const transformers = preset.getTransformers(this);
      if (!transformers.length) {
        throw new Error(`No transformers found for ${this.filepath}`);
      }

      let code = this.source;
      for (const [transformer, config] of transformers) {
        const transformationResult = await transformer.transform(
          {
            module: this,
            code,
          },
          config
        );

        if (transformationResult instanceof BundlerError) {
          this.compilationError = transformationResult;
        } else {
          code = transformationResult.code;
          await Promise.all(
            Array.from(transformationResult.dependencies).map((d) => {
              return this.addDependency(d);
            })
          );
        }
      }

      this.compiled = code;
    } catch (err: any) {
      this.compilationError = err;
    }
  }

  resetCompilation(): void {
    // We always reset compilation errors as this will be non-null while compilation is null
    this.compilationError = null;

    // Skip modules that don't have any compilation
    if (this.compiled == null) return;

    this.compiled = null;
    this.evaluation = null;

    if (this.hot.hmrConfig && this.hot.hmrConfig.isHot()) {
      this.hot.hmrConfig.setDirty(true);
    } else {
      // for (let initiator of this.initiators) {
      //   const module = this.bundler.getModule(initiator);
      //   module?.resetCompilation();
      // }

      // // If this is an entry we want all direct entries to be reset as well.
      // // Entries generally have side effects
      // if (this.isEntry) {
      //   for (let dependency of this.dependencies) {
      //     const module = this.bundler.getModule(dependency);
      //     module?.resetCompilation();
      //   }
      // }

      location.reload();
    }

    this.bundler.transformModule(this.filepath);
  }

  evaluate(): Evaluation {
    if (this.evaluation) {
      debug(`Module.evaluate() :: already evaluat${[0, 1].includes(this.evaluation.status) ? 'ing' : 'ed'}`, this.id);
      return this.evaluation;
    }
    debug('%cModule.evaluate() :: starting new evaluation', 'color: tomato', this.id);

    if (this.hot.hmrConfig) {
      // this.bundler.setHmrStatus('dispose');
      // Call module.hot.dispose handler
      // https://webpack.js.org/api/hot-module-replacement/#dispose-or-adddisposehandler-
      this.hot.hmrConfig.callDisposeHandler();
      // this.bundler.setHmrStatus('apply');
    }

    // Reset hmr context while keeping the previous hot data
    this.hot = this.hot.clone();
    this.evaluation = new Evaluation(this);
    // NOTE: ensure that this is assigned to `this.evaluation` before running,
    // otherwise circular imports triggered by `.run()` won't see it, and will try to evaluate again
    this.evaluation.getExports();

    // this.bundler.setHmrStatus('apply');
    if (this.hot.hmrConfig && this.hot.hmrConfig.isHot()) {
      this.hot.hmrConfig.setDirty(false);
      this.hot.hmrConfig.callAcceptCallback();
    }
    // this.bundler.setHmrStatus('idle');

    return this.evaluation;
  }
}
