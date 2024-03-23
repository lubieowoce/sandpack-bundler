// simulate '@babel/parser' using what's in '@babel/standalone'
import { parser as _parser } from './_standalone';

export const { parse, parseExpression, tokTypes } = _parser;
