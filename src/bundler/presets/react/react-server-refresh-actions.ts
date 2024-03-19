import type { PluginObj } from '@babel/core';
import type { BabelAPI } from '@babel/helper-plugin-utils';

export default function reactServerRefreshActions(api: BabelAPI): PluginObj<{}> {
  const { types: t } = api;
  return {
    name: 'react-server-refresh-actions',
    visitor: {},
    post(file) {
      const extractedActions = file.path.node.extra?.['babel-rsc/actions'] as { names: string[] };
      if (extractedActions) {
        // eslint-disable-next-line no-console
        console.debug('react-server-refresh-actions :: Got extracted actions', extractedActions);
        file.path.pushContainer(
          'body',
          extractedActions.names
            .map((name) => {
              const nameForRefresh = 'RefreshableAction' + name;
              if (!file.path.scope.getBinding(name)) {
                // TODO: this only works if the local name is the same as the exported name,
                // but at least this way we won't crash
                return;
              }
              return t.expressionStatement(
                t.callExpression(t.identifier('$RefreshReg$'), [t.identifier(name), t.stringLiteral(nameForRefresh)])
              );
            })
            .filter(Boolean)
            .map((el) => el!)
        );
      }
    },
  };
}
