import {createApp} from './app';

const app = await createApp();
app.server.listen(app.config.port, () => {
  console.log(JSON.stringify({msg: 'saleads-sim listo (simulado)', port: app.config.port, issuer: app.config.issuer, mcp: app.config.mcpUrl}));
});

const stop = () => {
  app.store.flush();
  app.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
