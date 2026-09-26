import { runBrowser } from './session.ts';

const [session, command, ...args] = process.argv.slice(2);
let identity;
const flag = args.indexOf('--identity');
if (flag !== -1) identity = args.splice(flag, 2)[1];
try {
  if (flag !== -1 && !identity) throw new Error('--identity requires a registered profile name');
  console.log(await runBrowser({ session, command, args, identity }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
