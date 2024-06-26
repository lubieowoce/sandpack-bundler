import postcss, { AcceptedPlugin, ProcessOptions } from 'postcss';

import { extractModuleSpecifierParts, isModuleSpecifier } from '../../../resolver/utils/module-specifier';
import { join as joinPaths } from '../../../utils/path';
import { ITranspilationContext, ITranspilationResult } from '../Transformer';
import postcssImportPlugin from './import-loader/index';

async function resolveCSSFile(ctx: ITranspilationContext, path: string, basePath: string): Promise<string> {
  const isDependency = isModuleSpecifier(path);

  if (isDependency) {
    const parts = extractModuleSpecifierParts(path);
    if (!parts.filepath.length) {
      // First try to resolve the package.json, in case it has a style field
      try {
        const pkgJsonPath = await ctx.module.bundler.resolveAsync(joinPaths(path, 'package.json'), basePath, {
          extensions: [],
        });
        const content = await ctx.module.bundler.fs.readFileAsync(pkgJsonPath);
        const parsedPkg = JSON.parse(content);

        if (parsedPkg.style) {
          path = joinPaths(path, parsedPkg.style);
        }
      } catch (e) {
        /* Move to step 2 */
      }
    }
  }
  return ctx.module.bundler.resolveAsync(path, basePath, { extensions: ['.css'], subgraphId: ctx.module.subgraphId });
}

export default async function (ctx: ITranspilationContext): Promise<ITranspilationResult> {
  const dependencies = new Set<string>();
  const plugins: AcceptedPlugin[] = [];
  const options: ProcessOptions = {
    to: ctx.module.filepath,
    from: ctx.module.filepath,
    map: false,
  };

  // Explicitly give undefined if code is null, otherwise postcss crashes
  const result = await postcss([
    ...plugins,
    postcssImportPlugin({
      resolve: (id: string, root: string) => resolveCSSFile(ctx, id, root),
      load: (filename: string) => {
        dependencies.add(filename);
        return ctx.module.bundler.fs.readFileAsync(filename);
      },
      plugins,
    }),
  ]).process(ctx.code, options);
  if (result.messages) {
    const messages = result.messages as any[];
    await Promise.all(
      messages.map(async (m) => {
        if (m.type === 'dependency') {
          dependencies.add(m.file);
        }
      })
    );
  }

  // TODO: Handle url(...) references
  const transpiledCode = result.css;

  return { code: transpiledCode, dependencies };
}
