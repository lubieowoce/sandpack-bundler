import type { NodePath, PluginObj, Visitor } from '@babel/core';
import type { BabelAPI } from '@babel/helper-plugin-utils';
import type * as t from '@babel/types';

import template from './babel-packages/template';
import { getModuleIdUrl } from './utils';

type ReferenceInfo = { localName?: string; exportedName: string };

type ThisExtras = {
  clientExportNames: ReferenceInfo[];
  onClientExport({ localName, exportedName }: ReferenceInfo): void;
};

export type PluginOptions = {};

const unsupportedSyntax = (path: NodePath<unknown>) => path.buildCodeFrameError('This syntax is not supported');

const plugin = (api: BabelAPI, _dirname: string): PluginObj<{}> => {
  api.assertVersion('^7');
  const { types: t } = api;

  const getIdentifiersFromDeclaration = (path: NodePath<t.Declaration>): t.Identifier[] => {
    if (path.isVariableDeclaration()) {
      return path.get('declarations').map((d) => {
        // TODO: insert `typeof <identifier> === 'function'` check -- it's a variable, so it could be anything
        const idNode = d.node.id;
        if (!t.isIdentifier(idNode)) {
          // TODO
          throw unsupportedSyntax(path);
        }
        return idNode;
      });
    } else if (path.isFunctionDeclaration()) {
      const idNode = path.get('id').node;
      return idNode ? [idNode] : [];
    } else if (path.isClassDeclaration()) {
      const idNode = path.get('id').node;
      return idNode ? [idNode] : [];
    } else {
      throw unsupportedSyntax(path);
    }
  };

  const self: ThisExtras = {
    clientExportNames: [],
    onClientExport(info) {
      this.clientExportNames.push(info);
    },
  };

  const visitor: Visitor = {
    ExportDefaultDeclaration(path) {
      const declarationPath = path.get('declaration');
      let localName: string | undefined;
      if (declarationPath.isExpression()) {
        if (declarationPath.isIdentifier()) {
          localName = declarationPath.node.name;
        } else {
          localName = undefined;
        }
      } else if (declarationPath.isDeclaration()) {
        localName = getIdentifiersFromDeclaration(declarationPath)[0].name;
      }
      self.onClientExport({ exportedName: 'default', localName });
    },

    ExportNamedDeclaration(path) {
      if (path.node.specifiers.length > 0) {
        for (const specifier of path.node.specifiers) {
          if (t.isExportNamespaceSpecifier(specifier)) {
            // `export * as ns from './foo';`
            throw path.buildCodeFrameError('Not implemented: Namespace exports');
          } else if (t.isExportDefaultSpecifier(specifier)) {
            // export default <expr>;
            const declarationPath = path.get('declaration');
            const localName = declarationPath.isDeclaration()
              ? getIdentifiersFromDeclaration(declarationPath)[0]?.name
              : undefined;
            self.onClientExport({ exportedName: 'default', localName: localName });
          } else if (t.isExportSpecifier(specifier)) {
            // `export { foo };`
            // `export { foo as [bar|default] };`
            const localName = specifier.local.name;
            const exportedName = t.isIdentifier(specifier.exported)
              ? specifier.exported.name
              : specifier.exported.value;

            self.onClientExport({ localName, exportedName });
          } else {
            throw unsupportedSyntax(path);
          }
        }
        return;
      }

      if (!path.node.declaration) {
        throw path.buildCodeFrameError(`Internal error: Unexpected 'ExportNamedDeclaration' without declarations `);
      }

      const identifiers: t.Identifier[] = (() => {
        const innerPath = path.get('declaration');
        if (!innerPath || !innerPath.isDeclaration()) return [];
        return getIdentifiersFromDeclaration(innerPath);
      })();

      // path.insertAfter(identifiers.map((identifier) => createRegisterCall(identifier)));
      for (const identifier of identifiers) {
        self.onClientExport({
          localName: identifier.name,
          exportedName: identifier.name,
        });
      }
    },
  };

  return {
    name: 'react-server-use-client',
    pre(file) {
      if (!file.code.includes('use client')) {
        file.path.skip();
        return;
      }

      if (!file.path.node.directives.some((d) => d.value.value === 'use client')) {
        file.path.skip();
        return;
      }

      file.path.traverse(visitor);

      const stringLiteral = (value: string) => JSON.stringify(value);
      const getProxyExpr = (exportName: string) => {
        const name = stringLiteral(exportName);
        return `(/*@__PURE__*/ $$wrapForRefresh($$proxy[${name}], ${name}))`;
      };

      const generatedCode = [
        `import { createClientModuleProxy } from 'react-server-dom-webpack/server'`,
        `const $$wrapForRefresh = (value, name) => {`,
        `  if (typeof window.$RefreshReg$ !== 'undefined') {`,
        `    window.$RefreshReg$(value, name);`,
        `  }`,
        `  return value`,
        `};`,
        `const $$proxy = createClientModuleProxy("${getModuleIdUrl(file)}");`,
      ];
      const exportedNames = new Set(self.clientExportNames.map((info) => info.exportedName));
      for (const exportedName of exportedNames) {
        const expr = getProxyExpr(exportedName);
        if (exportedName === 'default') {
          generatedCode.push(`export default ${expr};`);
        } else {
          generatedCode.push(`export const ${exportedName} = ${expr};`);
        }
      }
      const code = generatedCode.join('\n');

      const ast = template(code)({}) as t.Statement[];

      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.log('react-server-use-client ::', generatedCode);
      }

      const [newPath] = file.path.replaceWith(
        t.program(ast as Parameters<(typeof t)['program']>[0], undefined, 'module')
      );

      newPath.node.extra ??= {};
      newPath.node.extra['sandpack-bundler.is-module-fork'] = true;
    },

    // we do everything in pre, so that other plugins already see the proxy-fied code.
    visitor: {},
  };
};

export default plugin;
