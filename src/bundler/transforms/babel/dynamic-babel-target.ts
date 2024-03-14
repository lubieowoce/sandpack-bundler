import type { TransformOptions } from '@babel/core';
import * as babel from '@babel/standalone';
import semver from 'semver';
import { IResult as ParsedUA, UAParser } from 'ua-parser-js';

import * as logger from '../../../utils/logger';

export function getDynamicBabelTarget(
  config: TransformOptions,
  userAgent?: string
): NonNullable<TransformOptions['targets']> | null {
  try {
    userAgent ??= navigator.userAgent;
    const parsed = UAParser(userAgent);

    logger.debug('getDynamicBabelTarget', config, userAgent, parsed);
    if (!parsed.browser.name || !parsed.browser.version) {
      return null;
    }
    const parsedVersion = parsed.browser.version;

    const browserId = getBrowserslistBrowserId(parsed);
    if (!browserId) {
      logger.error('Unsupported browser and OS combination', { browser: parsed.browser.name, os: parsed.os.name });
      return null;
    }
    const exactTarget = `${browserId} ${parsedVersion}`;

    {
      const target = exactTarget;

      const usedTargets = tryCompileWithTarget(target, config);
      if (usedTargets !== null) {
        logger.debug('Created dynamic browserslist target: ' + JSON.stringify(usedTargets));
        return usedTargets;
      }
    }

    {
      // check if this is a newer browser than babel's browserlist supports
      // we don't have access to their bundled browserlist, so we need to hack it a bit
      const target = `last 1 ${browserId} major versions`;
      const usedTargets = tryCompileWithTarget(target, config);
      if (usedTargets !== null) {
        const browserVersion = semver.coerce(parsedVersion);
        const usedVersion = semver.coerce(Object.values(usedTargets)[0] ?? null);
        if (usedVersion && browserVersion && semver.gt(browserVersion, usedVersion)) {
          logger.debug(
            'Created dynamic browserslist target (browser version newer than supported) ' + JSON.stringify(usedTargets)
          );
          return usedTargets;
        }
      }
    }

    logger.error(`Unable to create dynamic browserslist target for user agent ${JSON.stringify(userAgent)}`);
    return null;
  } catch (error) {
    logger.error(`Unable to create dynamic browserslist target`, error);
    return null;
  }
}

function tryCompileWithTarget(target: string, config: TransformOptions) {
  try {
    const result = compileWithTarget(target, config);
    const processedTargets = getUsedTargetsFromBabelResult(result);
    if (processedTargets && Object.keys(processedTargets).length > 0) {
      return processedTargets;
    }
    return null;
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === 'BrowserslistError' &&
      'browserslist' in err &&
      err.browserslist === true
    ) {
      // babel's browserslist didn't understand this target.
      return null;
    }
  }
  return null;
}

/** NOTE: '@babel/plugin-standalone' bundles its own browserslist.
 * So if we want to check what it supports, the only way is to run a test compilation.
 */
function compileWithTarget(target: string, config: TransformOptions) {
  try {
    const transformResult = babel.transform(
      'export default undefined',
      // 'export default async function test() { const {x, y} = {}; return {...x, ...y}; };',
      {
        ...config,
        filename: '/dummy.js',
        sourceType: 'module',
        ast: false,
        compact: true,
        targets: target,
      }
    );
    // logger.debug(
    //   `dynamic target "${target}" :: result`,
    //   getUsedTargetsFromBabelResult(transformResult),
    //   '\n' + transformResult.code,
    //   '\n',
    //   transformResult
    // );
    return transformResult;
  } catch (err) {
    logger.error(`dynamic target "${target}" :: error`, err);
    throw err;
  }
}

/** The babel compilation result includes `options.targets`,
 * which are a parsed version of the browserlist we passed in.
 * */
const getUsedTargetsFromBabelResult = (result: ReturnType<(typeof babel)['transform']>) => {
  // not exposed on the type definitions: the parsed targets used for compilation
  const _result = result as typeof result & { options?: { targets?: Record<string, string | number> } };
  if (!_result.options) {
    logger.warn('Warning: "options" not present in babel transform result. Dynamic target generation may misbehave');
  }
  return _result.options?.targets;
};

export const getBrowserslistBrowserId = (ua: ParsedUA) => {
  const name = ua.browser.name;
  if (!name) {
    return null;
  }
  const mapper = userAgentToBrowserId[name as keyof typeof userAgentToBrowserId];
  if (!mapper) {
    return null;
  }
  if (typeof mapper === 'string') {
    return mapper;
  }
  return mapper(ua);
};

/* Map a userAgent browser name
 * To a caniuse-lite agent id (used for browserslist queries)
 * The values should match `Object.keys(require('caniuse-lite').agents)`
 */
const userAgentToBrowserId = {
  Android: 'android',
  'Android Browser': 'android',
  Baidu: 'baidu',
  'BlackBerry WebKit': 'bb',
  Chrome: (ua: ParsedUA) => {
    // TODO: Chrome iOS.
    // user agent strings with "CriOS" (Chrome iOS) get mapped into chrome, but is that correct?
    // also, caniuse doesn't seem to even have data for chrome iOS...
    // just to be safe, we fall back to defaults
    if (ua.os.name === 'iOS') return null;
    return 'chrome';
  },
  'Chrome Mobile': 'and_chr',
  Edge: 'edge',
  Firefox: (ua: ParsedUA) => {
    // TODO: Firefox iOS.
    // caniuse doesn't seem to even have data for Firefox iOS...
    // just to be safe, we fall back to defaults
    if (ua.os.name === 'iOS') return null;
    if (ua.os.name === 'Android') return 'and_ff';
    return 'firefox';
  },
  IE: 'ie',
  'IE Mobile': 'ie_mob',
  KaiOS: 'kaios',
  'Mobile Safari': 'ios_saf',
  Opera: 'opera',
  'Opera Mini': 'op_mini',
  'Opera Mobile': 'op_mob',
  QQBrowser: (ua: ParsedUA) => (ua.os.name === 'Android' ? 'and_qq' : null),
  Safari: 'safari',
  'Samsung Internet': 'samsung',
  'UC Browser': (ua: ParsedUA) => (ua.os.name === 'Android' ? 'and_uc' : null),
};
