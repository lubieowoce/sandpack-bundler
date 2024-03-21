import type { BabelFile, NodePath, PluginObj, Visitor } from '@babel/core';
import type { BabelAPI } from '@babel/helper-plugin-utils';
import type * as t from '@babel/types';

type Support = 'supported' | 'noop' | undefined;

const ENVS = ['client', 'server'] as const;
type Env = (typeof ENVS)[number];
type ApiInfo = Record<Env, Support>;

type PkgName = string;

export type PluginOptions = {
  include?: string;
  apis: Record<PkgName, { '*': ApiInfo } | Record<string, ApiInfo>>;
  syntax?: {
    asyncComponent?: ApiInfo;
  };
};

const pathRegexCache = new Map<string, RegExp>();
function includeStringToRegexp(include: string) {
  let regexp = pathRegexCache.get(include);
  if (!regexp) {
    regexp = new RegExp(include);
    pathRegexCache.set(include, regexp);
  }
  return regexp;
}

const OTHER_ENV = { client: 'server' as const, server: 'client' as const };
const getOtherEnv = (env: Env) => {
  return OTHER_ENV[env];
};

class APIUsageError extends Error {
  loc?: { line: number; column: number };
  constructor(message?: string | undefined) {
    super(message);
    this.name = 'APIUsageError';
  }
}

const createAPIUsageError = (path: NodePath<t.Node>, message: string) => {
  const error = path.buildCodeFrameError(
    message,
    // @ts-expect-error some typescript weirdness around constructors
    APIUsageError
  ) as APIUsageError;
  // sandpack's CompilationError checks this, and will highlight the line it occurred on in red
  error.loc = path.node.loc?.start;
  return error;
};

const getLimitedEnv = (info: ApiInfo): Env | null => {
  // TODO(analyzer): the API info is a bit impractical,
  // so we have to do this conversion
  // maybe we'd prefer to just have "client-only" | "server-only" | "universal"?
  const { server, client } = info;
  if (client && server === undefined) {
    return 'client';
  }
  if (server && client === undefined) {
    return 'server';
  }
  return null;
};

const HUMAN_ENV_NAME = {
  client: 'client',
  server: 'server',
};

const formatLimitedAPI = (env: Env, name: string) => {
  return `'${name}' (a ${HUMAN_ENV_NAME[env]}-only API)`;
};

type ApiUsageDescription = { description: string } | { name: string };

const formatUsageDescription = (env: Env, info: ApiUsageDescription) => {
  return 'description' in info ? info.description : formatLimitedAPI(env, info.name);
};

type IdPath = NodePath<t.Identifier>;

const getAPIInfo = (allApiInfos: PluginOptions['apis'], pkgName: PkgName, name: string): ApiInfo | undefined => {
  const pkgApiInfo = allApiInfos[pkgName];
  if (!pkgApiInfo) return undefined;
  if ('*' in pkgApiInfo) return pkgApiInfo['*'];
  return pkgApiInfo[name];
};

const getOrCreate = <TObj extends Record<string, any>>(
  record: TObj,
  key: keyof TObj,
  create: () => TObj[keyof TObj]
) => {
  if (!(key in record)) {
    record[key] = create();
  }
  return record[key];
};

function isComponentishName(name: string) {
  return typeof name === 'string' && name[0] >= 'A' && name[0] <= 'Z';
}

