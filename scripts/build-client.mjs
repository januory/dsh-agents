import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { name: id } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

const CLASS_PREFIX = 'dag-'

// The Web client keys its module table by the installed package name and
// resolves only the platform seed words (react) through the factory's require.
async function compileCssModule(file) {
  const source = await readFile(file, 'utf8')
  const fileName = file.split(/[\\/]/).pop()
  // Every module shares one stylesheet namespace, so identical local names
  // (.root, .row, .trigger…) must not collide across files.
  const scope = fileName.replace(/\.module\.css$/, '')
  const scoped = local => `${CLASS_PREFIX}${local}-${scope}`
  const names = new Set()
  const css = source.replace(/\.([A-Za-z][\w-]*)/g, (_match, local) => {
    names.add(local)
    return `.${scoped(local)}`
  })
  const map = Object.fromEntries([...names].map(local => [local, scoped(local)]))
  const tagId = `${id}/${fileName}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css="\' + tagId + \'"]\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(map)};`,
  ].join('\n')
}

await build({
  entryPoints: [resolve(root, 'src/client/index.js')],
  outfile: resolve(root, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store'],
  sourcemap: true,
  logLevel: 'info',
  plugins: [{
    name: 'dsh-agents-css-modules',
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: /\.module\.css$/ }, async args => ({
        contents: await compileCssModule(args.path),
        loader: 'js',
      }))
    },
  }],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})
