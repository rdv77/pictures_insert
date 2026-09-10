import { spawn } from 'node:child_process';
const child=spawn(process.execPath,['node_modules/vinext/dist/cli.js',process.argv[2]||'build',...process.argv.slice(3)],{stdio:'inherit',env:{...process.env,SITE_TARGET:'sites'}});
child.on('exit',code=>process.exit(code??1));
