const path = require('path')
const { spawn } = require('child_process')
const { loadEnv } = require('./load-env.cjs')

const root = path.join(__dirname, '..')
loadEnv(root)

if (!process.env.DIRECT_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL
}

const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js')
const child = spawn(process.execPath, [prismaCli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  cwd: root,
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
