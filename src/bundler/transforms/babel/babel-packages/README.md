This directory exists to provide alias targets for

```
@babel/core
@babel/generator
@babel/parser
@babel/template
@babel/traverse
@babel/types
```

using what's bundled in `@babel/standalone` (See: https://babel.dev/docs/babel-standalone#internal-packages)

We inject these using `package.json#alias` (See https://en.parceljs.org/module_resolution.html#aliases), which will make parcel redirect imports of these modules to our replacements.
This allows us to reduce bundle size -- we're already including `@babel/standalone`, so we'd like to avoid a dependency pulling in a whole other copy of babel.
