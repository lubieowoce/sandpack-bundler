import { BundlerError } from '../../errors/BundlerError';
import { debug } from '../../utils/logger';
import { Bundler } from '../bundler';
import { SUBGRAPHS, SubgraphId, parseSubgraphPath, toSubGraphPath } from '../subgraphs';
import { Evaluation } from './Evaluation';
import { HotContext } from './hot';

export interface IDependencyEvent {
  specifier: string;
}

export class Module {
  id: string;
  filepath: string;
  isEntry = false;
  subgraphId?: SubgraphId;
  source: string;
  compiled: string | null;
  bundler: Bundler;
  evaluation: Evaluation | null = null;
  hot: HotContext;

  compilationError: BundlerError | null = null;

  dependencies: Set<string>;
  // Keeping this seperate from dependencies as there might be duplicates otherwise
  dependencyMap: Map<string, string>;

  constructor(
    id: string,
    filepath: string,
    source: string,
    isCompiled: boolean = false,
    bundler: Bundler,
    subgraphId: SubgraphId | undefined
  ) {
    this.id = id;
    this.filepath = filepath;
    this.source = source;
    this.subgraphId = subgraphId;
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
    const resolved = await this.bundler.resolveAsync(depSpecifier, this.filepath, { subgraphId: this.subgraphId });
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
        throw new Error(`No transformers found for ${this.id}`);
      }

      let code = this.source;
      for (const [transformer, config] of transformers) {
        // TODO(graph): somehewhere in here we need to check for "use client" / "use server"
        // TODO(graph): when we encounter a graph fork, we need to emit two modules.
        // but what do we set as the importer of the "client" module? maybe just the entrypoint?
        // in reality, that'll be the place that does the __webpack_require__...
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
          if (this.subgraphId) {
            const prevSubgraphFork = this.bundler.getSubgraphFork(this);
            let currentPrimarySubgraphId;
            if (transformationResult.isSubgraphFork) {
              // we're in this subgraph, but the module also lives in the other subgraph.
              // TODO(graphs): VERY hardcoded
              const otherGraphMap = { [SUBGRAPHS.client]: SUBGRAPHS.server, [SUBGRAPHS.server]: SUBGRAPHS.client };
              const otherSubgraphId = otherGraphMap[this.subgraphId];
              const resourcePath = this.filepath;
              const otherId = toSubGraphPath(resourcePath, otherSubgraphId);

              currentPrimarySubgraphId = otherSubgraphId;
              debug(
                `Module::compile() :: found subgraph fork from ${this.subgraphId} to ${otherSubgraphId}, issuing transformModule for`,
                otherId
              );
              this.bundler.setSubgraphFork(this, { from: this.subgraphId!, to: currentPrimarySubgraphId });
              void this.bundler.transformModule(otherId);
            } else {
              currentPrimarySubgraphId = this.subgraphId;
              debug(
                `Module::compile(${this.id}) :: not a fork, setting primary subgraph to ${currentPrimarySubgraphId}`
              );
              // this is not a subgraph for. clear any possible previous fork status this might've had.
              this.bundler.setSubgraphFork(this, undefined);
            }

            if (prevSubgraphFork !== undefined) {
              const prevPrimarySubgraphId = prevSubgraphFork.to;
              // TODO(graphs): do we need to manually invalidate here? the react-refresh extension already does that,
              // but maybe we need a generic method too? not sure, because OTOH this'd probably mess with react-refresh
              //
              // const previousModule = this.bundler.getModule(toSubGraphPath(this.filepath, prevPrimarySubgraphId));
              // if (previousModule && previousModule.isHot()) {
              //   previousModule.hot.invalidate();
              // }
              debug(
                `Module::compile() :: primary subgraph for ${this.filepath} changed from ${prevPrimarySubgraphId} to ${currentPrimarySubgraphId}`
              );
            }
          }
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
      debug(`Module::resetCompilation(): setting ${this.id} to dirty`);
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
      debug(`Module::resetCompilation(): Reloading window because module ${this.id} is not hot`);
      location.reload();
    }

    this.bundler.transformModule(this.id);
  }

  evaluate(): Evaluation {
    if (this.evaluation) {
      debug(`Module.evaluate() :: already evaluat${[0, 1].includes(this.evaluation.status) ? 'ing' : 'ed'}`, this.id);
      return this.evaluation;
    }
    debug(`%cModule.evaluate() :: starting new evaluation (hot: ${this.isHot()})`, 'color: tomato', this.id);

    if (this.hot.hmrConfig) {
      debugger;
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
    // otherwise circular imports triggered by `.getExports()` won't see it, and will try to evaluate again
    this.evaluation.getExports();

    if (!this.evaluation) {
      // this can happen if the module calls `module.hot.invalidate()` or `module.hot.decline()`.
      throw new EvaluationResetError(`Evaluation reset while evaluating ${this.id}`);
    }

    // this.bundler.setHmrStatus('apply');
    if (this.hot.hmrConfig && this.hot.hmrConfig.isHot()) {
      this.hot.hmrConfig.setDirty(false);
      this.hot.hmrConfig.callAcceptCallback();
    }
    // this.bundler.setHmrStatus('idle');

    return this.evaluation;
  }
}

export class EvaluationResetError extends Error {}
