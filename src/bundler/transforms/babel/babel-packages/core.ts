// simulate '@babel/core' using what's in '@babel/standalone'
import template from './template';
import traverse from './traverse';
import * as types from './types';

export * from '@babel/standalone';
export { template, traverse, types };
