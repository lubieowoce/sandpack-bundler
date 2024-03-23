import * as _standalone from '@babel/standalone';

// the type definitions don't include these:
// https://babel.dev/docs/babel-standalone#internal-packages
type RealBabelStandalone = typeof _standalone & {
  packages: {
    generator: typeof import('@babel/generator');
    parser: typeof import('@babel/parser');
    traverse: typeof import('@babel/traverse');
    template: typeof import('@babel/template');
    types: typeof import('@babel/types');
  };
};

export const { generator, parser, template, traverse, types } = (_standalone as RealBabelStandalone).packages;
