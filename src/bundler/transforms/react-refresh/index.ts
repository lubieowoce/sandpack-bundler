import * as logger from '../../../utils/logger';
import { Bundler } from '../../bundler';
import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';

const HELPER_PATH = '/node_modules/__csb_bust/refresh-helper.js';

const HELPER_CODE = `
const Refresh = require('react-refresh/runtime');

const isDebug = false;
const debug = isDebug ? console.debug.bind(console) : undefined;

function debounce(func, wait, immediate) {
	var timeout;
	return function() {
		var context = this, args = arguments;
		var later = function() {
			timeout = null;
			if (!immediate) func.apply(context, args);
		};
		var callNow = immediate && !timeout;
		clearTimeout(timeout);
		timeout = setTimeout(later, wait);
		if (callNow) func.apply(context, args);
	};
};

const enqueueUpdate = debounce(() => {
  try {
    Refresh.performReactRefresh();
  } catch (e) {
    module.hot.decline();
    throw e;
  }
}, 30);


const CLIENT_REFERENCE_TYPE = Symbol.for('react.client.reference');

function isClientReference(value) {
  return (typeof value === 'function') && value.$$typeof === CLIENT_REFERENCE_TYPE;
}

function isLikelyComponentType(exportValue) {
  if (isClientReference(exportValue)) return true;
  return Refresh.isLikelyComponentType(exportValue);
}

// client references don't play well with 'Refresh.isLikelyComponentType' and 'canPreserveStateBetween',
// so replace them with wrappers that are a bit more lenient
const clientReferenceProxyFns = new Map();
function getSafeRegisterValue(value) {
  if (!isClientReference(value)) {
    return value
  };
  const key = value.$$id;
  let existing = clientReferenceProxyFns.get(key);
  const [, name = ''] = key.split('#', 2);
  if (!existing) {
    // 'Refresh.isLikelyComponentType' checks the prototype to see if it's a class,
    // which makes the proxy throw. wrap it in another proxy that handles this.
    const blankPrototype = {};
    existing = new Proxy(value, {
      get(target, key) {
        if (key === 'prototype') { return blankPrototype };
        return target[key]
      }
    });
    clientReferenceProxyFns.set(key, existing);
    // debug?.('csb-react-refresh-runtime :: created safe wrapper for client reference', key, existing)
  }
  return existing;
}

function renameFunction(fn, name) {
  return { [name]: (...args) => fn(...args) }[name]
}

function isReactRefreshBoundary(moduleExports) {
  if (Object.keys(Refresh).length === 0) {
    return false;
  }

  if (isLikelyComponentType(moduleExports)) {
    return true;
  }
  if (moduleExports == null || typeof moduleExports !== 'object') {
    // Exit if we can't iterate over exports.
    return false;
  }
  let hasExports = false;
  let areAllExportsComponents = true;
  for (const key in moduleExports) {
    hasExports = true;
    if (key === '__esModule') {
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(moduleExports, key);
    if (desc && desc.get) {
      // Don't invoke getters as they may have side effects.
      return false;
    }
    const exportValue = moduleExports[key];
    if (!isLikelyComponentType(exportValue)) {
      areAllExportsComponents = false;
    }
  }
  return hasExports && areAllExportsComponents;
};

// When this signature changes, it's unsafe to stop at this refresh boundary.
function getRefreshBoundarySignature(moduleExports) {
  const signature = [];
  signature.push(Refresh.getFamilyByType(moduleExports));
  if (moduleExports == null || typeof moduleExports !== 'object') {
    // Exit if we can't iterate over exports.
    // (This is important for legacy environments.)
    return signature;
  }
  for (const key in moduleExports) {
    if (key === '__esModule') {
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(moduleExports, key);
    if (desc && desc.get) {
      continue;
    }
    const exportValue = moduleExports[key];
    signature.push(key);
    signature.push(Refresh.getFamilyByType(getSafeRegisterValue(exportValue)));
  }
  return signature;
};

function shouldInvalidateReactRefreshBoundary(
  prevExports,
  nextExports,
) {
  const prevSignature = getRefreshBoundarySignature(prevExports);
  const nextSignature = getRefreshBoundarySignature(nextExports);
  if (prevSignature.length !== nextSignature.length) {
    return true;
  }
  for (let i = 0; i < nextSignature.length; i++) {
    if (prevSignature[i] !== nextSignature[i]) {
      return true;
    }
  }
  return false;
};

var registerExportsForReactRefresh = (moduleExports, moduleID) => {
  Refresh.register(getSafeRegisterValue(moduleExports), moduleID + ' %exports%');
  if (moduleExports == null || typeof moduleExports !== 'object') {
    // Exit if we can't iterate over exports.
    // (This is important for legacy environments.)
    return;
  }
  for (const key in moduleExports) {
    const desc = Object.getOwnPropertyDescriptor(moduleExports, key);
    if (desc && desc.get) {
      // Don't invoke getters as they may have side effects.
      continue;
    }
    const exportValue = moduleExports[key];
    const typeID = moduleID + ' %exports% ' + key;
    Refresh.register(getSafeRegisterValue(exportValue), typeID);
  }
};

const refreshableServerComponentsImpls = new Map();

function addRefreshableServerExport(module, type, { localId, globalId }) {
  if (module.subgraphId !== 'server') return;
  if (!module.refreshableExports) {
    module.refreshableExports = new Map();
  }
  module.refreshableExports.set(type, { localId, globalId });
}


function replaceServerExportsWithRefreshableWrappers(module) {
  if (!module.refreshableExports) return;
  if (typeof module.exports !== 'object') return; // TODO: 'module.exports = () => ...'
  for (const exportName in module.exports) {
    const exportValue = module.exports[exportName]; // TODO: getters

    const maybeRefreshableInfo = module.refreshableExports.get(exportValue);
    if (maybeRefreshableInfo) {
      const {globalId, localId} = maybeRefreshableInfo;
      const latestImpl = exportValue;
      const previousImpl = refreshableServerComponentsImpls.get(globalId);
      let newExportValue;
      if (isClientReference(latestImpl)) {
        // we cannot wrap client references in any useful way, so just reuse the previous one instead.
        if (!previousImpl) {
          const wrapped = getSafeRegisterValue(latestImpl);
          refreshableServerComponentsImpls.set(globalId, wrapped);
          newExportValue = wrapped;
        } else {
          newExportValue = previousImpl;
        }
      } else {
        // TODO(graphs): probably remove this, it's just for debugging
        if (!previousImpl) {
          latestImpl.$$generation = 0;
        } else {
          latestImpl.$$generation = previousImpl.$$generation + 1;
        }
        refreshableServerComponentsImpls.set(globalId, latestImpl);
        newExportValue = renameFunction(
          function (...args) {
            const latestImpl = refreshableServerComponentsImpls.get(globalId);
            if (new.target) {
              return new latestImpl(...args);
            }
            return latestImpl.call(this, ...args);
          },
          localId + 'Refreshable' // isLikelyComponentType checks the name, it's important that it looks right
        );
      }
      if (newExportValue !== exportValue) {
        module.exports[exportName] = newExportValue;
      }
    }
  }
  debug?.('csb-react-refresh-runtime :: patched exports', module.id, module.exports);
}


function prelude(module) {
  window.$RefreshReg$ = (type, id) => {
    
    // Note module.id is webpack-specific, this may vary in other bundlers
    const fullId = module.id + ' ' + id;
    if (module.subgraphId === 'server') {
      addRefreshableServerExport(module, type, { localId: id, globalId: fullId });
    }

    Refresh.register(getSafeRegisterValue(type), fullId);
  }
  
  window.$RefreshSig$ = Refresh.createSignatureFunctionForTransform;
}

function postlude(module) {
  if (module.subgraphId === 'server') {
    replaceServerExportsWithRefreshableWrappers(module);
  }

  const isHotUpdate = !!module.hot.data;
  const prevExports = isHotUpdate ? module.hot.data.prevExports : null;
  if (isReactRefreshBoundary) {
    debug?.('csb-react-refresh-runtime :: in postlude');
    if (isReactRefreshBoundary(module.exports)) {
      debug?.('csb-react-refresh-runtime :: registering exports (is boundary)', module.exports)
      registerExportsForReactRefresh(module.exports, module.id);
      const currentExports = { ...module.exports };

      module.hot.dispose(function hotDisposeCallback(data) {
        data.prevExports = currentExports;
      });

      if (isHotUpdate && shouldInvalidateReactRefreshBoundary(prevExports, currentExports)) {
        debug?.('csb-react-refresh-runtime :: invalidate (is boundary)', module.id)
        module.hot.invalidate();
      } else {
        debug?.('csb-react-refresh-runtime :: accept (is boundary)', module.id)
        module.hot.accept();
      }

      enqueueUpdate();
    } else if (isHotUpdate && isReactRefreshBoundary(prevExports)) {
      debug?.('csb-react-refresh-runtime :: invalidate (was boundary)', module.id)
      module.hot.invalidate();
    } else {
      debug?.('csb-react-refresh-runtime :: not a boundary', {
        isBoundary: isReactRefreshBoundary(prevExports),
        wasBoundary: isReactRefreshBoundary(prevExports),
      });
    }
  }
}

module.exports = {
  enqueueUpdate,
  isReactRefreshBoundary,
  registerExportsForReactRefresh,
  shouldInvalidateReactRefreshBoundary,
  prelude,
  postlude,
};
`.trim();

