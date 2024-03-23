import * as logger from '../../utils/logger';
import { SUBGRAPHS, SubgraphId, getSubgraphFileUrl, toSubGraphPath } from '../subgraphs';
import evaluate from './eval';
import { HotContext } from './hot';
import { Module } from './Module';

class EvaluationContext {
  exports: any;
  globals: any;
  hot: HotContext;
  id: string;
  subgraphId?: SubgraphId;

  constructor(evaluation: Evaluation) {
    this.exports = {};
    this.globals = {};
    this.hot = evaluation.module.hot;
    this.id = evaluation.module.id;
    this.subgraphId = evaluation.module.subgraphId;
  }
}

const EvaluationStatus = {
  NotEvaluated: 0 as const,
  Started: 1 as const,
  Finished: 2 as const,
  Failed: 3 as const,
};

type EvaluationStatus = (typeof EvaluationStatus)[keyof typeof EvaluationStatus];

export class Evaluation {
  module: Module;
  context: EvaluationContext;
  status: EvaluationStatus;
  error?: unknown;

  constructor(module: Module) {
    this.module = module;

    this.status = EvaluationStatus.NotEvaluated;
    this.context = new EvaluationContext(this);
  }

  getExports() {
    if (this.status === EvaluationStatus.NotEvaluated) {
      if (this.module.compiled === null) {
        throw new Error(`Internal error :: module "${this.module.id}" was not compiled before evaluating`);
      }
      const sourceUrl = new URL(
        this.module.subgraphId ? getSubgraphFileUrl(this.module.id) : this.module.filepath,
        location.origin
      ).href;
      const code = this.module.compiled + `\n//# sourceURL=${sourceUrl}`;
      const customGlobals = this.module.bundler.preset?.getCustomGlobals?.(this);

      this.status = EvaluationStatus.Started;
      logger.debug(`%cEvaluation.getExports() :: evaluating '${this.module.id}'`, 'color: green');
      try {
        this.context.exports = evaluate(code, this.require.bind(this), this.context, {}, customGlobals) ?? {};
        this.status = EvaluationStatus.Finished;
      } catch (err) {
        this.error = err;
        this.status = EvaluationStatus.Failed;
      }
    }
    if (this.status === EvaluationStatus.Failed) {
      throw this.error!;
    }
    if (this.status === EvaluationStatus.Started) {
      logger.warn(
        `%cEvaluation.getExports() :: module required again before it finished evaluating '${this.module.id}'`,
        'color: orange'
      );
    }
    return this.context.exports;
  }

  require(specifier: string): any {
    try {
      logger.groupCollapsed(`Evaluation :: require(${JSON.stringify(specifier)})`, { importer: this.module.id });
      const moduleId = this.module.dependencyMap.get(specifier);
      if (!moduleId) {
        // statically analyzable modules would have been resolved
        // and added to dependencyMap earlier, in Module#compile().
        // so if that didn't happen, and we got to this point,
        // then this is almost certainly a dynamic import() that wasn't statically analyzable.
        // it's normally not expected for `require()` to return a promise,
        // but babel wraps `import()`s transformed into `require()`s in a Promise.resolve(),
        // and `import()` has to be in a context where promises are expected anyway, so this should be... fine?
        // (this'd break dynamic `require()`, but we probably don't need to care)
        const promise = (async () => {
          await prepareDynamicImport(this.module, specifier);
          return this.require(specifier);
        })();

        // returning a promise has a bad interaction with `interopRequire`, because it dexpects an exports object.
        // so we cheat a bit to make it not wrap this value in `{ default: ... }`
        (promise as any)['__esModule'] = true;

        return promise;

        // logger.debug('Require', {
        //   dependencies: this.module.dependencyMap,
        //   specifier,
        // });

        // throw new Error(`Dependency "${specifier}" not collected from "${this.module.filepath}"`);
      }
      const module = this.module.bundler.getModule(moduleId);
      if (!module) {
        throw new Error(`Module "${moduleId}" has not been transpiled`);
      }
      return module.evaluate().getExports() ?? {};
    } finally {
      logger.groupEnd();
    }
  }
}

async function prepareDynamicImport(importer: Module, specifier: string) {
  await importer.addDependency(specifier);
  const moduleId = importer.dependencyMap.get(specifier)!;
  await importer.bundler.transformModule(moduleId);
  logger.debug(
    `prepareDynamicImport(importer=${importer.id}, specifier=${specifier})`,
    importer.bundler.getModule(moduleId)
  );
  await importer.bundler.moduleFinishedPromise(moduleId);
}
