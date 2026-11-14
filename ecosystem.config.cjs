module.exports = {
  apps: [
    {
      name: "dash-bot",
      script: "bot.js",
      interpreter: "node",
    },
    {
      name: "dash-tailscale",
      script: "scripts/tailscale-serve.sh",
      interpreter: "bash",
    },
  ],
};