const prelude = `var _csbRefreshUtils = require("${HELPER_PATH}");
var prevRefreshReg = window.$RefreshReg$;
var prevRefreshSig = window.$RefreshSig$;
_csbRefreshUtils.prelude(module);
try {`.replace(/[\n]+/gm, '');

const postlude = `_csbRefreshUtils.postlude(module);
} finally {
  window.$RefreshReg$ = prevRefreshReg;
  window.$RefreshSig$ = prevRefreshSig;
}`.replace(/[\n]+/gm, '');

const REACT_REFRESH_RUNTIME = `
if (typeof window !== 'undefined') {
  const runtime = require('react-refresh/runtime');
  runtime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => type => type;
}
`;

/**
 * This is the compressed version of the code in the comment above. We compress the code
 * to a single line so we don't mess with the source mapping when showing errors.
 */
const getWrapperCode = (sourceCode: string) => prelude + sourceCode + '\n' + postlude;

export class ReactRefreshTransformer extends Transformer {
  constructor() {
    super('react-refresh-transformer');
  }

  async init(bundler: Bundler): Promise<void> {
    bundler.registerRuntime(this.id, REACT_REFRESH_RUNTIME);
  }

  async transform(ctx: ITranspilationContext, config: any): Promise<ITranspilationResult> {
    // Write helper to memory-fs
    if (!ctx.module.bundler.fs.isFileSync(HELPER_PATH)) {
      ctx.module.bundler.fs.writeFile(HELPER_PATH, HELPER_CODE);
      ctx.module.bundler.sharedModules.add(HELPER_PATH);
    }

    const newCode = getWrapperCode(ctx.code);
    return {
      code: newCode || '',
      dependencies: new Set([HELPER_PATH]),
    };
  }
}
