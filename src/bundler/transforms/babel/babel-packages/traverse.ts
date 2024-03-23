// simulate '@babel/traverse' using what's in '@babel/standalone'
import { traverse as _traverse } from './_standalone';

const traverse = _traverse.default;
export default traverse;
export const { Binding, Hub, NodePath, Scope, cache, visitors } = _traverse;
