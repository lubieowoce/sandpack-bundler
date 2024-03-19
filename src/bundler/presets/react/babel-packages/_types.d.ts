import * as standalone from '@babel/standalone';

export type RealBabelStandalone = typeof standalone & {
  packages: {
    generator: typeof import('@babel/generator');
    parser: typeof import('@babel/parser');
    traverse: typeof import('@babel/traverse');
    template: typeof import('@babel/template');
    types: typeof import('@babel/types');
  };
};
