// simulate '@babel/template' using what's in '@babel/standalone'
import { template as _template } from './_standalone';

const template = _template.default;
export default template;
export const { expression, program, smart, statement, statements } = _template;