export default function plugin(_api: BabelAPI, opts: PluginOptions, _dirname: string): PluginObj<{}> {
  const { include, apis, syntax } = opts;
  const hasConfiguration = Object.keys(apis).length > 0 || (syntax && Object.keys(syntax).length > 0);
  const pkgNames = Object.keys(apis);

  let hasImportedAPIs = false;
  const importedReactAPIs: Partial<Record<PkgName, Set<{ path: IdPath; name: string }>>> = {};

  let hasNamespaceImport = false;
  const namespacedImportsIdentifiers: Partial<Record<PkgName, Set<IdPath>>> = {};

  const usedReactAPIs: Partial<Record<PkgName, Set<string>>> = {};

  type DirectivePlacement = 'top-level' | 'inline';
  let directiveUsage: { type: Env; placement: DirectivePlacement } | undefined;

  type EnvironmentPossibility = { possible: true } | { possible: false; reason: ApiUsageDescription };
  const possibleEnvironments = {
    unknown: null as null | { reason: ApiUsageDescription },
    client: { possible: true } as EnvironmentPossibility,
    server: { possible: true } as EnvironmentPossibility,
  };

  //========================================

  const addImportedAPI = (pkgName: PkgName, name: string, path: IdPath) => {
    hasImportedAPIs = true;
    const names = getOrCreate(importedReactAPIs, pkgName, () => new Set())!;
    return names.add({ path, name });
  };

  const addNamespacedImportIdentifier = (pkgName: PkgName, path: IdPath) => {
    hasNamespaceImport = true;
    const paths = getOrCreate(namespacedImportsIdentifiers, pkgName, () => new Set())!;
    return paths.add(path);
  };

  const addAPIUsage = (pkgName: PkgName, name: string, path: NodePath<t.Node>) => {
    const usages = getOrCreate(usedReactAPIs, pkgName, () => new Set())!;
    usages.add(name);

    const apiInfo = getAPIInfo(apis, pkgName, name);
    onUsageFound(apiInfo, { name }, path);
  };

  const addDirective = (type: Env, path: NodePath<t.DirectiveLiteral>) => {
    if (directiveUsage !== undefined && directiveUsage.type !== type) {
      throw createAPIUsageError(
        path,
        `A module cannot contain both "use ${type}" and "use ${directiveUsage.type}" directives`
      );
    }
    const placement = path.getFunctionParent() ? 'inline' : 'top-level';

    directiveUsage = { type, placement };
    switch (type) {
      case 'server':
      case 'client': {
        usesLimitedAPI(type, { description: `a "use ${type}" directive` }, path);
        break;
      }
    }
  };

  const addAsyncComponent = (name: string, path: NodePath) => {
    const apiInfo = syntax?.asyncComponent;
    if (!apiInfo) return;
    const limitedEnv = getLimitedEnv(apiInfo);
    const limitedEnvMesage = limitedEnv ? `(only allowed in ${HUMAN_ENV_NAME[limitedEnv]} modules)` : '';
    onUsageFound(
      apiInfo,
      { description: `an async component '${name}'` + (limitedEnvMesage ? ' ' + limitedEnvMesage : '') },
      path
    );
  };

  //========================================

  const onUsageFound = (apiInfo: ApiInfo | undefined, description: ApiUsageDescription, path: NodePath<t.Node>) => {
    if (!apiInfo) {
      // we don't have info about this API. not much we can do.
      possibleEnvironments['unknown'] = { reason: description };
      return;
    }

    const limitedEnv = getLimitedEnv(apiInfo);
    if (!limitedEnv) {
      // this API is not limited to client-only or server-only,
      // so it doesn't affect any of our usage checks.
      return;
    }

    if (directiveUsage !== undefined) {
      // If a directive was used, that's a strong signal that a file is supposed to be
      // client-only or server-only.
      // We can error on APIs from the other env immediately.
      const { type: directiveEnv, placement } = directiveUsage;
      if (directiveEnv !== limitedEnv) {
        const limitedEnvMessage =
          directiveEnv === 'server' && placement === 'inline'
            ? `(only allowed in ${HUMAN_ENV_NAME[directiveEnv]} modules)`
            : '';

        throw createAPIUsageError(
          path,
          `Cannot use ${formatUsageDescription(limitedEnv, description)} in a module ${
            placement === 'top-level' ? 'marked with a top-level' : 'that contains an inline'
          } "use ${directiveEnv}" directive${limitedEnvMessage ? ' ' + limitedEnvMessage : ''}`
        );
      }
    }

    usesLimitedAPI(limitedEnv, description, path);
  };

  const usesLimitedAPI = (env: Env, info: ApiUsageDescription, path: NodePath<t.Node>) => {
    const otherEnv = getOtherEnv(env);
    possibleEnvironments[otherEnv] = { possible: false, reason: info };
    const current = possibleEnvironments[env];
    if (!current.possible) {
      const currentUsage = formatUsageDescription(env, info);
      const preventingUsage = formatUsageDescription(otherEnv, current.reason);
      const message = `Cannot use ${currentUsage} in this module, because it also contains ${preventingUsage}`;
      throw createAPIUsageError(path, message);
    }
    return current;
  };

  //========================================

  const apiUsageVisitor: Visitor<{ programPath: NodePath<t.Program> }> = {
    ImportDeclaration(path) {
      const rawSource = path.node.source.value;
      if (!pkgNames.includes(rawSource)) {
        return path.skip();
      }
      const pkgName = rawSource as PkgName;
      for (const specifierPath of path.get('specifiers')) {
        if (specifierPath.isImportSpecifier()) {
          // import { useState } from "react";
          //          ^^^^^^^^
          const importedPath = specifierPath.get('imported');
          const localPath = specifierPath.get('local');
          if (importedPath.isIdentifier()) {
            addImportedAPI(pkgName, importedPath.node.name, localPath.node ? localPath : importedPath);
          }
        } else if (specifierPath.isImportDefaultSpecifier()) {
          // import React from "react";
          //        ^^^^^
          addNamespacedImportIdentifier(pkgName, specifierPath.get('local'));
        } else if (specifierPath.isImportNamespaceSpecifier()) {
          // import * as React from "react";
          //        ^^^^^^^^^^
          addNamespacedImportIdentifier(pkgName, specifierPath.get('local'));
        }
      }
    },

    DirectiveLiteral(path) {
      switch (path.node.value) {
        case 'use client': {
          return addDirective('client', path);
        }
        case 'use server': {
          return addDirective('server', path);
        }
      }
    },

    FunctionDeclaration(path) {
      // NOTE: do not path.skip() here!
      // we still need to find inline "use server" directives and other API usages
      // which can occur within components
      if (!syntax?.asyncComponent) return;
      const node = path.node;
      const id = node.id;
      if (!id) {
        // TODO(analyzer): this might be a `export default function () {}` component.
        // consider checking if it returns JSX.
        return;
      }
      const inferredName = id.name;
      if (!isComponentishName(inferredName)) {
        return;
      }

      // export function Named() {}
      // function Named() {}
      if (node.async) {
        addAsyncComponent(id?.name, path);
      }
    },

    VariableDeclaration(path) {
      if (!syntax?.asyncComponent) return;

      // we're only interested in top-level bindings, possibly with an `export` in front
      if (path.parentPath !== this.programPath && !path.findParent((p) => p.isExportDeclaration())) {
        return;
      }

      const declPaths = path.get('declarations');
      if (declPaths.length !== 1) {
        return;
      }
      const declPath = declPaths[0];
      const idPath = declPath.get('id');
      if (!idPath.isIdentifier()) {
        return;
      }
      const name = idPath.node.name;
      if (!isComponentishName(name)) {
        return;
      }
      const initPath = declPath.get('init');
      // TODO(analyzer): this doesn't handle HOCs
      if (initPath.isFunctionExpression() || initPath.isArrowFunctionExpression()) {
        if (initPath.node.async) {
          addAsyncComponent(name, path);
        }
      }
    },
  };

  //========================================

  const visitAPIUsages = () => {
    visitImportedAPIUsages();
    visitNamespacedIdentifierUsages();
  };

  const visitImportedAPIUsages = () => {
    if (!hasImportedAPIs) return;

    for (const pkgName of pkgNames) {
      const imported = importedReactAPIs[pkgName];
      if (!imported) {
        continue;
      }
      for (const { path: identifierPath, name } of imported) {
        const binding = identifierPath.scope.getBinding(identifierPath.node.name);
        if (!binding) continue; // shouldn't ever happen?
        for (const referencePath of binding.referencePaths) {
          addAPIUsage(pkgName, name, referencePath);
        }
      }
    }
  };

  const visitNamespacedIdentifierUsages = () => {
    if (!hasNamespaceImport) {
      return;
    }
    for (const pkgName of pkgNames) {
      const visitProperty = (path: NodePath<t.PrivateName | t.Expression>) => {
        let name: string | undefined;
        if (path.isIdentifier()) {
          name = path.node.name;
        } else if (path.isStringLiteral()) {
          name = path.node.value;
        }
        if (name !== undefined) {
          addAPIUsage(pkgName, name, path);
        }
      };
      const identifiers = namespacedImportsIdentifiers[pkgName];
      if (!identifiers) continue;
      for (const nsIdentifierPath of identifiers) {
        const binding = nsIdentifierPath.scope.getBinding(nsIdentifierPath.node.name);
        if (!binding) continue; // shouldn't ever happen?

        for (const referencePath of binding.referencePaths) {
          const parentPath = referencePath.parentPath;
          if (!parentPath) continue; // shouldn't ever happen?

          if (parentPath.isMemberExpression()) {
            // React.someFunction
            // React["someFunction"]
            const propertyPath = parentPath.get('property');
            visitProperty(propertyPath);
          } else if (parentPath.isVariableDeclarator()) {
            const lhsPath = parentPath.get('id');
            if (lhsPath.isObjectPattern()) {
              // const { useState } = React;
              //       ^^^^^^^^^^^^
              for (const propertyPath of lhsPath.get('properties')) {
                if (propertyPath.isObjectProperty()) {
                  const keyPath = propertyPath.get('key');
                  visitProperty(keyPath);
                }
              }
            }
          }
        }
      }
    }
  };

  const analyzeUsages = (file: BabelFile) => {
    const usages: Partial<Record<PkgName, string[]>> = {};
    for (const pkgName of pkgNames) {
      if (usedReactAPIs[pkgName]?.size) {
        usages[pkgName] = [...usedReactAPIs[pkgName]!.values()];
      }
    }
    const usableIn = (() => {
      const server = possibleEnvironments['server'];
      const client = possibleEnvironments['client'];
      const unknown = possibleEnvironments['unknown'];
      if (unknown) {
        // TODO: do something with the `reason`
        return 'unknown';
      } else if (!server.possible && !client.possible) {
        const serverReason = formatUsageDescription('server', server.reason);
        const clientReason = formatUsageDescription('client', client.reason);
        throw createAPIUsageError(
          file.path,
          `A module cannot mix server and client code. Found:\n  - ${serverReason}\n  - ${clientReason}`
        );
      } else if (server.possible && client.possible) {
        return 'universal';
      } else if (server.possible && !client.possible) {
        return 'server';
      } else if (!server.possible && client.possible) {
        return 'client';
      }
    })();
    // eslint-disable-next-line no-console
    console.debug('react-api-usage', file.opts.filename, usableIn, usages, { directiveEnv: directiveUsage });
  };

  return {
    name: 'react-api-usage',
    pre(file) {
      const sourceFile = file.opts.filename;
      if (include) {
        const pathRegex = includeStringToRegexp(include);
        if (sourceFile && !pathRegex.test(sourceFile)) {
          // eslint-disable-next-line no-console
          console.debug('react-api-usage :: skipping', sourceFile);
          return;
        }
      }
      if (!hasConfiguration) {
        // eslint-disable-next-line no-console
        console.debug('react-api-usage :: no API info or syntax configuration passed, skipping', sourceFile);
        return;
      }
      // We want to analyze the code before any other plugin transforms the code
      // in ways that might break our analysis.
      file.path.traverse(apiUsageVisitor, { programPath: file.path });
      visitAPIUsages();
      analyzeUsages(file);
    },
    visitor: {},
  };
}
