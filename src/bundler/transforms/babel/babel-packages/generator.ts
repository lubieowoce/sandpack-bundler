// simulate '@babel/generator' using what's in '@babel/standalone'
import { generator as _generator } from './_standalone';

const generator = _generator.default;
export default generator;
export const { CodeGenerator } = _generator;
