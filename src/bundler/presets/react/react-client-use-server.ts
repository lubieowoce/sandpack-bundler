import type { NodePath, PluginObj, Visitor } from '@babel/core';
import type { BabelAPI } from '@babel/helper-plugin-utils';
// TODO(actions): something weird going on with the "exports" here...
import { createPlugin as createBasePlugin } from '@owoce/babel-rsc/dist/plugin-use-server.js';

import template from '../../transforms/babel/babel-packages/template';
import traverse from '../../transforms/babel/babel-packages/traverse';
import { getModuleIdUrl } from './utils';

export type PluginOptions = {
  runtime?: {
    callServer?: {
      importSource: string;
      name: string;
    };
    createServerReference?: {
      importSource: string;
      name: string;
    };
  };
};

const plugin = (api: BabelAPI, opts: PluginOptions, dirname: string): PluginObj<{}> => {
  api.assertVersion('^7');
  const { types: t } = api;

  const callServer = opts?.runtime?.createServerReference;
  const createServerReference = opts?.runtime?.createServerReference ?? {
    importSource: 'react-server-dom-webpack/client',
    name: 'createServerReference',
  };

  return {
    name: 'react-client-use-server',
    pre(file) {
      if (!file.code.includes('use server')) {
        file.path.skip();
        return;
      }

      if (!file.path.node.directives.some((d) => d.value.value === 'use server')) {
        file.path.skip();
        return;
      }

      const foundActions: { localName?: string; exportedName: string }[] = [];

      {
        // TODO(actions): it's not ideal that we have to do hacks like this...
        // maybe @owoce/babel-rsc should export a way to just create a visitor?

        const basePlugin = createBasePlugin({
          getModuleId: getModuleIdUrl,
          onActionFound(arg) {
            foundActions.push(arg);
          },
        });

        const basePluginInstance = basePlugin(api, opts, dirname);
        const state = this as typeof basePluginInstance extends PluginObj<infer State> ? State : never;
        basePluginInstance.pre?.call(state, file);
        traverseFromRoot(file.path, basePluginInstance.visitor, state);
        basePluginInstance.post?.call(state, file);
      }

      if (!foundActions.length) {
        return 'export {}';
      }

      const stringLiteral = (value: string) => JSON.stringify(value);
      const moduleId = getModuleIdUrl(file);
      const callServerArg = callServer ? '$$callServer' : 'undefined';

      const getProxyExpr = (exportName: string) => {
        const id = stringLiteral(moduleId + '#' + exportName);
        return [
          `(/*@__PURE__*/ $$wrapForRefresh(`,
          `  $$createServerReference(${id}, ${callServerArg}), ${stringLiteral(exportName)})`,
          `)`,
        ].join('\n');
      };

      const generatedCode = [
        `import { ${createServerReference.name} as $$createServerReference } from '${createServerReference.importSource}';`,
        callServer ? `import { callServer as $$callServer } from '${callServer.importSource}';` : ``,
        ``,
        ``,
        `const $$wrapForRefresh = (value, name) => {`,
        `  if (typeof window.$RefreshReg$ !== 'undefined') {`,
        `    window.$RefreshReg$(value, 'RefreshableAction' + name);`,
        `    window.$Refresh$createdServerReferences.add(value);`,
        `  }`,
        `  return value`,
        `};`,
      ];

      const exportedNames = new Set(foundActions.map((info) => info.exportedName));
      for (const exportedName of exportedNames) {
        const expr = getProxyExpr(exportedName);
        if (exportedName === 'default') {
          generatedCode.push(`export default ${expr};`);
        } else {
          generatedCode.push(`export const ${exportedName} = ${expr};`);
        }
      }
      const code = generatedCode.join('\n');

      const ast = template.statements.ast(code);

      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.log('react-client-use-server ::', generatedCode);
      }

      const [newPath] = file.path.replaceWith(t.program(ast, undefined, 'module'));

      newPath.node.extra ??= {};
      newPath.node.extra['sandpack-bundler.is-module-fork'] = true;
    },

    // we do everything in pre, so that other plugins already see the proxy-fied code.
    visitor: {},
  };
};

function traverseFromRoot<TState = unknown>(path: NodePath, visitor: Visitor<TState>, state: TState) {
  // https://github.com/babel/babel/issues/9683
  return traverse(
    path.node,
    visitor,
    path.scope,
    state,
    path,
    // @ts-expect-error `babel.traverse` takes a final "visitSelf" argument that's not on the type definitions
    /* visitSelf: */ true
  );
}

export default plugin;
