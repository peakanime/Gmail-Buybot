module.exports = {
  apps: [{
    name: "velrix-account-platform",
    script: "./src/server.js",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: "production"
    }
  }]
};