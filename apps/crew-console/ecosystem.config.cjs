// pm2 for ~/.pi/apps — standalone processes that read pi's state. `pm2 start ~/.pi/apps/crew-console/ecosystem.config.cjs`
module.exports = {
  apps: [{
    name: "crew_console",
    cwd: __dirname,
    script: "src/server.ts",
    interpreter: "node",
    env: { CREW_CONSOLE_PORT: "9900", NODE_NO_WARNINGS: "1" },
    autorestart: true, max_restarts: 10, restart_delay: 2000,
    out_file: `${process.env.HOME}/.pi/agent/state/crew-console.log`, error_file: `${process.env.HOME}/.pi/agent/state/crew-console.log`, merge_logs: true,
  }],
};
