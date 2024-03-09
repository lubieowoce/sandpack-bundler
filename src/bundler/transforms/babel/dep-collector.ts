export function collectDependencies(requires: Set<string>) {
  return {
    visitor: {
      CallExpression(path: any) {
        const callee = path.get('callee');

        if (callee.isIdentifier() && callee.node.name === 'require') {
          if (!path.scope.hasBinding(callee.node.name)) {
            const arg = path.get('arguments.0');
            const evaluated = arg.evaluate();
            // console.log('collectDependencies :: evaluated', { confident: evaluated.confident, value: evaluated.value });
            if (evaluated.confident && evaluated.value !== undefined) {
              requires.add(evaluated.value);
            }
          }
        }
      },
    },
  };
}
